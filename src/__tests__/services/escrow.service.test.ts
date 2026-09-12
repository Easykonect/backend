/**
 * Escrow service: the split after a refund, refunds to the customer's wallet
 * (including a payment refunded in parts) and release to the provider's wallet
 */

jest.mock('@/lib/prisma', () => ({
  __esModule: true,
  default: {
    booking: { findUnique: jest.fn() },
    $transaction: jest.fn(),
  },
}));
jest.mock('@/lib/sentry', () => ({ captureException: jest.fn(), captureWalletError: jest.fn() }));
jest.mock('@/services/wallet.service', () => ({
  ...jest.requireActual('@/services/wallet.service'),
  applyWalletCredit: jest.fn(),
  ensureWallet: jest.fn(),
}));

import prisma from '@/lib/prisma';
import type { TransactionClient } from '@/lib/transaction';
import { applyWalletCredit, ensureWallet } from '@/services/wallet.service';
import {
  refundableKobo,
  refundedSoFarKobo,
  refundPaymentToWallet,
  releaseBookingPayment,
  splitAfterRefund,
} from '@/services/escrow.service';

const bookingId = '507f1f77bcf86cd799439033';

// The transaction client passed to the escrow functions
const tx = {
  payment: { findUnique: jest.fn(), updateMany: jest.fn(), update: jest.fn() },
  booking: { updateMany: jest.fn() },
};
const client = tx as unknown as TransactionClient;

// Amounts on a payment are in naira
const payment = {
  id: 'pay-1',
  bookingId,
  amount: 10_000,
  commission: 700,
  providerPayout: 9_300,
  status: 'COMPLETED',
  refundedAt: null,
  booking: { id: bookingId, userId: 'customer-1', paymentReleasedAt: null },
};

describe('splitAfterRefund', () => {
  it('reduces the provider payout in proportion to what was kept', () => {
    expect(splitAfterRefund(1_000_000, 930_000, 500_000)).toEqual({
      keptKobo: 500_000,
      providerPayoutKobo: 465_000,
      commissionKobo: 35_000,
    });
  });

  it('leaves no payout or commission after a full refund', () => {
    expect(splitAfterRefund(1_000_000, 930_000, 1_000_000)).toMatchObject({ providerPayoutKobo: 0, commissionKobo: 0 });
  });

  it('splits a later refund from what the payment still kept', () => {
    // ₦6,000 kept after an earlier ₦4,000 refund, ₦5,580 of it the provider's
    expect(splitAfterRefund(600_000, 558_000, 300_000)).toEqual({
      keptKobo: 300_000,
      providerPayoutKobo: 279_000,
      commissionKobo: 21_000,
    });
  });
});

describe('refundedSoFarKobo and refundableKobo', () => {
  it.each([
    ['never refunded', { amount: 10_000, refundAmount: null, refundedAt: null }, 0, 1_000_000],
    ['partly refunded', { amount: 10_000, refundAmount: 4_000, refundedAt: new Date() }, 400_000, 600_000],
    ['fully refunded', { amount: 10_000, refundAmount: 10_000, refundedAt: new Date() }, 1_000_000, 0],
    ['refunded before refund amounts were stored', { amount: 10_000, refundAmount: null, refundedAt: new Date() }, 1_000_000, 0],
  ])('%s', (_case, state, refunded, refundable) => {
    expect(refundedSoFarKobo(state)).toBe(refunded);
    expect(refundableKobo(state)).toBe(refundable);
  });
});

describe('refundPaymentToWallet', () => {
  const refund = (amountKobo?: number) =>
    refundPaymentToWallet(client, 'wallet-customer', {
      paymentId: 'pay-1',
      amountKobo,
      reason: 'Half of the rooms were not cleaned',
      via: 'DISPUTE',
      refundedBy: 'admin-1',
    });

  beforeEach(() => {
    tx.payment.findUnique.mockResolvedValue(payment);
    tx.payment.updateMany.mockResolvedValue({ count: 1 });
    (applyWalletCredit as jest.Mock).mockResolvedValue({ id: 'txn-1' });
  });

  it.each([
    ['isn’t completed', { ...payment, status: 'PENDING' }, 'INVALID_PAYMENT_STATUS'],
    ['is fully refunded', { ...payment, status: 'REFUNDED', refundAmount: 10_000, refundedAt: new Date() }, 'ALREADY_REFUNDED'],
    ['had its whole amount refunded in parts', { ...payment, refundAmount: 10_000, refundedAt: new Date() }, 'ALREADY_REFUNDED'],
    ['was refunded before refund amounts were stored', { ...payment, refundedAt: new Date() }, 'ALREADY_REFUNDED'],
    ['was released to the provider', { ...payment, booking: { ...payment.booking, paymentReleasedAt: new Date() } }, 'PAYMENT_ALREADY_RELEASED'],
  ])('refuses a payment that %s', async (_case, record, code) => {
    tx.payment.findUnique.mockResolvedValue(record);

    await expect(refund()).rejects.toMatchObject({ extensions: { code } });

    expect(tx.payment.updateMany).not.toHaveBeenCalled();
    expect(applyWalletCredit).not.toHaveBeenCalled();
  });

  it('refuses more than was paid', async () => {
    await expect(refund(1_000_001)).rejects.toMatchObject({
      message: 'Refund amount must be more than ₦0 and no more than the ₦10,000 paid',
      extensions: { code: 'INVALID_REFUND_AMOUNT' },
    });

    expect(tx.payment.updateMany).not.toHaveBeenCalled();
    expect(applyWalletCredit).not.toHaveBeenCalled();
  });

  it('credits nothing when the conditional claim matches nothing', async () => {
    tx.payment.updateMany.mockResolvedValue({ count: 0 });

    await expect(refund()).rejects.toMatchObject({ extensions: { code: 'ALREADY_REFUNDED' } });

    expect(tx.payment.updateMany.mock.calls[0][0].where).toEqual({
      id: 'pay-1',
      status: 'COMPLETED',
      OR: [{ refundedAt: null }, { refundedAt: { isSet: false } }],
    });
    expect(applyWalletCredit).not.toHaveBeenCalled();
  });

  it('records a partial refund with the reduced split and credits the customer', async () => {
    const result = await refund(500_000);

    expect(tx.payment.updateMany.mock.calls[0][0].data).toMatchObject({
      status: 'COMPLETED',
      refundAmount: 5_000,
      providerPayout: 4_650,
      commission: 350,
      refundedVia: 'DISPUTE',
      refundedBy: 'admin-1',
    });
    expect(applyWalletCredit).toHaveBeenCalledWith(client, expect.objectContaining({
      walletId: 'wallet-customer',
      amount: 500_000,
      source: 'REFUND',
      reference: 'RFD_pay-1',
      bookingId,
      paymentId: 'pay-1',
    }));
    expect(result).toMatchObject({
      refundKobo: 500_000,
      isFullRefund: false,
      totalRefundedKobo: 500_000,
      remainingKobo: 500_000,
      providerPayoutKobo: 465_000,
      customerUserId: 'customer-1',
    });
  });

  it('marks a full refund REFUNDED', async () => {
    const result = await refund();

    expect(tx.payment.updateMany.mock.calls[0][0].data).toMatchObject({ status: 'REFUNDED', refundAmount: 10_000, providerPayout: 0, commission: 0 });
    expect(result).toMatchObject({ refundKobo: 1_000_000, isFullRefund: true, remainingKobo: 0 });
  });

  describe('after an earlier partial refund', () => {
    const refundedAt = new Date('2026-09-10T09:00:00Z');
    // ₦4,000 of the ₦10,000 refunded; the split was reduced to the ₦6,000 kept
    const partlyRefunded = { ...payment, refundAmount: 4_000, refundedAt, commission: 420, providerPayout: 5_580 };

    beforeEach(() => {
      tx.payment.findUnique.mockResolvedValue(partlyRefunded);
    });

    it('refunds what is left when no amount is given, under a reference of its own, and marks the payment REFUNDED', async () => {
      // A customer cancelling after an admin's partial refund
      const result = await refundPaymentToWallet(client, 'wallet-customer', {
        paymentId: 'pay-1',
        reason: 'Booking cancelled by the customer',
        via: 'CANCELLATION',
      });

      // Claimed against the refund state the amount was worked out from
      expect(tx.payment.updateMany.mock.calls[0][0].where).toEqual({
        id: 'pay-1',
        status: 'COMPLETED',
        refundedAt,
        refundAmount: 4_000,
      });
      expect(tx.payment.updateMany.mock.calls[0][0].data).toMatchObject({
        status: 'REFUNDED',
        refundAmount: 10_000,
        providerPayout: 0,
        commission: 0,
        refundedVia: 'CANCELLATION',
        refundedBy: null,
      });
      expect(applyWalletCredit).toHaveBeenCalledWith(client, expect.objectContaining({
        amount: 600_000,
        source: 'REFUND',
        reference: 'RFD_pay-1_400000',
        paymentId: 'pay-1',
      }));
      expect(result).toMatchObject({
        refundKobo: 600_000,
        isFullRefund: true,
        totalRefundedKobo: 1_000_000,
        remainingKobo: 0,
        providerPayoutKobo: 0,
      });
    });

    it('refunds another part, shrinking the already reduced split in proportion', async () => {
      const result = await refund(300_000);

      expect(tx.payment.updateMany.mock.calls[0][0].data).toMatchObject({
        status: 'COMPLETED',
        refundAmount: 7_000,
        providerPayout: 2_790,
        commission: 210,
      });
      expect(applyWalletCredit).toHaveBeenCalledWith(client, expect.objectContaining({
        amount: 300_000,
        reference: 'RFD_pay-1_400000',
      }));
      expect(result).toMatchObject({ isFullRefund: false, totalRefundedKobo: 700_000, remainingKobo: 300_000 });
    });

    it('refuses more than is left', async () => {
      await expect(refund(600_001)).rejects.toMatchObject({
        message:
          'Refund amount must be more than ₦0 and no more than the ₦6,000 not yet refunded (₦4,000 of the ₦10,000 paid has already been refunded)',
        extensions: { code: 'INVALID_REFUND_AMOUNT' },
      });

      expect(tx.payment.updateMany).not.toHaveBeenCalled();
      expect(applyWalletCredit).not.toHaveBeenCalled();
    });

    it('credits nothing when a concurrent refund changed the payment first', async () => {
      tx.payment.updateMany.mockResolvedValue({ count: 0 });

      await expect(refund()).rejects.toMatchObject({ extensions: { code: 'ALREADY_REFUNDED' } });

      expect(applyWalletCredit).not.toHaveBeenCalled();
    });
  });

  it('gives each refund of the same payment a different ledger reference, derived from what was refunded before it', async () => {
    const refundedAt = new Date('2026-09-10T09:00:00Z');
    tx.payment.findUnique
      .mockResolvedValueOnce(payment)
      .mockResolvedValueOnce({ ...payment, refundAmount: 3_000, refundedAt, commission: 490, providerPayout: 6_510 })
      .mockResolvedValueOnce({ ...payment, refundAmount: 5_000, refundedAt, commission: 350, providerPayout: 4_650 });

    await refund(300_000);
    await refund(200_000);
    await refund();

    const credits = (applyWalletCredit as jest.Mock).mock.calls.map(([, entry]) => [entry.reference, entry.amount]);
    expect(credits).toEqual([
      ['RFD_pay-1', 300_000],
      ['RFD_pay-1_300000', 200_000],
      ['RFD_pay-1_500000', 500_000],
    ]);
  });
});

describe('releaseBookingPayment', () => {
  const booking = {
    id: bookingId,
    userId: 'customer-1',
    provider: { userId: 'provider-user-1' },
    service: { name: 'Deep Cleaning' },
  };

  beforeEach(() => {
    (prisma.booking.findUnique as jest.Mock).mockResolvedValue(booking);
    (prisma.$transaction as jest.Mock).mockImplementation(async (run: (tx: TransactionClient) => unknown) => run(client));
    (ensureWallet as jest.Mock).mockResolvedValue({ id: 'wallet-provider' });
    (applyWalletCredit as jest.Mock).mockResolvedValue({ id: 'txn-1' });
    tx.booking.updateMany.mockResolvedValue({ count: 1 });
    tx.payment.findUnique.mockResolvedValue({ id: 'pay-1', bookingId, status: 'COMPLETED', providerPayout: 9_300 });
    tx.payment.update.mockResolvedValue({});
  });

  it('returns null and credits nothing when the claim matches nothing', async () => {
    tx.booking.updateMany.mockResolvedValue({ count: 0 });

    await expect(releaseBookingPayment(bookingId)).resolves.toBeNull();

    expect(tx.booking.updateMany.mock.calls[0][0].where).toMatchObject({ id: bookingId, status: 'COMPLETED' });
    expect(applyWalletCredit).not.toHaveBeenCalled();
    expect(tx.payment.update).not.toHaveBeenCalled();
  });

  it('credits the provider payout in kobo and records the payout on the payment', async () => {
    const result = await releaseBookingPayment(bookingId);

    expect(applyWalletCredit).toHaveBeenCalledWith(client, expect.objectContaining({
      walletId: 'wallet-provider',
      amount: 930_000,
      source: 'SERVICE_EARNING',
      reference: 'ERN_pay-1',
      bookingId,
      paymentId: 'pay-1',
    }));

    const releasedAt = tx.booking.updateMany.mock.calls[0][0].data.paymentReleasedAt;
    expect(releasedAt).toBeInstanceOf(Date);
    expect(tx.payment.update).toHaveBeenCalledWith({
      where: { id: 'pay-1' },
      data: { payoutAt: releasedAt, withdrawableAt: releasedAt, walletTransactionId: 'txn-1' },
    });
    expect(result).toEqual({
      paymentId: 'pay-1',
      payoutKobo: 930_000,
      bookingId,
      providerUserId: 'provider-user-1',
      customerUserId: 'customer-1',
      serviceName: 'Deep Cleaning',
    });
  });

  it('credits nothing when the payout is 0', async () => {
    tx.payment.findUnique.mockResolvedValue({ id: 'pay-1', bookingId, status: 'COMPLETED', providerPayout: 0 });

    const result = await releaseBookingPayment(bookingId);

    expect(applyWalletCredit).not.toHaveBeenCalled();
    expect(tx.payment.update.mock.calls[0][0].data).toEqual({ payoutAt: expect.any(Date), withdrawableAt: expect.any(Date) });
    expect(result).toMatchObject({ paymentId: 'pay-1', payoutKobo: 0 });
  });

  it('throws inside the transaction when the payment isn’t completed, so the claim is undone', async () => {
    tx.payment.findUnique.mockResolvedValue({ id: 'pay-1', bookingId, status: 'REFUNDED', providerPayout: 0 });

    await expect(releaseBookingPayment(bookingId)).rejects.toThrow('has no completed payment to release');

    // The error leaves the transaction callback, which aborts the transaction
    // and with it the claim
    expect(tx.booking.updateMany).toHaveBeenCalledTimes(1);
    await expect((prisma.$transaction as jest.Mock).mock.results[0].value).rejects.toThrow('has no completed payment');
    expect(applyWalletCredit).not.toHaveBeenCalled();
    expect(tx.payment.update).not.toHaveBeenCalled();
  });
});
