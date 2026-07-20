import type { Config } from "@jest/types";

const config: Config.InitialOptions = {
  moduleFileExtensions: ["js", "json", "ts"],
  testRegex: ".*\\.spec\\.ts$",
  transform: {
    "^.+\\.ts$": [
      "ts-jest",
      {
        useESM: true,
        tsconfig: "tsconfig.json",
        diagnostics: false,
      },
    ],
    "^.+\\.js$": [
      "ts-jest",
      {
        useESM: true,
        diagnostics: false,
      },
    ],
  },
  extensionsToTreatAsEsm: [".ts"],
  transformIgnorePatterns: ["node_modules/(?!(chalk|#ansi-styles|ansi-styles)/)"],
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  globalSetup: "<rootDir>/test/global-setup.ts",
  globalTeardown: "<rootDir>/test/global-teardown.ts",
  setupFiles: ["<rootDir>/test/setup-env.ts"],
  collectCoverage: true,
  coverageDirectory: "coverage",
  // Stable denominator: measure ALL source, not just files specs happen to
  // import. (Until 2026-06-07 the denominator silently depended on spec
  // imports — doc-drift.spec.ts importing build-program.ts grew it by 1,450
  // statements overnight and "dropped" coverage from 70% to 50%.)
  collectCoverageFrom: ["src/**/*.ts", "!src/**/*.spec.ts"],
  coveragePathIgnorePatterns: ["node_modules", "dist", "test"],
  coverageReporters: ["lcov", "html", "text-summary"],
  coverageThreshold: {
    global: {
      statements: 70,
      branches: 50,
      functions: 70,
      lines: 70,
    },
  },
  testEnvironment: "node",
  clearMocks: true,
};

export default config;
