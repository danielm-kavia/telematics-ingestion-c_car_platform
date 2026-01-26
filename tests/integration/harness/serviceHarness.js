"use strict";

const path = require("path");
const fs = require("fs");
const os = require("os");
const { spawn } = require("child_process");
const { httpJson } = require("../helpers/httpClient");

/**
 * We start both services from the integration test container (telematics-ingestion),
 * but spawn them with explicit working directories pointing to each service.
 *
 * We persist child PIDs to a temp file so globalTeardown can reliably kill them
 * even though it runs in a separate Node process.
 */

const DEFAULT_TIMEOUT_MS = 20_000;
const POLL_INTERVAL_MS = 250;

/**
 * Resolve repository root from this file location:
 * telematics-ingestion-c_car_platform/tests/integration/harness/serviceHarness.js
 * -> repo root is 3 levels up from telematics-ingestion-c_car_platform
 */
function repoRootFromHere() {
  return path.resolve(__dirname, "../../../..");
}

function pidFilePath() {
  return path.join(os.tmpdir(), "connected-car-integration-harness-pids.json");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * PUBLIC_INTERFACE
 * Compute the environment variables used by the harness and integration tests.
 *
 * @returns {{
 *  VEHICLE_STATE_BASE_URL: string,
 *  TELEMATICS_INGESTION_BASE_URL: string,
 *  vehicleStatePort: number,
 *  telematicsIngestionPort: number
 * }}
 */
function buildHarnessEnv() {
  const vehicleStatePort = Number(process.env.VEHICLE_STATE_TEST_PORT || 3101);
  const telematicsIngestionPort = Number(process.env.TELEMATICS_INGESTION_TEST_PORT || 3102);

  return {
    VEHICLE_STATE_BASE_URL: `http://127.0.0.1:${vehicleStatePort}`,
    TELEMATICS_INGESTION_BASE_URL: `http://127.0.0.1:${telematicsIngestionPort}`,
    vehicleStatePort,
    telematicsIngestionPort,
  };
}

async function waitForHealthy(baseUrl, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;

  while (Date.now() < deadline) {
    try {
      const res = await httpJson(`${baseUrl}/health`, { method: "GET", timeoutMs: 1500 });
      if (res.status === 200) return;
      lastErr = new Error(`Non-200 health status: ${res.status}`);
    } catch (e) {
      lastErr = e;
    }
    await sleep(POLL_INTERVAL_MS);
  }

  const msg = lastErr ? String(lastErr && lastErr.message ? lastErr.message : lastErr) : "unknown error";
  throw new Error(`Service at ${baseUrl} did not become healthy within ${timeoutMs}ms (${msg})`);
}

function spawnService({ name, cwd, env, nodeArgs }) {
  const child = spawn(process.execPath, nodeArgs, {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Prefix logs so failures in CI are debuggable.
  child.stdout.on("data", (d) => process.stdout.write(`[${name}] ${String(d)}`));
  child.stderr.on("data", (d) => process.stderr.write(`[${name}] ${String(d)}`));

  child.on("exit", (code, signal) => {
    // If the service unexpectedly exits during test startup, this will show up in logs.
    // We don't throw here because globalSetup is async; readiness checks will fail anyway.
    process.stderr.write(`[${name}] exited (code=${code}, signal=${signal})\n`);
  });

  return child;
}

/**
 * PUBLIC_INTERFACE
 * Start vehicle-state + telematics-ingestion and wait until both are healthy.
 *
 * @returns {Promise<{ pids: number[], envForTests: Record<string,string> }>}
 */
async function startServicesForIntegrationTests() {
  const repoRoot = repoRootFromHere();

  const vsRoot = path.join(repoRoot, "vehicle-state-c_car_platform");
  const tiRoot = path.join(repoRoot, "telematics-ingestion-c_car_platform");

  const {
    VEHICLE_STATE_BASE_URL,
    TELEMATICS_INGESTION_BASE_URL,
    vehicleStatePort,
    telematicsIngestionPort,
  } = buildHarnessEnv();

  // Base environment: inherit, then override for test profile.
  // We intentionally disable optional external dependencies so tests remain self-contained.
  const baseEnv = {
    ...process.env,
    NODE_ENV: process.env.NODE_ENV || "test",

    // Integration test base URLs consumed by test HTTP client.
    VEHICLE_STATE_BASE_URL,
    TELEMATICS_INGESTION_BASE_URL,

    // Disable external deps (safe to set even if unused).
    TIMESCALE_ENABLED: "false",
    KAFKA_ENABLED: "false",
  };

  // Vehicle-state does not rely on external DB; keep WS off to reduce noise/ports.
  const vehicleStateEnv = {
    ...baseEnv,
    SERVICE_NAME: "vehicle-state-integration",
    HOST: "127.0.0.1",
    PORT: String(vehicleStatePort),
    WS_ENABLED: "false",
    DOCS_ENABLED: "false",
  };

  const telematicsIngestionEnv = {
    ...baseEnv,
    SERVICE_NAME: "telematics-ingestion-integration",
    HOST: "127.0.0.1",
    PORT: String(telematicsIngestionPort),
    // Ensure auth is off in tests unless explicitly enabled by CI env.
    INGEST_AUTH_TOKEN: "",
  };

  const vs = spawnService({
    name: "vehicle-state",
    cwd: vsRoot,
    env: vehicleStateEnv,
    nodeArgs: [path.join(vsRoot, "src", "server.js")],
  });

  const ti = spawnService({
    name: "telematics-ingestion",
    cwd: tiRoot,
    env: telematicsIngestionEnv,
    nodeArgs: [path.join(tiRoot, "src", "server.js")],
  });

  // Persist for teardown.
  fs.writeFileSync(
    pidFilePath(),
    JSON.stringify(
      {
        createdAt: new Date().toISOString(),
        pids: [vs.pid, ti.pid].filter(Boolean),
      },
      null,
      2
    ),
    "utf-8"
  );

  // Ensure readiness before running tests.
  await waitForHealthy(VEHICLE_STATE_BASE_URL, DEFAULT_TIMEOUT_MS);
  await waitForHealthy(TELEMATICS_INGESTION_BASE_URL, DEFAULT_TIMEOUT_MS);

  // Provide env to Jest test runtime via process.env mutations in globalSetup.
  const envForTests = {
    VEHICLE_STATE_BASE_URL,
    TELEMATICS_INGESTION_BASE_URL,
    TIMESCALE_ENABLED: "false",
    KAFKA_ENABLED: "false",
  };

  return { pids: [vs.pid, ti.pid].filter(Boolean), envForTests };
}

/**
 * PUBLIC_INTERFACE
 * Stop services started by startServicesForIntegrationTests() using persisted PIDs.
 *
 * @returns {Promise<void>}
 */
async function stopServicesForIntegrationTests() {
  if (!fs.existsSync(pidFilePath())) return;

  /** @type {{pids?: number[]}} */
  let data;
  try {
    data = JSON.parse(fs.readFileSync(pidFilePath(), "utf-8"));
  } catch (_) {
    data = {};
  }

  const pids = Array.isArray(data.pids) ? data.pids : [];

  // SIGTERM first (graceful), then SIGKILL as a last resort.
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch (_) {}
  }

  // Give processes time to exit.
  await sleep(750);

  for (const pid of pids) {
    try {
      process.kill(pid, 0); // check if still alive
      process.kill(pid, "SIGKILL");
    } catch (_) {
      // already gone or not permitted
    }
  }

  try {
    fs.unlinkSync(pidFilePath());
  } catch (_) {}
}

module.exports = {
  startServicesForIntegrationTests,
  stopServicesForIntegrationTests,
  buildHarnessEnv,
};
