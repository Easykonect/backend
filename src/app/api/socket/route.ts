/**
 * Socket information route
 *
 * Next.js API routes can't hold WebSocket connections. Socket.IO runs in the custom
 * server (server.ts → src/lib/server.ts), started with `npm run start:ws` (or
 * `npm run dev:ws` locally). Clients connect with socket.io-client to the Socket.IO
 * path `/socket.io/` on the same host as the API. This route only describes that.
 */

import { NextRequest, NextResponse } from 'next/server';

// Information endpoint
export async function GET() {
  return NextResponse.json({
    status: 'ok',
    message: 'WebSocket server is available',
    info: {
      connection: 'Use socket.io-client to connect',
      endpoint: '/socket.io/',
      transport: ['websocket', 'polling'],
    },
    note: 'WebSocket connections are served by the custom server (npm run start:ws), not by this route',
  });
}

// WebSocket upgrade not directly supported in Next.js API routes
export async function POST(_request: NextRequest) {
  return NextResponse.json({
    error: 'WebSocket upgrade not supported via API routes',
    solution: 'Connect with socket.io-client to /socket.io/ on the custom server (npm run start:ws)',
    alternatives: [
      'Use polling-based real-time updates via GraphQL',
      'Deploy with custom server on platforms like Render, Railway, or VPS',
      'Use external real-time service (Ably, Pusher, etc.)',
    ],
  }, { status: 400 });
}
