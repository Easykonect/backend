/**
 * Settling a dispute after an admin already refunded part of the payment: the
 * refund is measured against what is left, refunding all of it cancels the
 * booking, and asking for more is refused before any money moves. Escrow is
 * mocked here; its own tests cover how the refund is recorded.
 */

jest.mock('@/lib/prisma', () => ({
  __esModule: true,
  default: {
    dispute: { findUnique: jest.fn(), findUniqueOrThrow: jest.fn() },
    wallet: { findUnique: jest.fn(), create: jest.fn() },
    $transaction: jest.fn(),
  },
}));
jest.mock('@/services/escrow.service', () => ({
  ...jest.requireActual('@/services/escrow.service'),
  refundPaymentToWallet: jest.fn(),
}));
jest.mock('@/services/notification.service', () => ({
  createNotification: jest.fn(),
  createBulkNotifications: jest.fn(),
}));
jest.mock('@/services/push.service', () => ({ sendPushToUser: jest.fn() }));
jest.mock('@/services/audit.service', () => ({ createAuditLog: jest.fn() }));

import prisma from '@/lib/prisma';
import { refundPaymentToWallet } from '@/services/escrow.service';
import { createNotification } from '@/services/notification.service';
import { resolveDispute } from '@/services/dispute.service';

const customerId = '66e2c0a1f0a9d83b5c7e4a01';
const providerUserId = '66e2c0a1f0a9d83b5c7e4a02';
const adminId = '66e2c0a1f0a9d83b5c7e4a03';
const disputeId = '66e2c0a1f0a9d83b5c7e4a04';
const bookingId = '66e2c0a1f0a9d83b5c7e4a05';
const paymentId = '66e2c0a1f0a9d83b5c7e4a06';
const walletId = '66e2c0a1f0a9d83b5c7e4a07';

const refund = refundPaymentToWallet as jest.Mock;

// ₦5,000 paid; an admin already refunded ₦2,000, leaving ₦3,000
const partlyRefundedPayment = {
  id: paymentId,
  bookingId,
  amount: 5000,
  commission: 210,
  providerPayout: 2790,
  status: 'COMPLETED',
  refundAmount: 2000,
  refundedAt: new Date('2026-09-09T12:00:00.000Z'),
};

const completedAt = new Date('2026-09-08T16:00:00.000Z');

const openDispute = {
  id: disputeId,
  bookingId,
  status: 'OPEN',
  previousBookingStatus: 'COMPLETED',
  booking: {
    id: bookingId,
    userId: customerId,
    status: 'DISPUTED',
    completedAt,
    paymentReleasedAt: null,
    payment: partlyRefundedPayment,
    service: { name: 'Deep Cleaning' },
    provider: { userId: providerUserId },
  },
};

const settled = (fields: Record<string, unknown>) => ({
  id: disputeId,
  reason: 'Service was not delivered',
  description: 'The provider never arrived at the address.',
  evidence: [],
  status: 'RESOLVED',
  raisedByRole: 'SERVICE_USER',
  resolvedAt: new Date(),
  createdAt: new Date(),
  updatedAt: new Date(),
  booking: null,
  ...fields,
});

const tx = {
  dispute: { updateMany: jest.fn() },
  booking: { update: jest.fn() },
};

beforeEach(() => {
  jest.resetAllMocks();
  (prisma.dispute.findUnique as jest.Mock).mockResolvedValue(openDispute);
  (prisma.wallet.findUnique as jest.Mock).mockResolvedValue({ id: walletId, userId: customerId, balance: 0 });
  (prisma.$transaction as jest.Mock).mockImplementation(async (run: (client: typeof tx) => Promise<unknown>) => run(tx));
  tx.dispute.updateMany.mockResolvedValue({ count: 1 });
  tx.booking.update.mockResolvedValue({});
});

it('REFUND_FULL refunds the ₦3,000 left and cancels the booking', async () => {
  refund.mockResolvedValue({ refundKobo: 300_000, isFullRefund: true, providerPayoutKobo: 0 });
  (prisma.dispute.findUniqueOrThrow as jest.Mock).mockResolvedValue(
    settled({ resolution: 'REFUND_FULL', refundAmount: 3000 })
  );

  const result = await resolveDispute(disputeId, adminId, {
    resolution: 'REFUND_FULL',
    resolutionNotes: 'Nothing was cleaned in the end',
  });

  expect(refund).toHaveBeenCalledWith(
    tx,
    walletId,
    expect.objectContaining({ paymentId, amountKobo: 300_000, via: 'DISPUTE', refundedBy: adminId })
  );
  expect(tx.dispute.updateMany).toHaveBeenCalledWith(
    expect.objectContaining({ data: expect.objectContaining({ resolution: 'REFUND_FULL', refundAmount: 3000 }) })
  );
  expect(tx.booking.update).toHaveBeenCalledWith({
    where: { id: bookingId },
    data: expect.objectContaining({ status: 'CANCELLED', cancellationReason: 'Dispute resolved with a full refund' }),
  });
  expect(createNotification).toHaveBeenCalledWith(
    expect.objectContaining({
      userId: customerId,
      message: 'The dispute for Deep Cleaning was settled with a full refund. ₦3,000 has been added to your Easykonnet wallet.',
    })
  );
  expect(result).toMatchObject({ resolution: 'REFUND_FULL', refundAmount: 3000 });
});

it('REFUND_PARTIAL within what is left refunds that amount and releases the rest', async () => {
  refund.mockResolvedValue({ refundKobo: 100_000, isFullRefund: false, providerPayoutKobo: 186_000 });
  (prisma.dispute.findUniqueOrThrow as jest.Mock).mockResolvedValue(
    settled({ resolution: 'REFUND_PARTIAL', refundAmount: 1000 })
  );

  await resolveDispute(disputeId, adminId, {
    resolution: 'REFUND_PARTIAL',
    resolutionNotes: 'One more room was left dirty',
    refundAmount: 1000,
  });

  expect(refund).toHaveBeenCalledWith(tx, walletId, expect.objectContaining({ amountKobo: 100_000 }));
  expect(tx.booking.update).toHaveBeenCalledWith({
    where: { id: bookingId },
    data: { status: 'COMPLETED', completedAt, paymentReleaseAt: expect.any(Date) },
  });
});

it.each([
  ['REFUND_FULL', 5000, 'A full refund is the ₦3,000 not yet refunded (₦2,000 of the ₦5,000 paid was refunded earlier). Leave the amount empty, or choose a partial refund.'],
  ['REFUND_PARTIAL', 3000, 'A partial refund must be more than ₦0 and less than the ₦3,000 not yet refunded (₦2,000 of the ₦5,000 paid was refunded earlier)'],
  ['MUTUAL_AGREEMENT', 3000.01, 'The agreed refund must be between ₦0 and the ₦3,000 not yet refunded (₦2,000 of the ₦5,000 paid was refunded earlier)'],
])('%s of ₦%p is refused before any money moves', async (resolution, refundAmount, message) => {
  await expect(
    resolveDispute(disputeId, adminId, { resolution, resolutionNotes: 'Settled after the phone call', refundAmount })
  ).rejects.toMatchObject({ message, extensions: { code: 'INVALID_REFUND_AMOUNT' } });

  expect(prisma.wallet.findUnique).not.toHaveBeenCalled();
  expect(prisma.$transaction).not.toHaveBeenCalled();
  expect(refund).not.toHaveBeenCalled();
});

it('an agreed refund of exactly what is left cancels the booking', async () => {
  refund.mockResolvedValue({ refundKobo: 300_000, isFullRefund: true, providerPayoutKobo: 0 });
  (prisma.dispute.findUniqueOrThrow as jest.Mock).mockResolvedValue(
    settled({ resolution: 'MUTUAL_AGREEMENT', refundAmount: 3000 })
  );

  await resolveDispute(disputeId, adminId, {
    resolution: 'MUTUAL_AGREEMENT',
    resolutionNotes: 'Both agreed to a refund of the rest',
    refundAmount: 3000,
  });

  expect(refund).toHaveBeenCalledWith(tx, walletId, expect.objectContaining({ amountKobo: 300_000 }));
  expect(tx.booking.update).toHaveBeenCalledWith(
    expect.objectContaining({ data: expect.objectContaining({ status: 'CANCELLED' }) })
  );
});
