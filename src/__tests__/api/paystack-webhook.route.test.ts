/**
 * Paystack webhook route: the response code decides whether Paystack retries
 */

import { GraphQLError } from 'graphql';
import { NextRequest } from 'next/server';

jest.mock('@/services/payment.service', () => ({
  handlePaystackWebhook: jest.fn(),
}));

import { handlePaystackWebhook } from '@/services/payment.service';
import { POST } from '@/app/api/webhooks/paystack/route';

const handle = handlePaystackWebhook as jest.Mock;

const webhookRequest = (headers: Record<string, string> = { 'x-paystack-signature': 'signature' }) =>
  new NextRequest('https://api.example.com/api/webhooks/paystack', {
    method: 'POST',
    headers,
    body: JSON.stringify({ event: 'charge.success', data: { reference: 'ref-1' } }),
  });

describe('POST /api/webhooks/paystack', () => {
  it('acknowledges processed events', async () => {
    handle.mockResolvedValue({ received: true });
    expect((await POST(webhookRequest())).status).toBe(200);
  });

  it('acknowledges events flagged for an admin', async () => {
    handle.mockResolvedValue({ received: true, flagged: 'BOOKING_CANCELLED' });
    expect((await POST(webhookRequest())).status).toBe(200);
  });

  it('rejects an invalid signature', async () => {
    handle.mockRejectedValue(
      new GraphQLError('Invalid webhook signature', { extensions: { code: 'INVALID_SIGNATURE' } })
    );
    expect((await POST(webhookRequest())).status).toBe(401);
  });

  it('answers temporary failures with an error so Paystack retries', async () => {
    handle.mockRejectedValue(new Error('database unavailable'));
    expect((await POST(webhookRequest())).status).toBe(500);
  });

  it('rejects requests without a signature', async () => {
    expect((await POST(webhookRequest({}))).status).toBe(400);
    expect(handle).not.toHaveBeenCalled();
  });
});
