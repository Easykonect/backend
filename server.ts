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

// Load environment variables first
require('dotenv').config();

// Import and start the server
import('./src/lib/server').then((module) => {
  module.startServer().catch((error) => {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  });
});
