/**
 * Health check for the hosting platform. It answers without touching the
 * database, Redis or GraphQL, so a slow dependency doesn't take the service
 * out of rotation.
 */

import { NextResponse } from 'next/server';

export function GET() {
  return NextResponse.json({ status: 'ok' });
}
