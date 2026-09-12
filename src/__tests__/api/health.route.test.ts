/**
 * Health check: answers 200 without needing the database, Redis or GraphQL
 */

import { GET } from '@/app/api/health/route';

describe('GET /api/health', () => {
  it('answers 200 with status ok', async () => {
    const response = GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: 'ok' });
  });
});
