"use strict";

const express = require("express");
const {
  createLogger,
  withCorrelationId,
  getCorrelationId,
  extractBearerToken,
  createSecurityHeadersMiddleware,
  createRateLimitMiddleware,
} = require("@connected-car/shared");
const { loadConfig } = require("./config");
const { createTimescaleClient, startRetryLoop } = require("./db/timescale");
const { validateAndNormalizeTelematicsV1 } = require("./telematics/validateAndNormalize");
const { createTelematicsKafkaConsumer } = require("./kafka/consumer");

const cfg = loadConfig();
const logger = createLogger({ serviceName: cfg.serviceName, level: cfg.logLevel });

const timescale = createTimescaleClient(logger, cfg.timescale);
const kafkaConsumer = createTelematicsKafkaConsumer(logger, cfg.kafka, timescale);

const app = express();

// Hardening (Phase 9): security headers + optional rate limiting (disabled by default).
app.use(
  createSecurityHeadersMiddleware({
    serviceName: cfg.serviceName,
    enabled: true,
    enableCsp: String(process.env.SECURITY_ENABLE_CSP || "false").toLowerCase() === "true",
    csp: process.env.SECURITY_CSP || undefined,
    enableHsts: String(process.env.SECURITY_ENABLE_HSTS || "false").toLowerCase() === "true",
  })
);
app.use(
  createRateLimitMiddleware({
    enabled: String(process.env.RATE_LIMIT_ENABLED || "false").toLowerCase() === "true",
    windowSeconds: Number(process.env.RATE_LIMIT_WINDOW_S || 60),
    maxRequests: Number(process.env.RATE_LIMIT_MAX || 100),
    logger,
  })
);

app.use(express.json({ limit: "256kb" })); // keep payloads bounded

/**
 * Simple auth middleware (optional) to avoid unauthenticated ingestion in environments that want it.
 * If INGEST_AUTH_TOKEN is unset, auth is disabled.
 */
function requireIngestAuth(req, res, next) {
  if (!cfg.ingestAuthToken) return next();
  const token = extractBearerToken(req.headers.authorization);
  if (!token || token !== cfg.ingestAuthToken) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
  return next();
}

/**
 * PUBLIC_INTERFACE
 * Health endpoint. Reports whether DB/Kafka are configured and ready.
 */
app.get(
  "/health",
  withCorrelationId(logger, async (req, res) => {
    res.json({
      ok: true,
      service: cfg.serviceName,
      correlationId: getCorrelationId(),
      timescale: { enabled: cfg.timescale.enabled, ready: timescale.isReady() },
      kafka: { enabled: cfg.kafka.enabled, running: kafkaConsumer.isRunning() },
    });
  })
);

/**
 * PUBLIC_INTERFACE
 * Batch ingest endpoint (MVP).
 *
 * POST /v1/telematics/batch
 * Body:
 * {
 *   "items": [ TelemetryV1, ... ],
 *   "deviceId": "optional-device-id-applied-when-item-missing"
 * }
 *
 * Returns:
 * - 200 with per-item results (accepted/rejected)
 *
 * Notes:
 * - Validates each item with shared schema (shared-c_car_platform).
 * - Persists accepted items to TimescaleDB when enabled.
 */
app.post(
  "/v1/telematics/batch",
  withCorrelationId(logger, async (req, res) => {
    return requireIngestAuth(req, res, async () => {
      const body = req.body && typeof req.body === "object" ? req.body : {};
      const items = Array.isArray(body.items) ? body.items : [];
      const defaultDeviceId = typeof body.deviceId === "string" ? body.deviceId : undefined;

      if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ ok: false, error: "items must be a non-empty array" });
      }

      /** @type {Array<{ index: number, ok: boolean, errors?: any[] }>} */
      const results = [];
      let accepted = 0;

      for (let i = 0; i < items.length; i++) {
        const payload = items[i];

        const normalized = validateAndNormalizeTelematicsV1(payload);
        if (!normalized.ok) {
          results.push({ index: i, ok: false, errors: normalized.errors });
          continue;
        }

        const telemetry = normalized.telemetry;
        const deviceId = String((payload && payload.deviceId) || defaultDeviceId || telemetry.vehicleId);

        try {
          if (cfg.timescale.enabled) {
            if (!timescale.isReady()) {
              // Do not fail the entire batch: mark as rejected with dependency message.
              results.push({
                index: i,
                ok: false,
                errors: [{ path: "$", message: "TimescaleDB not ready" }],
              });
              continue;
            }

            await timescale.insertTelemetry({
              time: telemetry.timestamp,
              deviceId,
              vehicleId: telemetry.vehicleId,
              speedKph: telemetry.speedKph,
              latitude: telemetry.latitude,
              longitude: telemetry.longitude,
              batteryPct: telemetry.batteryPct,
              fuelPct: telemetry.fuelPct,
              raw: payload,
            });
          }

          accepted++;
          results.push({ index: i, ok: true });
        } catch (e) {
          results.push({
            index: i,
            ok: false,
            errors: [{ path: "$", message: "DB insert failed" }],
          });
          logger.error("DB insert failed for batch item", {
            correlationId: getCorrelationId(),
            error: String(e && e.message ? e.message : e),
          });
        }
      }

      return res.status(200).json({ ok: true, accepted, rejected: items.length - accepted, results });
    });
  })
);

async function main() {
  // Start HTTP server first (so preview doesn't fail) and connect dependencies in background.
  app.listen(cfg.port, cfg.host || "0.0.0.0", () => {
    logger.info("Telematics ingestion HTTP server listening", { port: cfg.port });
  });

  // Retry Timescale connection in background if enabled.
  startRetryLoop(logger, { name: "timescale" }, async () => {
    if (!cfg.timescale.enabled) return;
    if (timescale.isReady()) return;
    await timescale.start();
  });

  // Retry Kafka consumer in background if enabled; it will only start once Timescale is ready.
  startRetryLoop(logger, { name: "kafka-consumer" }, async () => {
    if (!cfg.kafka.enabled) return;
    if (kafkaConsumer.isRunning()) return;
    if (!timescale.isReady()) throw new Error("waiting for timescale before starting kafka consumer");
    await kafkaConsumer.start();
  });

  // Best-effort shutdown
  process.on("SIGINT", async () => {
    logger.warn("SIGINT received; shutting down");
    try {
      await kafkaConsumer.stop();
    } catch (_) {}
    try {
      await timescale.stop();
    } catch (_) {}
    process.exit(0);
  });
  process.on("SIGTERM", async () => {
    logger.warn("SIGTERM received; shutting down");
    try {
      await kafkaConsumer.stop();
    } catch (_) {}
    try {
      await timescale.stop();
    } catch (_) {}
    process.exit(0);
  });
}

main().catch((e) => {
  logger.error("Fatal startup error", { error: String(e && e.message ? e.message : e) });
  // Do not exit aggressively; keep preview alive for debugging.
});
