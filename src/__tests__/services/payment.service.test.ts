/**
 * Payment Service Tests
 *
 *   - initializePayment: pay-after-accept guard, return links, callback URLs
 *     (Paystack callback bridge), checkout references, Paystack errors
 *   - verifyPayment: applying a charge, charges credited to the wallet instead,
 *     refusals, failed charges and Paystack errors
 *   - payWithWallet and processRefund, through the real wallet and escrow services
 *   - handlePaystackWebhook, getPaymentByBookingId, getPaymentStats and
 *     getProviderEarnings
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
      create: jest.fn(),
      updateMany: jest.fn(),
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      count: jest.fn(),
      aggregate: jest.fn(),
    },
    wallet: {
      findUnique: jest.fn(),
      create: jest.fn(),
    },
    user: {
      findMany: jest.fn(),
    },
    serviceProvider: {
      findUnique: jest.fn(),
    },
    platformSettings: {
      findUnique: jest.fn(),
    },
    $transaction: jest.fn(),
  },
}));

jest.mock('@/lib/paystack', () => ({
  paystack: {
    initializeTransaction: jest.fn(),
    verifyTransaction: jest.fn(),
  },
  PaystackRequestError: jest.requireActual('@/lib/paystack').PaystackRequestError,
  generateTransactionReference: jest.fn().mockReturnValue('test-ref-123'),
  nairaToKobo: (n: number) => n * 100,
  koboToNaira: (k: number) => k / 100,
  verifyWebhookSignature: jest.fn(),
}));

jest.mock('@/lib/sentry', () => ({
  capturePaymentError: jest.fn(),
  addBreadcrumb: jest.fn(),
  captureException: jest.fn(),
  captureWalletError: jest.fn(),
}));

jest.mock('@/services/notification.service', () => ({
  createNotification: jest.fn().mockResolvedValue(undefined),
  createBulkNotifications: jest.fn().mockResolvedValue({ count: 1 }),
}));

jest.mock('@/services/push.service', () => ({
  sendPushToUser: jest.fn().mockResolvedValue({ success: true }),
}));

jest.mock('@/services/audit.service', () => ({
  createAuditLog: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/services/withdrawal.service', () => ({
  handleTransferSuccess: jest.fn().mockResolvedValue(undefined),
  handleTransferFailed: jest.fn().mockResolvedValue(undefined),
  handleTransferReversed: jest.fn().mockResolvedValue(undefined),
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
      exists: jest.fn().mockResolvedValue(0),
      setex: jest.fn().mockResolvedValue('OK'),
    }),
  },
  isWebhookProcessed: jest.fn().mockResolvedValue(false),
  markWebhookProcessed: jest.fn().mockResolvedValue(undefined),
}));

import prisma from '@/lib/prisma';
import { paystack, PaystackRequestError, verifyWebhookSignature } from '@/lib/paystack';
import { capturePaymentError } from '@/lib/sentry';
import RedisClient from '@/lib/redis';
import { createAuditLog } from '@/services/audit.service';
import { createBulkNotifications, createNotification } from '@/services/notification.service';
import { sendPushToUser } from '@/services/push.service';
import {
  handleTransferFailed,
  handleTransferReversed,
  handleTransferSuccess,
} from '@/services/withdrawal.service';
import {
  getPaymentByBookingId,
  getPaymentStats,
  getProviderEarnings,
  handlePaystackWebhook,
  initializePayment,
  payWithWallet,
  processRefund,
  verifyPayment,
} from '@/services/payment.service';

// ==================
// Fixtures
// ==================

const userId = '507f1f77bcf86cd700000001';
const bookingId = '507f1f77bcf86cd700000020';
const providerUserId = 'provider-user';
const adminId = 'admin-1';

const acceptedBooking = {
  id: bookingId,
  userId,
  providerId: 'p1',
  serviceId: 'svc1',
  status: 'ACCEPTED',
  totalAmount: 5000,
  commission: 350,
  user: { email: 'customer@example.com', restrictedAt: null, restrictedUntil: null },
  service: { name: 'Deep Cleaning' },
  provider: { id: 'p1', userId: providerUserId },
  payment: null,
};

const pendingPayment = {
  id: 'pay1',
  bookingId,
  amount: 5000,
  commission: 350,
  providerPayout: 4650,
  status: 'PENDING',
  transactionRef: 'ref-new',
  transactionRefs: ['ref-old', 'ref-new'],
  refundedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  booking: acceptedBooking,
};

const customerWallet = {
  id: 'wallet-1',
  userId,
  balance: 1_000_000,
  pendingBalance: 0,
  isLocked: false,
  lockedReason: null,
};

const successfulPaystackResponse = {
  status: true,
  data: {
    authorization_url: 'https://checkout.paystack.com/abc',
    access_code: 'access_xyz',
    reference: 'test-ref-123',
  },
};

const paystackVerification = (status: string, reference: string, amount = 500000) => ({
  status: true,
  data: {
    status,
    reference,
    amount,
    currency: 'NGN',
    fees: 7500,
    channel: 'card',
    paid_at: new Date().toISOString(),
    gateway_response: status === 'success' ? 'Approved' : 'The transaction was not completed',
  },
});

// The client handed to withTransaction callbacks
const tx = {
  booking: { updateMany: jest.fn(), update: jest.fn() },
  payment: { findUnique: jest.fn(), update: jest.fn(), updateMany: jest.fn(), create: jest.fn() },
  wallet: { update: jest.fn(), updateMany: jest.fn(), findUnique: jest.fn() },
  walletTransaction: { findUnique: jest.fn(), create: jest.fn() },
};

type CreateArgs = { data: Record<string, unknown> };
type BalanceIncrement = { where: { id: string }; data: { balance: { increment: number } } };

const redis = RedisClient.getInstance() as unknown as { exists: jest.Mock; setex: jest.Mock };

const resetMockTree = (node: unknown): void => {
  if (jest.isMockFunction(node)) {
    node.mockReset();
  } else if (node && typeof node === 'object') {
    Object.values(node).forEach(resetMockTree);
  }
};

beforeEach(() => {
  resetMockTree(prisma);
  resetMockTree(tx);
  resetMockTree(paystack);

  (prisma.$transaction as jest.Mock).mockImplementation(
    async (run: (client: typeof tx) => Promise<unknown>) => run(tx)
  );
  (prisma.payment.create as jest.Mock).mockImplementation(async ({ data }: CreateArgs) => ({
    id: 'pay1',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...data,
  }));
  (prisma.wallet.findUnique as jest.Mock).mockResolvedValue(customerWallet);

  tx.walletTransaction.findUnique.mockResolvedValue(null);
  tx.walletTransaction.create.mockImplementation(async ({ data }: CreateArgs) => ({
    id: 'wtx1',
    createdAt: new Date(),
    ...data,
  }));
  tx.wallet.update.mockImplementation(async ({ where, data }: BalanceIncrement) => ({
    ...customerWallet,
    id: where.id,
    balance: customerWallet.balance + data.balance.increment,
  }));
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

describe('initializePayment — return links', () => {
  it.each(['https://evil.example/x', 'javascript:alert(1)'])(
    'rejects %s before calling Paystack',
    async (returnDeepLink) => {
      (prisma.booking.findUnique as jest.Mock).mockResolvedValue(acceptedBooking);

      await expect(initializePayment(userId, { bookingId, returnDeepLink })).rejects.toMatchObject({
        extensions: { code: 'INVALID_RETURN_LINK' },
      });
      expect(paystack.initializeTransaction).not.toHaveBeenCalled();
    }
  );
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

  it('uses callbackUrl when only that is provided (web flow)', async () => {
    (prisma.booking.findUnique as jest.Mock).mockResolvedValueOnce(acceptedBooking);
    (paystack.initializeTransaction as jest.Mock).mockResolvedValueOnce(successfulPaystackResponse);

    await initializePayment(userId, {
      bookingId,
      callbackUrl: 'https://app.easykonnect.com/booking/done',
    });

    const call = (paystack.initializeTransaction as jest.Mock).mock.calls[0][0];
    expect(call.callback_url).toBe('https://app.easykonnect.com/booking/done');
    expect(call.metadata.returnDeepLink).toBeNull();
  });

  it.each([
    ['another website', 'https://evil.example/x'],
    ['a lookalike domain', 'https://app.easykonnect.com.evil.example/done'],
    ['our site over plain http', 'http://app.easykonnect.com/booking/done'],
    ['an app link', 'easykonnect://payment-callback'],
    ['text that isn’t a URL', 'not a url'],
  ])('rejects a callbackUrl that is %s before looking anything up', async (_label, callbackUrl) => {
    await expect(initializePayment(userId, { bookingId, callbackUrl })).rejects.toMatchObject({
      message: 'callbackUrl must be a page on the Easykonnet website',
      extensions: { code: 'INVALID_RETURN_LINK' },
    });

    expect(prisma.booking.findUnique).not.toHaveBeenCalled();
    expect(paystack.initializeTransaction).not.toHaveBeenCalled();
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

// ==================
// Reopened checkouts (double-tap Pay)
// ==================

describe('initializePayment — keeps every checkout reference', () => {
  beforeEach(() => {
    (paystack.initializeTransaction as jest.Mock).mockResolvedValue(successfulPaystackResponse);
    (prisma.payment.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
    (prisma.payment.findUniqueOrThrow as jest.Mock).mockResolvedValue({
      ...pendingPayment,
      transactionRef: 'test-ref-123',
      transactionRefs: ['ref-old', 'test-ref-123'],
    });
  });

  it('creates the payment with its first reference for a new checkout', async () => {
    (prisma.booking.findUnique as jest.Mock).mockResolvedValueOnce(acceptedBooking);

    await initializePayment(userId, { bookingId });

    expect(prisma.payment.create).toHaveBeenCalledWith({
      data: {
        bookingId,
        amount: 5000,
        commission: 350,
        providerPayout: 4650,
        status: 'PENDING',
        transactionRef: 'test-ref-123',
        transactionRefs: ['test-ref-123'],
      },
    });
    expect(prisma.payment.updateMany).not.toHaveBeenCalled();
  });

  it('reopens an unpaid checkout and appends the new reference', async () => {
    (prisma.booking.findUnique as jest.Mock).mockResolvedValueOnce({
      ...acceptedBooking,
      payment: { status: 'FAILED', transactionRef: 'ref-old', transactionRefs: ['ref-old'] },
    });

    const result = await initializePayment(userId, { bookingId });

    expect(prisma.payment.create).not.toHaveBeenCalled();
    expect(prisma.payment.updateMany).toHaveBeenCalledWith({
      where: { bookingId, status: { in: ['PENDING', 'PROCESSING', 'FAILED'] } },
      data: {
        amount: 5000,
        commission: 350,
        providerPayout: 4650,
        status: 'PENDING',
        transactionRef: 'test-ref-123',
        transactionRefs: { push: ['test-ref-123'] },
      },
    });
    expect(prisma.payment.findUniqueOrThrow).toHaveBeenCalledWith({ where: { bookingId } });
    expect(result.payment.transactionRef).toBe('test-ref-123');
  });

  it('also records the reference of a legacy payment that only had transactionRef', async () => {
    (prisma.booking.findUnique as jest.Mock).mockResolvedValueOnce({
      ...acceptedBooking,
      payment: { status: 'PENDING', transactionRef: 'ref-legacy', transactionRefs: [] },
    });

    await initializePayment(userId, { bookingId });

    const { data } = (prisma.payment.updateMany as jest.Mock).mock.calls[0][0];
    expect(data.transactionRefs).toEqual({ push: ['ref-legacy', 'test-ref-123'] });
  });

  it('refuses to reopen a checkout whose payment completed in the meantime', async () => {
    (prisma.booking.findUnique as jest.Mock).mockResolvedValueOnce({
      ...acceptedBooking,
      payment: { status: 'PENDING', transactionRef: 'ref-old', transactionRefs: ['ref-old'] },
    });
    (prisma.payment.updateMany as jest.Mock).mockResolvedValueOnce({ count: 0 });

    await expect(initializePayment(userId, { bookingId })).rejects.toMatchObject({
      extensions: { code: 'PAYMENT_ALREADY_COMPLETED' },
    });
    expect(prisma.payment.findUniqueOrThrow).not.toHaveBeenCalled();
  });
});

// ==================
// verifyPayment
// ==================

describe('verifyPayment — successful charges', () => {
  beforeEach(() => {
    (prisma.payment.findFirst as jest.Mock).mockResolvedValue(pendingPayment);
    (prisma.payment.findUnique as jest.Mock).mockResolvedValue({ ...pendingPayment, status: 'COMPLETED' });
    tx.payment.findUnique.mockResolvedValue(pendingPayment);
    tx.booking.updateMany.mockResolvedValue({ count: 1 });
    tx.payment.update.mockResolvedValue({});
  });

  it('completes the payment when the customer paid on an older checkout', async () => {
    (paystack.verifyTransaction as jest.Mock).mockResolvedValueOnce(paystackVerification('success', 'ref-old'));

    const result = await verifyPayment('ref-old');

    expect(result.verified).toBe(true);
    const lookup = (prisma.payment.findFirst as jest.Mock).mock.calls[0][0];
    expect(lookup.where.OR).toContainEqual({ transactionRefs: { has: 'ref-old' } });
    expect(tx.walletTransaction.findUnique).toHaveBeenCalledWith({ where: { reference: 'CHG_ref-old' } });
    expect(tx.payment.update).toHaveBeenCalledWith({
      where: { id: 'pay1' },
      data: expect.objectContaining({
        status: 'COMPLETED',
        transactionRef: 'ref-old',
        paymentMethod: 'card',
        paystackFee: 75,
      }),
    });
    expect(prisma.payment.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'pay1' } }));
    expect(tx.wallet.update).not.toHaveBeenCalled();
  });

  it('leaves the booking ACCEPTED and notifies the customer and the provider once each', async () => {
    (paystack.verifyTransaction as jest.Mock).mockResolvedValueOnce(paystackVerification('success', 'ref-new'));

    await verifyPayment('ref-new');

    expect(tx.booking.updateMany).toHaveBeenCalledWith({
      where: { id: bookingId, status: 'ACCEPTED' },
      data: { updatedAt: expect.any(Date) },
    });
    expect(tx.booking.update).not.toHaveBeenCalled();
    expect(JSON.stringify(tx.payment.update.mock.calls)).not.toContain('IN_PROGRESS');
    expect(createNotification).toHaveBeenCalledTimes(2);
    expect(createNotification).toHaveBeenCalledWith(expect.objectContaining({ userId, type: 'PAYMENT_RECEIVED' }));
    expect(createNotification).toHaveBeenCalledWith(
      expect.objectContaining({ userId: providerUserId, type: 'PAYMENT_RECEIVED' })
    );
    expect(sendPushToUser).toHaveBeenCalledTimes(2);
  });

  it('returns without calling Paystack when the reference was already applied', async () => {
    (prisma.payment.findFirst as jest.Mock).mockResolvedValueOnce({ ...pendingPayment, status: 'COMPLETED' });

    const result = await verifyPayment('ref-new');

    expect(result).toMatchObject({ verified: true, message: 'Payment already verified and completed' });
    expect(paystack.verifyTransaction).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('does not credit a refunded payment again when its own charge is verified', async () => {
    (prisma.payment.findFirst as jest.Mock).mockResolvedValueOnce({
      ...pendingPayment,
      status: 'REFUNDED',
      refundedAt: new Date(),
    });

    const result = await verifyPayment('ref-new');

    expect(result).toMatchObject({ verified: false, message: 'This payment has been refunded' });
    expect(paystack.verifyTransaction).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(tx.wallet.update).not.toHaveBeenCalled();
    expect(createNotification).not.toHaveBeenCalled();
  });

  it.each([
    { status: 'COMPLETED', verified: true },
    { status: 'REFUNDED', verified: false },
  ])('applies nothing when a concurrent verification already settled the charge ($status)', async ({ status, verified }) => {
    const settled = { ...pendingPayment, status };
    (paystack.verifyTransaction as jest.Mock).mockResolvedValueOnce(paystackVerification('success', 'ref-new'));
    tx.payment.findUnique.mockResolvedValue(settled);
    (prisma.payment.findUnique as jest.Mock).mockResolvedValue(settled);

    const result = await verifyPayment('ref-new');

    expect(result.verified).toBe(verified);
    expect(tx.booking.updateMany).not.toHaveBeenCalled();
    expect(tx.payment.update).not.toHaveBeenCalled();
    expect(tx.wallet.update).not.toHaveBeenCalled();
    expect(createNotification).not.toHaveBeenCalled();
  });
});

describe('verifyPayment — charges credited to the wallet', () => {
  it('credits the charge to the customer’s wallet when the booking is no longer ACCEPTED', async () => {
    (prisma.payment.findFirst as jest.Mock).mockResolvedValue(pendingPayment);
    (prisma.payment.findUnique as jest.Mock).mockResolvedValue(pendingPayment);
    (paystack.verifyTransaction as jest.Mock).mockResolvedValueOnce(paystackVerification('success', 'ref-new'));
    tx.payment.findUnique.mockResolvedValue(pendingPayment);
    tx.booking.updateMany.mockResolvedValue({ count: 0 });

    const result = await verifyPayment('ref-new');

    expect(prisma.wallet.findUnique).toHaveBeenCalledWith({ where: { userId } });
    expect(tx.wallet.update).toHaveBeenCalledWith({
      where: { id: 'wallet-1' },
      data: { balance: { increment: 500000 } },
    });
    expect(tx.walletTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        walletId: 'wallet-1',
        type: 'CREDIT',
        source: 'REFUND',
        amount: 500000,
        reference: 'CHG_ref-new',
        bookingId,
        paymentId: 'pay1',
      }),
    });
    expect(tx.payment.update).not.toHaveBeenCalled();
    expect(result.verified).toBe(false);
    expect(createNotification).toHaveBeenCalledTimes(1);
    expect(createNotification).toHaveBeenCalledWith(expect.objectContaining({ userId, type: 'REFUND_PROCESSED' }));
  });

  describe('a second charge for a payment already completed on another reference', () => {
    const completedPayment = { ...pendingPayment, status: 'COMPLETED', transactionRef: 'ref-new' };

    beforeEach(() => {
      (prisma.payment.findFirst as jest.Mock).mockResolvedValue(completedPayment);
      (prisma.payment.findUnique as jest.Mock).mockResolvedValue(completedPayment);
      (paystack.verifyTransaction as jest.Mock).mockResolvedValue(paystackVerification('success', 'ref-old'));
      tx.payment.findUnique.mockResolvedValue(completedPayment);
    });

    it('credits it to the wallet once', async () => {
      const result = await verifyPayment('ref-old');

      expect(tx.booking.updateMany).not.toHaveBeenCalled();
      expect(tx.payment.update).not.toHaveBeenCalled();
      expect(tx.wallet.update).toHaveBeenCalledTimes(1);
      expect(tx.walletTransaction.create).toHaveBeenCalledTimes(1);
      expect(tx.walletTransaction.create.mock.calls[0][0].data).toMatchObject({
        amount: 500000,
        reference: 'CHG_ref-old',
      });
      expect(result.verified).toBe(true);
      expect(createNotification).toHaveBeenCalledTimes(1);
      expect(createNotification).toHaveBeenCalledWith(expect.objectContaining({ userId, type: 'REFUND_PROCESSED' }));
    });

    it('credits nothing and notifies nobody when the CHG_ entry already exists', async () => {
      tx.walletTransaction.findUnique.mockResolvedValue({
        id: 'wtx0',
        walletId: 'wallet-1',
        type: 'CREDIT',
        amount: 500000,
        reference: 'CHG_ref-old',
      });

      const result = await verifyPayment('ref-old');

      expect(tx.walletTransaction.findUnique).toHaveBeenCalledWith({ where: { reference: 'CHG_ref-old' } });
      expect(tx.wallet.update).not.toHaveBeenCalled();
      expect(tx.walletTransaction.create).not.toHaveBeenCalled();
      expect(createNotification).not.toHaveBeenCalled();
      expect(sendPushToUser).not.toHaveBeenCalled();
      expect(result.verified).toBe(true);
    });
  });
});

describe('verifyPayment — refusals and failed charges', () => {
  beforeEach(() => {
    (prisma.payment.findFirst as jest.Mock).mockResolvedValue(pendingPayment);
  });

  it('throws AMOUNT_MISMATCH when Paystack charged a different amount', async () => {
    (paystack.verifyTransaction as jest.Mock).mockResolvedValueOnce(
      paystackVerification('success', 'ref-new', 400000)
    );

    await expect(verifyPayment('ref-new')).rejects.toMatchObject({ extensions: { code: 'AMOUNT_MISMATCH' } });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('refuses a requester who is not the customer, the provider or an admin before calling Paystack', async () => {
    await expect(
      verifyPayment('ref-new', { userId: 'stranger', role: 'SERVICE_USER' })
    ).rejects.toMatchObject({ extensions: { code: 'UNAUTHORIZED' } });
    expect(paystack.verifyTransaction).not.toHaveBeenCalled();
  });

  it('marks an open payment FAILED and notifies the customer', async () => {
    (paystack.verifyTransaction as jest.Mock).mockResolvedValueOnce(paystackVerification('failed', 'ref-new'));
    (prisma.payment.updateMany as jest.Mock).mockResolvedValueOnce({ count: 1 });

    const result = await verifyPayment('ref-new');

    expect(result.verified).toBe(false);
    expect(prisma.payment.updateMany).toHaveBeenCalledWith({
      where: { id: 'pay1', transactionRef: 'ref-new', status: { in: ['PENDING', 'PROCESSING'] } },
      data: { status: 'FAILED', paymentMethod: 'card' },
    });
    expect(createNotification).toHaveBeenCalledTimes(1);
    expect(createNotification).toHaveBeenCalledWith(expect.objectContaining({ userId, type: 'PAYMENT_FAILED' }));
  });

  it('does not notify about a failed charge when the payment had already moved on', async () => {
    (paystack.verifyTransaction as jest.Mock).mockResolvedValueOnce(paystackVerification('failed', 'ref-new'));
    (prisma.payment.updateMany as jest.Mock).mockResolvedValueOnce({ count: 0 });

    await verifyPayment('ref-new');

    expect(createNotification).not.toHaveBeenCalled();
    expect(sendPushToUser).not.toHaveBeenCalled();
  });

  it('leaves the payment alone when an older checkout was abandoned', async () => {
    (paystack.verifyTransaction as jest.Mock).mockResolvedValueOnce(paystackVerification('abandoned', 'ref-old'));

    const result = await verifyPayment('ref-old');

    expect(result.verified).toBe(false);
    expect(prisma.payment.updateMany).not.toHaveBeenCalled();
  });
});

// ==================
// Wallet payments
// ==================

describe('payWithWallet', () => {
  const walletBooking = { ...acceptedBooking, totalAmount: 6000, commission: 600 };

  beforeEach(() => {
    (prisma.booking.findUnique as jest.Mock).mockResolvedValue(walletBooking);
    tx.booking.updateMany.mockResolvedValue({ count: 1 });
    tx.payment.findUnique.mockResolvedValue(null);
    tx.wallet.updateMany.mockResolvedValue({ count: 1 });
    tx.wallet.findUnique.mockResolvedValue({ ...customerWallet, balance: 400_000 });
    tx.payment.create.mockImplementation(async ({ data }: CreateArgs) => ({
      id: 'pay-wallet',
      createdAt: new Date(),
      updatedAt: new Date(),
      ...data,
    }));
  });

  it('debits the booking total from the wallet and completes the payment', async () => {
    const result = await payWithWallet(userId, bookingId);

    expect(tx.wallet.updateMany).toHaveBeenCalledWith({
      where: { id: 'wallet-1', balance: { gte: 600000 }, isLocked: false },
      data: { balance: { decrement: 600000 } },
    });
    expect(tx.walletTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: 'DEBIT',
        source: 'BOOKING_PAYMENT',
        amount: 600000,
        balanceBefore: 1_000_000,
        balanceAfter: 400_000,
        reference: `WPAY_${bookingId}`,
      }),
    });
    expect(tx.payment.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        bookingId,
        amount: 6000,
        commission: 600,
        providerPayout: 5400,
        status: 'COMPLETED',
        paymentMethod: 'wallet',
        transactionRef: `WPAY_${bookingId}`,
      }),
    });
    expect(tx.booking.updateMany).toHaveBeenCalledWith({
      where: { id: bookingId, userId, status: 'ACCEPTED' },
      data: { updatedAt: expect.any(Date) },
    });
    expect(tx.booking.update).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      success: true,
      remainingBalance: 4000,
      transaction: { type: 'DEBIT', amount: 6000, amountKobo: 600000, reference: `WPAY_${bookingId}` },
      payment: { status: 'COMPLETED', paymentMethod: 'wallet', commission: 600, providerPayout: 5400 },
    });
  });

  it.each([
    {
      refusal: 'the caller is not the owner',
      booking: { ...walletBooking, userId: 'someone-else' },
      wallet: customerWallet,
      code: 'UNAUTHORIZED',
    },
    {
      refusal: 'the booking is not ACCEPTED',
      booking: { ...walletBooking, status: 'IN_PROGRESS' },
      wallet: customerWallet,
      code: 'INVALID_BOOKING_STATUS',
    },
    {
      refusal: 'the payment is already COMPLETED',
      booking: { ...walletBooking, payment: { status: 'COMPLETED' } },
      wallet: customerWallet,
      code: 'PAYMENT_ALREADY_COMPLETED',
    },
    {
      refusal: 'the account is restricted',
      booking: { ...walletBooking, user: { ...walletBooking.user, restrictedAt: new Date() } },
      wallet: customerWallet,
      code: 'ACCOUNT_RESTRICTED',
    },
    {
      refusal: 'the wallet balance is too low',
      booking: walletBooking,
      wallet: { ...customerWallet, balance: 599_999 },
      code: 'INSUFFICIENT_BALANCE',
    },
  ])('refuses without starting a transaction when $refusal', async ({ booking, wallet, code }) => {
    (prisma.booking.findUnique as jest.Mock).mockResolvedValue(booking);
    (prisma.wallet.findUnique as jest.Mock).mockResolvedValue(wallet);

    await expect(payWithWallet(userId, bookingId)).rejects.toMatchObject({ extensions: { code } });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('throws PAYMENT_ALREADY_COMPLETED without debiting when the payment completed in the meantime', async () => {
    tx.payment.findUnique.mockResolvedValue({ ...pendingPayment, status: 'COMPLETED' });

    await expect(payWithWallet(userId, bookingId)).rejects.toMatchObject({
      extensions: { code: 'PAYMENT_ALREADY_COMPLETED' },
    });
    expect(tx.wallet.updateMany).not.toHaveBeenCalled();
    expect(tx.walletTransaction.create).not.toHaveBeenCalled();
    expect(createNotification).not.toHaveBeenCalled();
  });
});

// ==================
// Refunds
// ==================

describe('processRefund', () => {
  const paymentId = 'pay-refund';
  const reason = 'Provider did not show up';
  const paidPayment = {
    ...pendingPayment,
    id: paymentId,
    amount: 10000,
    commission: 700,
    providerPayout: 9300,
    status: 'COMPLETED',
    booking: { ...acceptedBooking, status: 'IN_PROGRESS', paymentReleasedAt: null },
  };

  beforeEach(() => {
    (prisma.payment.findUnique as jest.Mock).mockResolvedValue(paidPayment);
    tx.payment.findUnique.mockResolvedValue(paidPayment);
    tx.payment.updateMany.mockResolvedValue({ count: 1 });
    tx.booking.updateMany.mockResolvedValue({ count: 1 });
  });

  it('refunds part of a payment to the wallet and reduces the provider payout in proportion', async () => {
    await processRefund(adminId, { paymentId, amount: 5000, reason });

    expect(tx.payment.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: paymentId, status: 'COMPLETED' }),
      data: expect.objectContaining({
        status: 'COMPLETED',
        refundAmount: 5000,
        providerPayout: 4650,
        commission: 350,
        refundedVia: 'MANUAL',
        refundedBy: adminId,
      }),
    });
    expect(tx.wallet.update).toHaveBeenCalledWith({
      where: { id: 'wallet-1' },
      data: { balance: { increment: 500000 } },
    });
    expect(tx.walletTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: 'CREDIT',
        source: 'REFUND',
        amount: 500000,
        reference: `RFD_${paymentId}`,
      }),
    });
    expect(tx.booking.updateMany).toHaveBeenCalledWith({
      where: { id: bookingId, status: { not: 'DISPUTED' } },
      data: { updatedAt: expect.any(Date) },
    });
    expect(createAuditLog).toHaveBeenCalledWith(expect.objectContaining({ targetId: paymentId, performedBy: adminId }));
  });

  it('refunds the whole payment, marks it REFUNDED and cancels a booking whose job isn’t finished', async () => {
    await processRefund(adminId, { paymentId, reason });

    expect(tx.payment.updateMany.mock.calls[0][0].data).toMatchObject({
      status: 'REFUNDED',
      refundAmount: 10000,
      providerPayout: 0,
      commission: 0,
    });
    expect(tx.wallet.update).toHaveBeenCalledWith({
      where: { id: 'wallet-1' },
      data: { balance: { increment: 1_000_000 } },
    });
    expect(tx.booking.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.booking.updateMany).toHaveBeenCalledWith({
      where: { id: bookingId, status: { in: ['ACCEPTED', 'IN_PROGRESS'] } },
      data: { status: 'CANCELLED', cancelledAt: expect.any(Date), cancellationReason: `Refunded: ${reason}` },
    });
    expect(createNotification).toHaveBeenCalledWith(expect.objectContaining({
      userId: providerUserId,
      message: 'The payment for Deep Cleaning was refunded to the customer, and the booking was cancelled.',
    }));
  });

  it('keeps a COMPLETED booking completed after a full refund', async () => {
    const completedJob = { ...paidPayment, booking: { ...paidPayment.booking, status: 'COMPLETED' } };
    (prisma.payment.findUnique as jest.Mock).mockResolvedValue(completedJob);
    tx.payment.findUnique.mockResolvedValue(completedJob);
    // Not ACCEPTED or IN_PROGRESS, so only the plain write matches
    tx.booking.updateMany.mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 1 });

    await processRefund(adminId, { paymentId, reason });

    expect(tx.payment.updateMany.mock.calls[0][0].data).toMatchObject({ status: 'REFUNDED', providerPayout: 0, commission: 0 });
    expect(tx.booking.updateMany).toHaveBeenCalledTimes(2);
    expect(tx.booking.updateMany.mock.calls[1][0]).toEqual({
      where: { id: bookingId, status: { not: 'DISPUTED' } },
      data: { updatedAt: expect.any(Date) },
    });
    expect(createAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      newValue: expect.objectContaining({ bookingStatus: 'COMPLETED', totalRefunded: 10000, providerPayout: 0 }),
    }));
    expect(createNotification).toHaveBeenCalledWith(expect.objectContaining({
      userId: providerUserId,
      message: 'The payment for Deep Cleaning was refunded to the customer in full, so nothing will be released to you for this booking.',
    }));
  });

  it('refunds what is left of a partly refunded payment under its own ledger reference', async () => {
    const refundedAt = new Date('2026-09-10T09:00:00Z');
    const partlyRefunded = { ...paidPayment, refundAmount: 5000, refundedAt, commission: 350, providerPayout: 4650 };
    (prisma.payment.findUnique as jest.Mock).mockResolvedValue(partlyRefunded);
    tx.payment.findUnique.mockResolvedValue(partlyRefunded);

    const result = await processRefund(adminId, { paymentId, reason });

    expect(tx.payment.updateMany).toHaveBeenCalledWith({
      where: { id: paymentId, status: 'COMPLETED', refundedAt, refundAmount: 5000 },
      data: expect.objectContaining({ status: 'REFUNDED', refundAmount: 10000, providerPayout: 0, commission: 0 }),
    });
    expect(tx.walletTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ type: 'CREDIT', amount: 500000, reference: `RFD_${paymentId}_500000` }),
    });
    expect(tx.booking.updateMany.mock.calls[0][0].data).toMatchObject({ status: 'CANCELLED' });
    expect(result.message).toBe("₦5,000 has been refunded to the customer's wallet");
  });

  it('refuses a payment that has already been refunded in full', async () => {
    tx.payment.findUnique.mockResolvedValue({ ...paidPayment, status: 'REFUNDED', refundAmount: 10000, refundedAt: new Date() });

    await expect(processRefund(adminId, { paymentId, reason })).rejects.toMatchObject({
      message: 'This payment has already been refunded',
      extensions: { code: 'ALREADY_REFUNDED' },
    });
    expect(tx.wallet.update).not.toHaveBeenCalled();
    expect(tx.booking.updateMany).not.toHaveBeenCalled();
  });

  it('fails a full refund inside the transaction when a dispute was opened meanwhile', async () => {
    tx.booking.updateMany.mockResolvedValue({ count: 0 });

    await expect(processRefund(adminId, { paymentId, reason })).rejects.toMatchObject({
      extensions: { code: 'INVALID_BOOKING_STATUS' },
    });
    expect(tx.booking.updateMany).toHaveBeenCalledTimes(2);
    expect(createAuditLog).not.toHaveBeenCalled();
    expect(createNotification).not.toHaveBeenCalled();
  });

  it('refuses a booking with an open dispute', async () => {
    (prisma.payment.findUnique as jest.Mock).mockResolvedValue({
      ...paidPayment,
      booking: { ...paidPayment.booking, status: 'DISPUTED' },
    });

    await expect(processRefund(adminId, { paymentId, reason })).rejects.toMatchObject({
      extensions: { code: 'INVALID_BOOKING_STATUS' },
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('refuses a payment already released to the provider', async () => {
    tx.payment.findUnique.mockResolvedValue({
      ...paidPayment,
      booking: { ...paidPayment.booking, paymentReleasedAt: new Date() },
    });

    await expect(processRefund(adminId, { paymentId, reason })).rejects.toMatchObject({
      extensions: { code: 'PAYMENT_ALREADY_RELEASED' },
    });
    expect(tx.payment.updateMany).not.toHaveBeenCalled();
    expect(tx.wallet.update).not.toHaveBeenCalled();
  });

  it('refuses a second refund of the same payment', async () => {
    tx.payment.updateMany.mockResolvedValue({ count: 0 });

    await expect(processRefund(adminId, { paymentId, amount: 5000, reason })).rejects.toMatchObject({
      extensions: { code: 'ALREADY_REFUNDED' },
    });
    expect(tx.wallet.update).not.toHaveBeenCalled();
    expect(tx.booking.updateMany).not.toHaveBeenCalled();
    expect(createNotification).not.toHaveBeenCalled();
  });

  it('fails inside the transaction when a dispute was opened meanwhile', async () => {
    tx.booking.updateMany.mockResolvedValue({ count: 0 });

    await expect(processRefund(adminId, { paymentId, amount: 5000, reason })).rejects.toMatchObject({
      extensions: { code: 'INVALID_BOOKING_STATUS' },
    });
    expect(tx.booking.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: bookingId, status: { not: 'DISPUTED' } } })
    );
    expect(createAuditLog).not.toHaveBeenCalled();
    expect(createNotification).not.toHaveBeenCalled();
    expect(sendPushToUser).not.toHaveBeenCalled();
  });
});

// ==================
// Webhook error handling
// ==================

describe('handlePaystackWebhook — retries and flags', () => {
  const chargeSuccess = (reference: string) =>
    JSON.stringify({ event: 'charge.success', data: { reference } });

  beforeEach(() => {
    (verifyWebhookSignature as jest.Mock).mockReturnValue(true);
    (prisma.user.findMany as jest.Mock).mockResolvedValue([{ id: 'admin-1' }]);
  });

  it('flags a charge that cannot be applied and acknowledges it', async () => {
    (prisma.payment.findFirst as jest.Mock).mockResolvedValueOnce(null);

    const result = await handlePaystackWebhook(chargeSuccess('ref-unknown'), 'signature');

    expect(result).toEqual({ received: true, flagged: 'PAYMENT_NOT_FOUND' });
    expect(createBulkNotifications).toHaveBeenCalled();
    expect(redis.setex).toHaveBeenCalled();
  });

  it('rethrows temporary failures without marking the event processed', async () => {
    (prisma.payment.findFirst as jest.Mock).mockRejectedValueOnce(new Error('connection reset'));

    await expect(handlePaystackWebhook(chargeSuccess('ref-new'), 'signature')).rejects.toThrow('connection reset');
    expect(redis.setex).not.toHaveBeenCalled();
  });

  it('rejects an invalid signature', async () => {
    (verifyWebhookSignature as jest.Mock).mockReturnValue(false);

    await expect(handlePaystackWebhook(chargeSuccess('ref-new'), 'bad')).rejects.toMatchObject({
      extensions: { code: 'INVALID_SIGNATURE' },
    });
  });
});

describe('handlePaystackWebhook — transfer events', () => {
  const transferEvent = (event: string, data: Record<string, unknown> = {}) =>
    JSON.stringify({ event, data: { id: 4242, reference: 'WDR_ref', transfer_code: 'TRF_abc', ...data } });

  beforeEach(() => {
    (verifyWebhookSignature as jest.Mock).mockReturnValue(true);
  });

  it('keys idempotency on data.id', async () => {
    await handlePaystackWebhook(transferEvent('transfer.success'), 'signature');

    expect(redis.exists).toHaveBeenCalledWith('webhook_event:transfer.success_4242');
    expect(redis.setex).toHaveBeenCalledWith('webhook_event:transfer.success_4242', 86400, expect.any(String));
  });

  it('passes the reference and transfer code to the withdrawal handlers', async () => {
    await handlePaystackWebhook(transferEvent('transfer.success'), 'signature');
    await handlePaystackWebhook(transferEvent('transfer.failed', { reason: 'Account not found' }), 'signature');
    await handlePaystackWebhook(transferEvent('transfer.reversed'), 'signature');

    const transfer = { reference: 'WDR_ref', transferCode: 'TRF_abc' };
    expect(handleTransferSuccess).toHaveBeenCalledWith(transfer);
    expect(handleTransferFailed).toHaveBeenCalledWith(transfer, 'Account not found');
    expect(handleTransferReversed).toHaveBeenCalledWith(transfer);
  });
});

// ==================
// Queries
// ==================

describe('getPaymentByBookingId', () => {
  beforeEach(() => {
    (prisma.payment.findUnique as jest.Mock).mockResolvedValue(pendingPayment);
  });

  it('refuses a user unrelated to the booking', async () => {
    await expect(
      getPaymentByBookingId(bookingId, { userId: 'stranger', role: 'SERVICE_USER' })
    ).rejects.toMatchObject({ extensions: { code: 'UNAUTHORIZED' } });
  });

  it('allows an admin', async () => {
    const payment = await getPaymentByBookingId(bookingId, { userId: adminId, role: 'ADMIN' });

    expect(payment).toMatchObject({ id: 'pay1', bookingId });
  });
});

// ==================
// Paystack errors
// ==================

describe('Paystack errors', () => {
  const unreachable = new PaystackRequestError('Paystack request failed: The operation was aborted due to timeout');

  describe('initializePayment', () => {
    beforeEach(() => {
      (prisma.booking.findUnique as jest.Mock).mockResolvedValue(acceptedBooking);
    });

    it.each([
      ['answers with an HTTP error', new PaystackRequestError('Paystack request failed: Invalid key', 401)],
      ['can’t be reached', unreachable],
    ])('reports PAYSTACK_ERROR and saves nothing when Paystack %s', async (_case, error) => {
      (paystack.initializeTransaction as jest.Mock).mockRejectedValueOnce(error);

      await expect(initializePayment(userId, { bookingId })).rejects.toMatchObject({
        message: 'Failed to initialize payment with Paystack',
        extensions: { code: 'PAYSTACK_ERROR' },
      });
      expect(capturePaymentError).toHaveBeenCalledWith(
        error,
        expect.objectContaining({ bookingId, transactionRef: 'test-ref-123', provider: 'paystack' })
      );
      expect(prisma.payment.create).not.toHaveBeenCalled();
      expect(prisma.payment.updateMany).not.toHaveBeenCalled();
    });

    it('reports PAYSTACK_ERROR when Paystack declines to create the transaction', async () => {
      (paystack.initializeTransaction as jest.Mock).mockResolvedValueOnce({ status: false, message: 'Declined' });

      await expect(initializePayment(userId, { bookingId })).rejects.toMatchObject({
        message: 'Failed to initialize payment with Paystack',
        extensions: { code: 'PAYSTACK_ERROR' },
      });
      expect(prisma.payment.create).not.toHaveBeenCalled();
    });

    it('lets any other error through unchanged', async () => {
      const error = new Error('Paystack secret key not configured');
      (paystack.initializeTransaction as jest.Mock).mockRejectedValueOnce(error);

      await expect(initializePayment(userId, { bookingId })).rejects.toBe(error);
    });
  });

  describe('verifyPayment', () => {
    beforeEach(() => {
      (prisma.payment.findFirst as jest.Mock).mockResolvedValue(pendingPayment);
    });

    it('reports PAYSTACK_ERROR and changes nothing when Paystack doesn’t know the reference', async () => {
      const error = new PaystackRequestError('Paystack request failed: Transaction reference not found', 400);
      (paystack.verifyTransaction as jest.Mock).mockRejectedValueOnce(error);

      await expect(verifyPayment('ref-new', { userId, role: 'SERVICE_USER' })).rejects.toMatchObject({
        message: 'Failed to verify payment with Paystack',
        extensions: { code: 'PAYSTACK_ERROR' },
      });
      expect(capturePaymentError).toHaveBeenCalledWith(
        error,
        expect.objectContaining({ paymentId: 'pay1', transactionRef: 'ref-new', provider: 'paystack' })
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.payment.updateMany).not.toHaveBeenCalled();
      expect(createNotification).not.toHaveBeenCalled();
    });

    it('leaves a charge.success webhook unprocessed, so Paystack delivers it again', async () => {
      (verifyWebhookSignature as jest.Mock).mockReturnValue(true);
      (paystack.verifyTransaction as jest.Mock).mockRejectedValueOnce(unreachable);

      await expect(
        handlePaystackWebhook(JSON.stringify({ event: 'charge.success', data: { id: 99, reference: 'ref-new' } }), 'signature')
      ).rejects.toMatchObject({ extensions: { code: 'PAYSTACK_ERROR' } });
      expect(redis.setex).not.toHaveBeenCalled();
      expect(createBulkNotifications).not.toHaveBeenCalled();
    });
  });
});

// ==================
// Statistics and earnings
// ==================

describe('getPaymentStats', () => {
  beforeEach(() => {
    (prisma.payment.count as jest.Mock)
      .mockResolvedValueOnce(12) // every payment
      .mockResolvedValueOnce(8) // COMPLETED
      .mockResolvedValueOnce(2) // PENDING
      .mockResolvedValueOnce(1) // FAILED
      .mockResolvedValueOnce(1); // REFUNDED
    (prisma.platformSettings.findUnique as jest.Mock).mockResolvedValue(null);
  });

  it('counts a partly refunded payment at what it kept, so revenue is commission plus payouts', async () => {
    (prisma.payment.aggregate as jest.Mock).mockResolvedValue({
      _sum: { amount: 35_000, refundAmount: 5_000, commission: 2_100, providerPayout: 27_900 },
    });

    const stats = await getPaymentStats();

    expect(prisma.payment.aggregate).toHaveBeenCalledWith({
      where: { status: 'COMPLETED' },
      _sum: { amount: true, refundAmount: true, commission: true, providerPayout: true },
    });
    expect(stats).toEqual({
      totalPayments: 12,
      completedPayments: 8,
      pendingPayments: 2,
      failedPayments: 1,
      refundedPayments: 1,
      totalRevenue: 30_000,
      totalCommission: 2_100,
      totalProviderPayouts: 27_900,
      commissionRate: 7,
    });
    expect(stats.totalRevenue).toBe(stats.totalCommission + stats.totalProviderPayouts);
  });

  it('reports 0 when nothing has been paid', async () => {
    (prisma.payment.aggregate as jest.Mock).mockResolvedValue({
      _sum: { amount: null, refundAmount: null, commission: null, providerPayout: null },
    });

    await expect(getPaymentStats()).resolves.toMatchObject({ totalRevenue: 0, totalCommission: 0, totalProviderPayouts: 0 });
  });
});

describe('getProviderEarnings', () => {
  beforeEach(() => {
    (prisma.serviceProvider.findUnique as jest.Mock).mockResolvedValue({ id: 'p1', userId: providerUserId });
    (prisma.payment.count as jest.Mock).mockResolvedValue(2);
  });

  it('reports the commission rate charged on the provider’s paid bookings, not the current rate', async () => {
    // ₦15,000 at 10%, and ₦10,000 at 7% with ₦5,000 refunded: ₦1,850 on the ₦20,000 kept
    (prisma.payment.aggregate as jest.Mock).mockImplementation(async ({ _sum }: { _sum: Record<string, boolean> }) =>
      _sum.amount
        ? { _sum: { providerPayout: 18_150, amount: 25_000, refundAmount: 5_000, commission: 1_850 } }
        : { _sum: { providerPayout: 4_650 } }
    );

    const earnings = await getProviderEarnings(providerUserId);

    expect(earnings).toEqual({ totalEarnings: 18_150, thisMonthEarnings: 4_650, completedJobs: 2, commissionRate: 9.25 });
    expect((prisma.payment.aggregate as jest.Mock).mock.calls[0][0].where).toEqual({
      booking: { providerId: 'p1' },
      status: 'COMPLETED',
    });
    expect(prisma.platformSettings.findUnique).not.toHaveBeenCalled();
  });

  it('uses the current rate for new bookings when nothing has been kept', async () => {
    (prisma.payment.aggregate as jest.Mock).mockResolvedValue({
      _sum: { providerPayout: null, amount: null, refundAmount: null, commission: null },
    });
    (prisma.platformSettings.findUnique as jest.Mock).mockResolvedValue({ commissionRate: 0.085 });

    await expect(getProviderEarnings(providerUserId)).resolves.toMatchObject({ totalEarnings: 0, commissionRate: 8.5 });
  });

  it('throws PROVIDER_NOT_FOUND without a provider profile', async () => {
    (prisma.serviceProvider.findUnique as jest.Mock).mockResolvedValue(null);

    await expect(getProviderEarnings(providerUserId)).rejects.toMatchObject({
      message: 'Provider profile not found',
      extensions: { code: 'PROVIDER_NOT_FOUND' },
    });
  });
});
