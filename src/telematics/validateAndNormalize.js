"use strict";

const { validateAgainstSchema, schemas } = require("@connected-car/shared");

/**
 * PUBLIC_INTERFACE
 * Validate and normalize a telematics payload (v1) using shared schemas.
 *
 * - Accepts string timestamps; requires ISO-8601 compatible date.
 * - Returns a normalized object ready for persistence.
 *
 * @param {unknown} payload
 * @returns {{
 *  ok: true,
 *  telemetry: {
 *    schemaVersion: "v1",
 *    vehicleId: string,
 *    timestamp: string,
 *    speedKph?: number,
 *    latitude?: number,
 *    longitude?: number,
 *    batteryPct?: number,
 *    fuelPct?: number
 *  }
 * } | { ok: false, errors: any[] }}
 */
function validateAndNormalizeTelematicsV1(payload) {
  const result = validateAgainstSchema(schemas.telematics.v1, payload);
  if (!result.ok) return { ok: false, errors: result.errors };

  const t = /** @type {any} */ (payload);

  // Normalize timestamp to ISO string.
  const d = new Date(t.timestamp);
  if (!Number.isFinite(d.getTime())) {
    return { ok: false, errors: [{ path: "$.timestamp", message: "timestamp must be a valid date string" }] };
  }

  return {
    ok: true,
    telemetry: {
      schemaVersion: "v1",
      vehicleId: String(t.vehicleId),
      timestamp: d.toISOString(),
      speedKph: typeof t.speedKph === "number" ? t.speedKph : undefined,
      latitude: typeof t.latitude === "number" ? t.latitude : undefined,
      longitude: typeof t.longitude === "number" ? t.longitude : undefined,
      batteryPct: typeof t.batteryPct === "number" ? t.batteryPct : undefined,
      fuelPct: typeof t.fuelPct === "number" ? t.fuelPct : undefined,
    },
  };
}

module.exports = { validateAndNormalizeTelematicsV1 };
