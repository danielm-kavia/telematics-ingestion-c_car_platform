"use strict";

const { startServicesForIntegrationTests } = require("./serviceHarness");

/**
 * PUBLIC_INTERFACE
 * Jest globalSetup for the integration test suite.
 *
 * Starts vehicle-state and telematics-ingestion on dedicated test ports, waits for /health,
 * and sets process.env base URLs so tests target the correct services.
 *
 * @returns {Promise<void>}
 */
module.exports = async function globalSetup() {
  const { envForTests } = await startServicesForIntegrationTests();

  // Ensure the Jest worker process running tests sees these env vars.
  // Note: Jest runs globalSetup in a separate process from tests, but it passes
  // environment to test processes. Mutating process.env here is still useful for
  // any setup-time code paths.
  for (const [k, v] of Object.entries(envForTests)) {
    process.env[k] = v;
  }
};
