"use strict";

/**
 * PUBLIC_INTERFACE
 * Load configuration from environment variables.
 * No secrets are hard-coded; everything comes from process.env.
 *
 * @returns {{
 *  serviceName: string,
 *  port: number,
 *  logLevel: "debug"|"info"|"warn"|"error",
 *  ingestAuthToken: string|undefined,
 *  kafka: {
 *    enabled: boolean,
 *    brokers: string[],
 *    topicTelematics: string,
 *    consumerGroupId: string,
 *    clientId: string
 *  },
 *  timescale: {
 *    enabled: boolean,
 *    connectionString: string|undefined,
 *    schema: string,
 *    table: string
 *  }
 * }}
 */
function loadConfig() {
  const serviceName = process.env.SERVICE_NAME || "telematics-ingestion";
  const port = Number(process.env.PORT || 3002);
  const logLevel = /** @type {any} */ (process.env.LOG_LEVEL || "info");

  // Optional simple shared-secret for MVP local dev; can be replaced by JWT validation later.
  const ingestAuthToken = process.env.INGEST_AUTH_TOKEN || undefined;

  const kafkaEnabled = String(process.env.KAFKA_ENABLED || "false").toLowerCase() === "true";
  const brokers = String(process.env.KAFKA_BROKERS || "localhost:9092")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const topicTelematics = process.env.KAFKA_TOPIC_TELEMATICS || "telematics.v1";
  const consumerGroupId = process.env.KAFKA_CONSUMER_GROUP_ID || "telematics-ingestion-v1";
  const clientId = process.env.KAFKA_CLIENT_ID || "telematics-ingestion";

  const timescaleEnabled = String(process.env.TIMESCALE_ENABLED || "false").toLowerCase() === "true";
  const connectionString = process.env.TIMESCALE_DATABASE_URL || process.env.DATABASE_URL || undefined;
  const schema = process.env.TIMESCALE_SCHEMA || "public";
  const table = process.env.TIMESCALE_TABLE || "telematics_readings";

  return {
    serviceName,
    port,
    logLevel,
    ingestAuthToken,
    kafka: {
      enabled: kafkaEnabled,
      brokers,
      topicTelematics,
      consumerGroupId,
      clientId,
    },
    timescale: {
      enabled: timescaleEnabled,
      connectionString,
      schema,
      table,
    },
  };
}

module.exports = { loadConfig };
