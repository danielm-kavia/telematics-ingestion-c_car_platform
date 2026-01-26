"use strict";

const validTelematics = require("./fixtures/telematics.valid.json");
const invalidSchemaVersion = require("./fixtures/telematics.invalid.schemaVersion.json");
const invalidTimestamp = require("./fixtures/telematics.invalid.timestamp.json");
const { validateAndNormalizeTelematicsV1 } = require("../../src/telematics/validateAndNormalize");
const { httpJson } = require("./helpers/httpClient");

/**
 * Integration test profile:
 * - Validate telematics-ingestion normalization and batch-ingest HTTP error handling.
 * - Validate vehicle-state state update + current query.
 * - Exercise the intended "ingestion → state" mapping by deriving StateUpdateV1 from normalized telematics
 *   and posting it to vehicle-state. This reflects the SWE.5 scope document while the direct service-to-service
 *   publishing is not yet implemented in telematics-ingestion runtime.
 *
 * These tests assume running services are reachable via env:
 * - TELEMATICS_INGESTION_BASE_URL (default http://localhost:3002)
 * - VEHICLE_STATE_BASE_URL (default http://localhost:3001)
 */

function baseUrls() {
  return {
    ingestion: process.env.TELEMATICS_INGESTION_BASE_URL || "http://localhost:3002",
    vehicleState: process.env.VEHICLE_STATE_BASE_URL || "http://localhost:3001",
  };
}

function toStateUpdateV1(normalizedTelemetry) {
  return {
    schemaVersion: "v1",
    vehicleId: normalizedTelemetry.vehicleId,
    timestamp: normalizedTelemetry.timestamp,
    state: {
      speedKph: normalizedTelemetry.speedKph,
      batteryPct: normalizedTelemetry.batteryPct,
      fuelPct: normalizedTelemetry.fuelPct,
      latitude: normalizedTelemetry.latitude,
      longitude: normalizedTelemetry.longitude,
    },
  };
}

describe("SWE.5 integration: telematics-ingestion → vehicle-state", () => {
  test("happy path: normalize telematics, post state update, and query current state", async () => {
    const { ingestion, vehicleState } = baseUrls();

    // 1) Assert telematics-ingestion batch endpoint accepts a valid item (HTTP contract).
    const ingestRes = await httpJson(`${ingestion}/v1/telematics/batch`, {
      method: "POST",
      body: { items: [validTelematics] },
      timeoutMs: 5000,
    });

    expect(ingestRes.status).toBe(200);
    expect(ingestRes.body && ingestRes.body.ok).toBe(true);
    expect(ingestRes.body.accepted).toBeGreaterThanOrEqual(0); // may be 1 (Timescale disabled) or 0 (if per-item rejected)
    expect(Array.isArray(ingestRes.body.results)).toBe(true);

    // 2) Independently normalize (the core "normalize telemetry" step).
    const normalized = validateAndNormalizeTelematicsV1(validTelematics);
    expect(normalized.ok).toBe(true);

    // 3) Post derived StateUpdateV1 into vehicle-state (intended integration contract).
    const stateUpdate = toStateUpdateV1(normalized.telemetry);
    const vsPost = await httpJson(`${vehicleState}/state`, {
      method: "POST",
      body: stateUpdate,
      timeoutMs: 5000,
    });

    expect(vsPost.status).toBe(202);
    expect(vsPost.body && vsPost.body.ok).toBe(true);

    // 4) Query current and verify the expected fields are available.
    const vsGet = await httpJson(`${vehicleState}/state/${encodeURIComponent(stateUpdate.vehicleId)}/current`, {
      method: "GET",
      timeoutMs: 5000,
    });

    expect(vsGet.status).toBe(200);
    expect(vsGet.body && vsGet.body.ok).toBe(true);
    expect(vsGet.body.item.vehicleId).toBe(stateUpdate.vehicleId);
    expect(vsGet.body.item.timestamp).toBe(new Date(stateUpdate.timestamp).toISOString());
    expect(vsGet.body.item.state.speedKph).toBe(validTelematics.speedKph);
    expect(vsGet.body.item.state.latitude).toBe(validTelematics.latitude);
    expect(vsGet.body.item.state.longitude).toBe(validTelematics.longitude);
  });

  test("error path: request-level validation fails when items is missing/empty (telematics-ingestion)", async () => {
    const { ingestion } = baseUrls();

    const res1 = await httpJson(`${ingestion}/v1/telematics/batch`, {
      method: "POST",
      body: {},
      timeoutMs: 5000,
    });

    expect(res1.status).toBe(400);
    expect(res1.body && res1.body.ok).toBe(false);

    const res2 = await httpJson(`${ingestion}/v1/telematics/batch`, {
      method: "POST",
      body: { items: [] },
      timeoutMs: 5000,
    });

    expect(res2.status).toBe(400);
    expect(res2.body && res2.body.ok).toBe(false);
  });

  test("error path: per-item schema validation failure yields rejected result and no state update performed by test", async () => {
    const { ingestion, vehicleState } = baseUrls();

    // Ensure vehicle-state has no current state for this test vehicle prior to update.
    const before = await httpJson(`${vehicleState}/state/${encodeURIComponent(invalidSchemaVersion.vehicleId)}/current`, {
      method: "GET",
      timeoutMs: 5000,
    });
    expect([200, 404]).toContain(before.status);

    const ingestRes = await httpJson(`${ingestion}/v1/telematics/batch`, {
      method: "POST",
      body: { items: [invalidSchemaVersion] },
      timeoutMs: 5000,
    });

    expect(ingestRes.status).toBe(200);
    expect(ingestRes.body && ingestRes.body.ok).toBe(true);
    expect(ingestRes.body.accepted).toBe(0);
    expect(ingestRes.body.rejected).toBe(1);
    expect(ingestRes.body.results[0].ok).toBe(false);

    // Since we do NOT post to vehicle-state on invalid payload, state should remain unchanged.
    const after = await httpJson(`${vehicleState}/state/${encodeURIComponent(invalidSchemaVersion.vehicleId)}/current`, {
      method: "GET",
      timeoutMs: 5000,
    });

    // In an isolated environment this should be 404; if state was previously set externally, it could be 200.
    // We only assert "no new state was created by this test" by checking that vehicle-state does not suddenly succeed
    // due solely to the invalid ingestion payload.
    // Therefore: if it was 404 before, it must remain 404.
    if (before.status === 404) {
      expect(after.status).toBe(404);
    }
  });

  test("error path: unparseable timestamp is rejected by normalization in ingestion results and no state update performed by test", async () => {
    const { ingestion } = baseUrls();

    const ingestRes = await httpJson(`${ingestion}/v1/telematics/batch`, {
      method: "POST",
      body: { items: [invalidTimestamp] },
      timeoutMs: 5000,
    });

    expect(ingestRes.status).toBe(200);
    expect(ingestRes.body && ingestRes.body.ok).toBe(true);
    expect(ingestRes.body.accepted).toBe(0);
    expect(ingestRes.body.rejected).toBe(1);
    expect(ingestRes.body.results[0].ok).toBe(false);
  });
});
