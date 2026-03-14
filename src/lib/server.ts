/**
 * WebSocket Server Setup for Next.js
 * 
 * This file provides Socket.io integration with Next.js.
 * Since Next.js uses serverless functions, we need a custom approach
 * to maintain WebSocket connections.
 * 
 * For production deployment on platforms like Render or Railway,
 * you can use a separate Socket.io server or integrate with Next.js custom server.
 */

import { createServer } from 'http';
import { parse } from 'url';
import next from 'next';
import { initializeSocketServer } from './socket';
import { queueManager } from '@/queues';
import { initializeEmailWorker } from '@/queues/email.worker';
import { initializeNotificationWorker } from '@/queues/notification.worker';
import { initializeBackgroundWorker, scheduleRecurringJobs } from '@/queues/background.worker';
import { config } from '@/config';

const dev = !config.isProduction;
const hostname = config.hostname;
const port = config.port;

/**
 * Initialize the complete server with WebSockets and background workers
 */
export async function startServer(): Promise<void> {
  console.log('🚀 Starting EasyKonnect Server...');

  // Create Next.js app
  const app = next({ dev, hostname, port });
  const handle = app.getRequestHandler();

  await app.prepare();

  // Create HTTP server
  const httpServer = createServer((req, res) => {
    const parsedUrl = parse(req.url!, true);
    handle(req, res, parsedUrl);
  });

  // Initialize Socket.io
  try {
    await initializeSocketServer(httpServer);
    console.log('✅ WebSocket server initialized');
  } catch (error) {
    console.error('❌ Failed to initialize WebSocket server:', error);
  }

  // Initialize queue system
  try {
    await queueManager.initialize();
    
    // Initialize workers
    initializeEmailWorker();
    initializeNotificationWorker();
    initializeBackgroundWorker();
    
    // Schedule recurring jobs
    await scheduleRecurringJobs();
    
    console.log('✅ Queue system initialized');
  } catch (error) {
    console.error('❌ Failed to initialize queue system:', error);
    console.log('⚠️ Running without background job processing');
  }

  // Start server
  httpServer.listen(port, () => {
    console.log(`
╔════════════════════════════════════════════════════════╗
║                                                        ║
║   🎉 EasyKonnect Server Started Successfully!          ║
║                                                        ║
║   📍 HTTP Server:  http://${hostname}:${port}              ║
║   📍 GraphQL:      http://${hostname}:${port}/api/graphql  ║
║   📍 WebSocket:    ws://${hostname}:${port}                ║
║                                                        ║
║   📊 Mode: ${dev ? 'Development' : 'Production'}                              ║
║                                                        ║
╚════════════════════════════════════════════════════════╝
    `);
  });

  // Graceful shutdown
  const gracefulShutdown = async (signal: string) => {
    console.log(`\n⚠️ Received ${signal}. Shutting down gracefully...`);
    
    try {
      await queueManager.shutdown();
      httpServer.close(() => {
        console.log('✅ Server closed');
        process.exit(0);
      });
    } catch (error) {
      console.error('❌ Error during shutdown:', error);
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
}

// Export for custom server usage
export default startServer;
