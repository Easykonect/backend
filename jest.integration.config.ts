import type { Config } from 'jest';

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/src/__tests__/integration/**/*.test.ts'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
  },
  // Same ES-module handling as jest.config.ts
  transform: {
    '^.+\\.[tj]sx?$': ['ts-jest', {
      tsconfig: {
        module: 'CommonJS',
        moduleResolution: 'node',
        esModuleInterop: true,
        allowJs: true,
      },
    }],
  },
  transformIgnorePatterns: [
    '/node_modules/(?!(sanitize-html/node_modules/)?(htmlparser2|domhandler|domutils|dom-serializer|domelementtype|entities)/)',
  ],
  setupFiles: ['<rootDir>/src/__tests__/setup.ts'],
  testTimeout: 30000, // 30s for live service calls
  forceExit: true,    // Don't hang on open Redis handles
  verbose: true,
};

export default config;
