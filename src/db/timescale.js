"use strict";

const { Client } = require("pg");

/**
 * NOTE: We intentionally do not connect on import.
 * This module provides a small wrapper that can be started/stopped by the server and worker loops.
 */

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {any} logger
 * @param {{ connectionString: string, schema: string, table: string }} options
 */
async function ensureSchemaAndTables(logger, options) {
  // Create schema if needed
  await options.client.query(`CREATE SCHEMA IF NOT EXISTS "${options.schema}";`);

  // Core table: minimal time-series shape for Phase 3 MVP.
  await options.client.query(
    `CREATE TABLE IF NOT EXISTS "${options.schema}"."${options.table}" (
      time TIMESTAMPTZ NOT NULL,
      device_id TEXT NOT NULL,
      vehicle_id TEXT NOT NULL,
      speed_kph DOUBLE PRECISION NULL,
      latitude DOUBLE PRECISION NULL,
      longitude DOUBLE PRECISION NULL,
      battery_pct DOUBLE PRECISION NULL,
      fuel_pct DOUBLE PRECISION NULL,
      raw JSONB NULL
    );`
  );

  // Helpful index for lookups; hypertables also benefit from this.
  await options.client.query(
    `CREATE INDEX IF NOT EXISTS "${options.table}_device_time_idx"
     ON "${options.schema}"."${options.table}" (device_id, time DESC);`
  );

  // Convert to hypertable if TimescaleDB extension is present.
  // This is safe to attempt: if extension isn't installed, we log and continue.
  try {
    await options.client.query(`CREATE EXTENSION IF NOT EXISTS timescaledb;`);
    await options.client.query(
      `SELECT create_hypertable('"${options.schema}"."${options.table}"', 'time', if_not_exists => TRUE);`
    );
  } catch (e) {
    logger.warn("TimescaleDB extension/hypertable creation skipped (extension may be unavailable)", {
      error: String(e && e.message ? e.message : e),
    });
  }
}

/**
 * PUBLIC_INTERFACE
 * Create a TimescaleDB client wrapper.
 *
 * @param {any} logger
 * @param {{ connectionString?: string, schema: string, table: string, enabled: boolean }} cfg
 * @returns {{
 *  start: () => Promise<void>,
 *  stop: () => Promise<void>,
 *  insertTelemetry: (row: {
 *    time: string,
 *    deviceId: string,
 *    vehicleId: string,
 *    speedKph?: number,
 *    latitude?: number,
 *    longitude?: number,
 *    batteryPct?: number,
 *    fuelPct?: number,
 *    raw?: any
 *  }) => Promise<void>,
 *  isReady: () => boolean
 * }}
 */
function createTimescaleClient(logger, cfg) {
  /** @type {import("pg").Client | undefined} */
  let client;
  let ready = false;

  async function start() {
    if (!cfg.enabled) {
      logger.info("TimescaleDB disabled via config; persistence is OFF");
      ready = false;
      return;
    }
    if (!cfg.connectionString) {
      logger.warn("TimescaleDB enabled but no connection string provided; persistence is OFF");
      ready = false;
      return;
    }
    if (client) return;

    client = new Client({ connectionString: cfg.connectionString });

    // Connect + bootstrap. If it fails, do not crash the process; allow retry loops to handle it.
    try {
      await client.connect();
      await ensureSchemaAndTables(logger, { client, schema: cfg.schema, table: cfg.table });
      ready = true;
      logger.info("TimescaleDB connected and schema ensured", { schema: cfg.schema, table: cfg.table });
    } catch (e) {
      ready = false;
      logger.error("TimescaleDB connection/bootstrap failed", { error: String(e && e.message ? e.message : e) });
      try {
        await client.end();
      } catch (_) {}
      client = undefined;
      // Propagate so caller can backoff/retry if desired.
      throw e;
    }
  }

  async function stop() {
    ready = false;
    if (!client) return;
    const c = client;
    client = undefined;
    try {
      await c.end();
    } catch (e) {
      logger.warn("TimescaleDB close failed", { error: String(e && e.message ? e.message : e) });
    }
  }

  async function insertTelemetry(row) {
    if (!cfg.enabled) return;
    if (!client || !ready) throw new Error("TimescaleDB not ready");
    await client.query(
      `INSERT INTO "${cfg.schema}"."${cfg.table}"
        (time, device_id, vehicle_id, speed_kph, latitude, longitude, battery_pct, fuel_pct, raw)
       VALUES
        ($1, $2, $3, $4, $5, $6, $7, $8, $9);`,
      [
        row.time,
        row.deviceId,
        row.vehicleId,
        row.speedKph ?? null,
        row.latitude ?? null,
        row.longitude ?? null,
        row.batteryPct ?? null,
        row.fuelPct ?? null,
        row.raw ? JSON.stringify(row.raw) : null,
      ]
    );
  }

  function isReady() {
    return ready;
  }

  return { start, stop, insertTelemetry, isReady };
}

/**
 * PUBLIC_INTERFACE
 * Background retry loop helper for dependencies (Kafka, Timescale).
 * Keeps trying `fn()` with backoff, never throwing to crash the process.
 *
 * @param {any} logger
 * @param {{
 *   name: string,
 *   minDelayMs?: number,
 *   maxDelayMs?: number
 * }} options
 * @param {() => Promise<void>} fn
 * @returns {{ stop: () => void }}
 */
function startRetryLoop(logger, options, fn) {
  const minDelayMs = Math.max(250, Number(options.minDelayMs ?? 1000));
  const maxDelayMs = Math.max(minDelayMs, Number(options.maxDelayMs ?? 30000));

  let stopped = false;
  let delay = minDelayMs;

  (async () => {
    while (!stopped) {
      try {
        await fn();
        // Once successful, reset delay and wait a bit before checking again.
        delay = minDelayMs;
        await sleep(5000);
      } catch (e) {
        logger.warn(`${options.name} not ready; will retry`, {
          error: String(e && e.message ? e.message : e),
          delayMs: delay,
        });
        await sleep(delay);
        delay = Math.min(maxDelayMs, Math.floor(delay * 1.6));
      }
    }
  })().catch((e) => {
    logger.error("Retry loop crashed (unexpected)", { name: options.name, error: String(e && e.message ? e.message : e) });
  });

  return { stop: () => { stopped = true; } };
}

module.exports = { createTimescaleClient, startRetryLoop };
