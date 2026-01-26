"use strict";

/** @type {import("jest").Config} */
module.exports = {
  displayName: "integration",
  testEnvironment: "node",
  roots: ["<rootDir>/tests/integration"],
  testMatch: ["**/*.spec.js"],
  testTimeout: 30000,
  collectCoverage: false,

  // Start/stop required services for the integration suite only.
  globalSetup: "<rootDir>/tests/integration/harness/jestGlobalSetup.js",
  globalTeardown: "<rootDir>/tests/integration/harness/jestGlobalTeardown.js",

  reporters: [
    "default",
    [
      "jest-junit",
      {
        outputDirectory: "<rootDir>/tests/integration/junit",
        outputName: "junit.xml",
        addFileAttribute: "true",
        suiteName: "@connected-car/telematics-ingestion integration",
      },
    ],
  ],
};
