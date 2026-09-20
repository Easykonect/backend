#!/usr/bin/env node
/**
 * EasyKonnect Custom Server
 * 
 * This is the entry point for running EasyKonnect with WebSocket support.
 * Use this instead of `next start` for production deployment.
 * 
 * Usage:
 *   Development: npx ts-node server.ts
 *   Production: node dist/server.js
 */

// Set up Next.js's runtime globals (AsyncLocalStorage and friends) before any
// Next module loads. `next start` does this itself; a custom server doesn't,
// and without it requests fail with "AsyncLocalStorage accessed in runtime
// where it is not available".
// eslint-disable-next-line @typescript-eslint/no-require-imports
require('next/dist/server/node-environment');

// Load environment variables first. Must stay a `require` so it runs before
// the server module below is resolved.
// eslint-disable-next-line @typescript-eslint/no-require-imports
require('dotenv').config();

// The compiled server keeps tsconfig's `@/…` import paths, which Node can't
// resolve by itself. Map them to the src folder next to this file (dist/src
// when built, src when run from the repository).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Module = require('module');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require('path');
const resolveFilename = Module._resolveFilename;
Module._resolveFilename = function (this: unknown, request: string, ...rest: unknown[]) {
  const mapped = request.startsWith('@/') ? path.join(__dirname, 'src', request.slice(2)) : request;
  return resolveFilename.call(this, mapped, ...rest);
};

// Import and start the server
import('./src/lib/server').then((module) => {
  module.startServer().catch((error) => {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  });
});

// Keeps this file a module. Without it the consts above are globals, and the
// declarations emitted into dist/ collide with this file on the next
// type-check ("Cannot redeclare block-scoped variable 'Module'").
export {};
