/**
 * Paystack Webhook Handler
 *
 * This endpoint receives webhook events from Paystack for:
 * - charge.success - Payment completed
 * - charge.failed - Payment failed
 * - transfer.success - Provider payout completed
 * - transfer.failed - Provider payout failed
 * - refund.processed - Refund completed
 *
 * Paystack sends webhooks to notify your application when events occur.
 * All webhooks are signed with your secret key for verification.
 *
 * Setup in Paystack Dashboard:
 * 1. Go to Settings > API Keys & Webhooks
 * 2. Add webhook URL: https://your-domain.com/api/webhooks/paystack
 */

import { NextRequest, NextResponse } from 'next/server';
import { GraphQLError } from 'graphql';
import { handlePaystackWebhook } from '@/services/payment.service';

export async function POST(request: NextRequest) {
  // Get the raw body as text for signature verification
  const payload = await request.text();

  // Get the Paystack signature from headers
  const signature = request.headers.get('x-paystack-signature');

  if (!signature) {
    console.error('Webhook error: Missing Paystack signature');
    return NextResponse.json(
      { error: 'Missing signature' },
      { status: 400 }
    );
  }

  try {
    const result = await handlePaystackWebhook(payload, signature);
    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    if (error instanceof GraphQLError && error.extensions.code === 'INVALID_SIGNATURE') {
      return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
    }

    console.error('Webhook processing error:', error);

    // Any non-2xx response makes Paystack redeliver the event (live mode:
    // every 3 minutes for 4 tries, then hourly for 72 hours)
    return NextResponse.json({ received: false }, { status: 500 });
  }
}

// Paystack only sends POST requests for webhooks
export async function GET() {
  return NextResponse.json(
    {
      status: 'ok',
      message: 'Paystack webhook endpoint is active',
      supportedEvents: [
        'charge.success',
        'charge.failed',
        'transfer.success',
        'transfer.failed',
        'refund.processed',
      ]
    },
    { status: 200 }
  );
}
