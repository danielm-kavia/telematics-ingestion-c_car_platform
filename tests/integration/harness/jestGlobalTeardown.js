"use strict";

const { stopServicesForIntegrationTests } = require("./serviceHarness");

/**
 * PUBLIC_INTERFACE
 * Jest globalTeardown for the integration test suite.
 *
 * Ensures clean shutdown by killing child processes started in globalSetup.
 *
 * @returns {Promise<void>}
 */
module.exports = async function globalTeardown() {
  await stopServicesForIntegrationTests();
};
