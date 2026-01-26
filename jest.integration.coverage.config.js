"use strict";

/** @type {import("jest").Config} */
module.exports = {
  displayName: "integration",
  testEnvironment: "node",
  roots: ["<rootDir>/tests/integration"],
  testMatch: ["**/*.spec.js"],
  testTimeout: 30000,
  collectCoverage: true,

  // Start/stop required services for the integration suite only.
  // Coverage runs need this as well; otherwise tests will attempt to call services
  // that were never started (leading to ECONNREFUSED).
  globalSetup: "<rootDir>/tests/integration/harness/jestGlobalSetup.js",
  globalTeardown: "<rootDir>/tests/integration/harness/jestGlobalTeardown.js",

  // Coverage artifacts
  coverageDirectory: "<rootDir>/coverage-integration",
  coverageReporters: ["lcov", "html", "text-summary"],

  // Test result artifacts
  reporters: [
    "default",
    [
      "jest-junit",
      {
        outputDirectory: "<rootDir>/tests/integration/junit",
        outputName: "junit.xml",
        addFileAttribute: "true",
        suiteName: "@connected-car/telematics-ingestion integration (coverage)",
      },
    ],
  ],
};
