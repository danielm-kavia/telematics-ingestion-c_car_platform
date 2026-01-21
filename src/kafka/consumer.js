"use strict";

const { Kafka } = require("kafkajs");
const { validateAndNormalizeTelematicsV1 } = require("../telematics/validateAndNormalize");

/**
 * PUBLIC_INTERFACE
 * Create a Kafka consumer for telematics.v1 payloads.
 *
 * @param {any} logger
 * @param {{
 *  enabled: boolean,
 *  brokers: string[],
 *  topicTelematics: string,
 *  consumerGroupId: string,
 *  clientId: string
 * }} kafkaCfg
 * @param {{
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
 * }} timescale
 * @returns {{
 *  start: () => Promise<void>,
 *  stop: () => Promise<void>,
 *  isRunning: () => boolean
 * }}
 */
function createTelematicsKafkaConsumer(logger, kafkaCfg, timescale) {
  let running = false;
  let kafka;
  let consumer;

  async function start() {
    if (!kafkaCfg.enabled) {
      logger.info("Kafka consumer disabled via config");
      running = false;
      return;
    }

    if (!timescale.isReady()) {
      throw new Error("TimescaleDB not ready (Kafka consumer waits for DB)");
    }

    if (running) return;

    kafka = new Kafka({
      clientId: kafkaCfg.clientId,
      brokers: kafkaCfg.brokers,
    });

    consumer = kafka.consumer({ groupId: kafkaCfg.consumerGroupId });

    await consumer.connect();
    await consumer.subscribe({ topic: kafkaCfg.topicTelematics, fromBeginning: false });

    await consumer.run({
      autoCommit: true,
      eachMessage: async ({ topic, partition, message }) => {
        const rawValue = message.value ? message.value.toString("utf8") : "";
        let payload;
        try {
          payload = JSON.parse(rawValue);
        } catch (e) {
          logger.warn("Kafka message JSON parse failed; skipping", {
            topic,
            partition,
            offset: message.offset,
          });
          return;
        }

        const normalized = validateAndNormalizeTelematicsV1(payload);
        if (!normalized.ok) {
          logger.warn("Kafka telematics payload failed schema validation; skipping", {
            topic,
            partition,
            offset: message.offset,
            errors: normalized.errors,
          });
          return;
        }

        const telemetry = normalized.telemetry;

        // In an MVP, we treat vehicleId as deviceId too unless gateway provides a distinct id.
        const deviceId = String(payload.deviceId || telemetry.vehicleId);

        try {
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
        } catch (e) {
          // Throwing from eachMessage typically triggers consumer retry; we also log details.
          logger.error("Timescale insert failed while consuming Kafka message", {
            topic,
            partition,
            offset: message.offset,
            error: String(e && e.message ? e.message : e),
          });
          throw e;
        }
      },
    });

    running = true;
    logger.info("Kafka consumer started", { topic: kafkaCfg.topicTelematics, groupId: kafkaCfg.consumerGroupId });
  }

  async function stop() {
    running = false;
    if (consumer) {
      try {
        await consumer.disconnect();
      } catch (e) {
        logger.warn("Kafka consumer disconnect failed", { error: String(e && e.message ? e.message : e) });
      }
    }
    consumer = undefined;
    kafka = undefined;
  }

  function isRunning() {
    return running;
  }

  return { start, stop, isRunning };
}

module.exports = { createTelematicsKafkaConsumer };
