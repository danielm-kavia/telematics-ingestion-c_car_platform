# telematics-ingestion-c_car_platform

Telematics ingestion service (Phase 3 MVP): accepts telematics payloads via **HTTP batch endpoint** and/or consumes from **Kafka**, validates with **shared-c_car_platform** schemas, and persists to **TimescaleDB**.

This implementation is designed to be **non-blocking on startup**:
- HTTP server starts even if Kafka/TimescaleDB are unavailable.
- Dependency connections run in background retry loops and log failures.

## What this service does (Phase 3)
- Validates Telematics V1 payloads using: `shared-c_car_platform/src/schemas/v1/telematics.v1.schema.json`
- Persists accepted telemetry to TimescaleDB table (default): `public.telematics_readings`
- Optional Kafka consumer for topic (default): `telematics.v1`

## API (MVP)

### Health
`GET /health`

Returns whether Kafka / Timescale are enabled and ready.

### Batch ingest
`POST /v1/telematics/batch`

Body:
```json
{
  "deviceId": "optional-default",
  "items": [
    {
      "schemaVersion": "v1",
      "vehicleId": "VIN123",
      "timestamp": "2026-01-21T00:00:00.000Z",
      "speedKph": 42.1,
      "latitude": 37.1,
      "longitude": -122.1
    }
  ]
}
```

Auth (optional):
- If `INGEST_AUTH_TOKEN` is set, send `Authorization: Bearer <token>`.

## Local development

### Environment
Copy and edit:
- `.env.example` -> `.env`

Recommended local defaults:
- `PORT=3002`
- `TIMESCALE_ENABLED=false` (turn on when you have a local DB)
- `KAFKA_ENABLED=false` (turn on when you have Kafka)

### Run
```bash
npm install
npm run dev
```

## TimescaleDB schema (MVP)
On successful DB connection the service ensures:

- `public.telematics_readings` exists with columns:
  - `time` (TIMESTAMPTZ, not null)
  - `device_id` (text, not null)
  - `vehicle_id` (text, not null)
  - `speed_kph`, `latitude`, `longitude`, `battery_pct`, `fuel_pct` (double precision, nullable)
  - `raw` (jsonb, nullable)

It also attempts to create the TimescaleDB extension and convert the table to a hypertable (best-effort).

## Kafka consumer (MVP)
If enabled, consumes `KAFKA_TOPIC_TELEMATICS` and expects each message value to be JSON matching TelematicsV1 schema.
- Invalid payloads are logged and skipped.
- Insert failures are logged; the consumer will retry as Kafka re-delivers.

## Relationship to other containers
Expected Phase 3 flow:
1. `vehicle-gateway-c_car_platform` publishes telematics to Kafka topic `telematics.v1` (or falls back to HTTP ingest)
2. `telematics-ingestion-c_car_platform` consumes + validates + persists to TimescaleDB
3. Future phases: publish derived “state updates” to `vehicle-state-c_car_platform`

> Note: Previews are managed externally; this repo does not start/stop dependent services automatically.
