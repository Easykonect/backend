/**
 * Socket information route: points clients at the Socket.IO path on the custom server
 */

import type { NextRequest } from 'next/server';
import { GET, POST } from '@/app/api/socket/route';

describe('socket information route', () => {
  it('names the Socket.IO path and the command that runs it', async () => {
    const body = await (await GET()).json();

    expect(body.info.endpoint).toBe('/socket.io/');
    expect(body.note).toContain('npm run start:ws');
    expect(JSON.stringify(body)).not.toContain('npm run server');
  });

  it('points POST callers to the same place', async () => {
    const response = await POST({} as NextRequest);
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.solution).toContain('/socket.io/');
    expect(body.solution).toContain('npm run start:ws');
  });
});
