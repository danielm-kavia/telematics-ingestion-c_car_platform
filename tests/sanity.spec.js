"use strict";

const { validateAndNormalizeTelematicsV1 } = require("../src/telematics/validateAndNormalize");

describe("telematics-ingestion baseline", () => {
  test("validateAndNormalizeTelematicsV1 normalizes timestamp to ISO string", () => {
    const payload = {
      schemaVersion: "v1",
      vehicleId: "VIN123",
      timestamp: "2026-01-21T00:00:00.000Z",
      speedKph: 10,
    };

    const result = validateAndNormalizeTelematicsV1(payload);

    expect(result.ok).toBe(true);
    expect(result.telemetry.vehicleId).toBe("VIN123");
    expect(result.telemetry.schemaVersion).toBe("v1");
    expect(result.telemetry.timestamp).toBe(new Date(payload.timestamp).toISOString());
  });

  test("validateAndNormalizeTelematicsV1 rejects invalid timestamp", () => {
    const payload = {
      schemaVersion: "v1",
      vehicleId: "VIN123",
      timestamp: "not-a-date",
    };

    const result = validateAndNormalizeTelematicsV1(payload);

    expect(result.ok).toBe(false);
    expect(Array.isArray(result.errors)).toBe(true);
  });
});
