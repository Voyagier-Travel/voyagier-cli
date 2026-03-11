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
  },
  extensionsToTreatAsEsm: [".ts"],
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  collectCoverage: true,
  coverageDirectory: "coverage",
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
