"use strict";

/** @type {import("jest").Config} */
module.exports = {
  displayName: "integration",
  testEnvironment: "node",
  roots: ["<rootDir>/tests/integration"],
  testMatch: ["**/*.spec.js"],
  testTimeout: 30000,
  collectCoverage: true,
  coverageDirectory: "<rootDir>/coverage-integration",
  coverageReporters: ["lcov", "html", "text-summary"],
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
