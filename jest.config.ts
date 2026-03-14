import type { Config } from 'jest';

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  testMatch: ['<rootDir>/src/**/__tests__/**/*.test.ts'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
  },
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      tsconfig: {
        module: 'CommonJS',
        moduleResolution: 'node',
        esModuleInterop: true,
      },
    }],
  },
  // Load .env before any test runs
  setupFiles: ['<rootDir>/src/__tests__/setup.ts'],
  // Default: run only unit tests (fast, no external deps)
  testPathIgnorePatterns: [
    '/node_modules/',
    '<rootDir>/src/__tests__/integration/',
  ],
  clearMocks: true,
  restoreMocks: true,
  testTimeout: 15000,
  collectCoverageFrom: [
    'src/lib/**/*.ts',
    'src/services/**/*.ts',
    'src/middleware/**/*.ts',
    'src/utils/**/*.ts',
    'src/constants/**/*.ts',
    'src/config/**/*.ts',
    '!src/**/*.d.ts',
  ],
  coverageReporters: ['text', 'lcov', 'html'],
  coverageDirectory: 'coverage',
};

export default config;
