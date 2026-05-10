/**
 * Payment Service Tests
 *
 * Covers the bug-fix sweep additions:
 *   - initializePayment requires booking.status === ACCEPTED (pay-after-accept)
 *   - initializePayment uses the backend bridge URL when returnDeepLink is set
 *   - returnDeepLink is embedded in Paystack metadata
 *   - Falls back to legacy callbackUrl, then to FRONTEND_URL
 */

import { GraphQLError } from 'graphql';

// ==================
// Mocks
// ==================

jest.mock('@/lib/prisma', () => ({
  __esModule: true,
  default: {
    booking: {
      findUnique: jest.fn(),
    },
    payment: {
      upsert: jest.fn(),
    },
  },
}));

jest.mock('@/lib/paystack', () => ({
  paystack: {
    initializeTransaction: jest.fn(),
  },
  generateTransactionReference: jest.fn().mockReturnValue('test-ref-123'),
  nairaToKobo: (n: number) => n * 100,
  koboToNaira: (k: number) => k / 100,
  calculateProviderPayout: jest.fn().mockReturnValue({
    platformCommission: 35000, // kobo
    providerPayout: 465000,
    paystackFee: 7500,
  }),
  verifyWebhookSignature: jest.fn(),
}));

jest.mock('@/lib/sentry', () => ({
  capturePaymentError: jest.fn(),
  addBreadcrumb: jest.fn(),
  captureException: jest.fn(),
}));

jest.mock('@/services/notification.service', () => ({
  createNotification: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/config', () => ({
  config: {
    platform: {
      frontendUrl: 'https://app.easykonnect.com',
      backendUrl: 'https://api.easykonnect.com',
      commissionRate: 0.07,
    },
    payment: { paystack: { secretKey: 'sk_test', publicKey: 'pk_test' } },
    redisUrl: 'redis://localhost:6379',
  },
}));

jest.mock('@/lib/redis', () => ({
  __esModule: true,
  default: {
    getInstance: jest.fn().mockReturnValue({
      get: jest.fn(),
      set: jest.fn(),
      del: jest.fn(),
    }),
  },
  isWebhookProcessed: jest.fn().mockResolvedValue(false),
  markWebhookProcessed: jest.fn().mockResolvedValue(undefined),
}));

import prisma from '@/lib/prisma';
import { paystack } from '@/lib/paystack';
import { initializePayment } from '@/services/payment.service';

// ==================
// Fixtures
// ==================

const userId = '507f1f77bcf86cd700000001';
const bookingId = '507f1f77bcf86cd700000020';

const acceptedBooking = {
  id: bookingId,
  userId,
  providerId: 'p1',
  serviceId: 'svc1',
  status: 'ACCEPTED',
  servicePrice: 5000,
  user: { email: 'customer@example.com' },
  service: { name: 'Deep Cleaning' },
  provider: { id: 'p1' },
  payment: null,
};

const successfulPaystackResponse = {
  status: true,
  data: {
    authorization_url: 'https://checkout.paystack.com/abc',
    access_code: 'access_xyz',
    reference: 'test-ref-123',
  },
};

beforeEach(() => {
  (prisma.booking.findUnique as jest.Mock).mockReset();
  (prisma.payment.upsert as jest.Mock).mockReset();
  (paystack.initializeTransaction as jest.Mock).mockReset();
  (prisma.payment.upsert as jest.Mock).mockResolvedValue({
    id: 'pay1',
    bookingId,
    amount: 5000,
    commission: 350,
    providerPayout: 4650,
    status: 'PENDING',
    transactionRef: 'test-ref-123',
    createdAt: new Date(),
    updatedAt: new Date(),
  });
});

// ==================
// pay-after-accept guard
// ==================

describe('initializePayment — pay-after-accept guard', () => {
  it('rejects when booking is still PENDING', async () => {
    (prisma.booking.findUnique as jest.Mock).mockResolvedValueOnce({
      ...acceptedBooking,
      status: 'PENDING',
    });

    await expect(initializePayment(userId, { bookingId })).rejects.toThrow(
      /Booking must be accepted by the provider first/
    );
    expect(paystack.initializeTransaction).not.toHaveBeenCalled();
  });

  it('rejects when caller is not the booking owner', async () => {
    (prisma.booking.findUnique as jest.Mock).mockResolvedValueOnce({
      ...acceptedBooking,
      userId: 'someone-else',
    });

    await expect(initializePayment(userId, { bookingId })).rejects.toThrow(
      /can only pay for your own bookings/
    );
  });

  it('rejects when payment is already COMPLETED for this booking', async () => {
    (prisma.booking.findUnique as jest.Mock).mockResolvedValueOnce({
      ...acceptedBooking,
      payment: { status: 'COMPLETED' },
    });

    let caught: GraphQLError | undefined;
    await initializePayment(userId, { bookingId }).catch((e) => (caught = e));
    expect(caught).toBeInstanceOf(GraphQLError);
    expect(caught!.extensions.code).toBe('PAYMENT_ALREADY_COMPLETED');
  });

  it('proceeds when booking is ACCEPTED', async () => {
    (prisma.booking.findUnique as jest.Mock).mockResolvedValueOnce(acceptedBooking);
    (paystack.initializeTransaction as jest.Mock).mockResolvedValueOnce(successfulPaystackResponse);

    const result = await initializePayment(userId, { bookingId });
    expect(result.authorizationUrl).toBe('https://checkout.paystack.com/abc');
    expect(paystack.initializeTransaction).toHaveBeenCalled();
  });
});

// ==================
// callback URL resolution (Paystack callback bridge)
// ==================

describe('initializePayment — callback URL resolution', () => {
  it('uses the backend bridge URL when returnDeepLink is provided', async () => {
    (prisma.booking.findUnique as jest.Mock).mockResolvedValueOnce(acceptedBooking);
    (paystack.initializeTransaction as jest.Mock).mockResolvedValueOnce(successfulPaystackResponse);

    await initializePayment(userId, {
      bookingId,
      returnDeepLink: 'easykonnect://payment-callback',
    });

    const call = (paystack.initializeTransaction as jest.Mock).mock.calls[0][0];
    expect(call.callback_url).toBe('https://api.easykonnect.com/api/payments/paystack/callback');
  });

  it('embeds returnDeepLink in Paystack metadata for the bridge to recover', async () => {
    (prisma.booking.findUnique as jest.Mock).mockResolvedValueOnce(acceptedBooking);
    (paystack.initializeTransaction as jest.Mock).mockResolvedValueOnce(successfulPaystackResponse);

    await initializePayment(userId, {
      bookingId,
      returnDeepLink: 'easykonnect://payment-callback',
    });

    const call = (paystack.initializeTransaction as jest.Mock).mock.calls[0][0];
    expect(call.metadata.returnDeepLink).toBe('easykonnect://payment-callback');
  });

  it('uses the legacy callbackUrl when only that is provided (web flow)', async () => {
    (prisma.booking.findUnique as jest.Mock).mockResolvedValueOnce(acceptedBooking);
    (paystack.initializeTransaction as jest.Mock).mockResolvedValueOnce(successfulPaystackResponse);

    await initializePayment(userId, {
      bookingId,
      callbackUrl: 'https://web.easykonnect.com/booking/done',
    });

    const call = (paystack.initializeTransaction as jest.Mock).mock.calls[0][0];
    expect(call.callback_url).toBe('https://web.easykonnect.com/booking/done');
    expect(call.metadata.returnDeepLink).toBeNull();
  });

  it('falls back to FRONTEND_URL/payment/callback when neither is provided', async () => {
    (prisma.booking.findUnique as jest.Mock).mockResolvedValueOnce(acceptedBooking);
    (paystack.initializeTransaction as jest.Mock).mockResolvedValueOnce(successfulPaystackResponse);

    await initializePayment(userId, { bookingId });

    const call = (paystack.initializeTransaction as jest.Mock).mock.calls[0][0];
    expect(call.callback_url).toBe('https://app.easykonnect.com/payment/callback');
  });

  it('prefers returnDeepLink over a legacy callbackUrl when both are provided', async () => {
    (prisma.booking.findUnique as jest.Mock).mockResolvedValueOnce(acceptedBooking);
    (paystack.initializeTransaction as jest.Mock).mockResolvedValueOnce(successfulPaystackResponse);

    await initializePayment(userId, {
      bookingId,
      callbackUrl: 'https://web.easykonnect.com/done',
      returnDeepLink: 'easykonnect://payment-callback',
    });

    const call = (paystack.initializeTransaction as jest.Mock).mock.calls[0][0];
    // Bridge route wins because returnDeepLink is set
    expect(call.callback_url).toBe('https://api.easykonnect.com/api/payments/paystack/callback');
    expect(call.metadata.returnDeepLink).toBe('easykonnect://payment-callback');
  });
});
