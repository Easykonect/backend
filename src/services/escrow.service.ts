/**
 * Escrow Service
 *
 * Moves the money held for a booking:
 * - Refunds go to the customer's wallet, only while the provider hasn't been
 *   paid. A payment can be refunded in parts until the whole amount has been
 *   refunded; only a fully refunded payment is "already refunded".
 * - A partial refund reduces the provider's share in proportion: they receive
 *   the part that wasn't refunded, minus the commission rate charged on the
 *   payment.
 * - Release credits the provider's share to their wallet once the payment is
 *   due (see RELEASE_DELAY_HOURS / AUTO_RELEASE_DAYS).
 *
 * Every function that moves money writes the booking document in the same
 * transaction, so concurrent changes to one booking (a cancellation and a
 * payment, a refund and a release) can't both commit.
 */

import { GraphQLError } from 'graphql';
import type { Prisma } from '@prisma/client';
import prisma from '@/lib/prisma';
import { withTransaction, type TransactionClient } from '@/lib/transaction';
import { AUTO_RELEASE_DAYS, BookingStatus, LedgerReference, PaymentStatus } from '@/constants';
import { applyWalletCredit, ensureWallet, koboToNaira, nairaToKobo } from './wallet.service';

// ==========================================
// Types
// ==========================================

export type RefundChannel = 'DISPUTE' | 'CANCELLATION' | 'MANUAL';

interface RefundToWalletInput {
  paymentId: string;
  amountKobo?: number; // Omit to refund everything not yet refunded
  reason: string;
  via: RefundChannel;
  refundedBy?: string; // Admin who issued it
}

const DAY_MS = 24 * 60 * 60 * 1000;

// ==========================================
// Refunds
// ==========================================

/**
 * How a payment splits after part of it is refunded (all amounts in kobo).
 * `amountKobo` and `providerPayoutKobo` are what's kept and the provider's
 * share before this refund: the amount paid and the original share for a
 * first refund, less earlier refunds for a later one.
 */
export const splitAfterRefund = (amountKobo: number, providerPayoutKobo: number, refundKobo: number) => {
  const keptKobo = amountKobo - refundKobo;
  const payoutKobo = amountKobo > 0 ? Math.round((providerPayoutKobo * keptKobo) / amountKobo) : 0;

  return {
    keptKobo,
    providerPayoutKobo: payoutKobo,
    commissionKobo: keptKobo - payoutKobo,
  };
};

type RefundState = { amount: number; refundAmount?: number | null; refundedAt?: Date | null };

/**
 * Kobo refunded from a payment so far. `refundAmount` is the running total; a
 * refund recorded without one (before amounts were stored) counts as the whole
 * payment.
 */
export const refundedSoFarKobo = (payment: RefundState): number => {
  const amountKobo = nairaToKobo(payment.amount);

  if (payment.refundAmount != null) return Math.min(nairaToKobo(payment.refundAmount), amountKobo);
  return payment.refundedAt ? amountKobo : 0;
};

/**
 * Kobo that can still be refunded from a payment
 */
export const refundableKobo = (payment: RefundState): number =>
  nairaToKobo(payment.amount) - refundedSoFarKobo(payment);

/**
 * Refund a completed payment to the customer's wallet inside the caller's
 * transaction: `amountKobo`, or everything not yet refunded. `walletId` is the
 * customer's wallet (create it with ensureWallet before the transaction). The
 * caller also updates the booking.
 */
export const refundPaymentToWallet = async (
  tx: TransactionClient,
  walletId: string,
  input: RefundToWalletInput
) => {
  const payment = await tx.payment.findUnique({
    where: { id: input.paymentId },
    include: { booking: true },
  });

  if (!payment) {
    throw new GraphQLError('Payment not found', {
      extensions: { code: 'PAYMENT_NOT_FOUND' },
    });
  }

  const amountKobo = nairaToKobo(payment.amount);
  const previousKobo = refundedSoFarKobo(payment);
  const remainingKobo = amountKobo - previousKobo;

  if (payment.status === PaymentStatus.REFUNDED || (payment.status === PaymentStatus.COMPLETED && remainingKobo <= 0)) {
    throw new GraphQLError('This payment has already been refunded', {
      extensions: { code: 'ALREADY_REFUNDED' },
    });
  }

  if (payment.status !== PaymentStatus.COMPLETED) {
    throw new GraphQLError('Only completed payments can be refunded', {
      extensions: { code: 'INVALID_PAYMENT_STATUS' },
    });
  }

  if (payment.booking.paymentReleasedAt) {
    throw new GraphQLError(
      'The provider has already been paid for this booking, so it can no longer be refunded from escrow',
      { extensions: { code: 'PAYMENT_ALREADY_RELEASED' } }
    );
  }

  const refundKobo = input.amountKobo ?? remainingKobo;

  if (!Number.isInteger(refundKobo) || refundKobo <= 0 || refundKobo > remainingKobo) {
    const naira = (kobo: number) => `₦${koboToNaira(kobo).toLocaleString()}`;
    throw new GraphQLError(
      previousKobo === 0
        ? `Refund amount must be more than ₦0 and no more than the ${naira(amountKobo)} paid`
        : `Refund amount must be more than ₦0 and no more than the ${naira(remainingKobo)} not yet refunded (${naira(previousKobo)} of the ${naira(amountKobo)} paid has already been refunded)`,
      { extensions: { code: 'INVALID_REFUND_AMOUNT' } }
    );
  }

  const totalRefundedKobo = previousKobo + refundKobo;
  const isFullRefund = totalRefundedKobo === amountKobo;
  // The payment's split already reflects earlier refunds
  const split = splitAfterRefund(remainingKobo, nairaToKobo(payment.providerPayout), refundKobo);

  // Claim the refund against the state it was worked out from: a concurrent
  // refund of the same payment makes this match nothing
  const { count } = await tx.payment.updateMany({
    where: {
      id: payment.id,
      status: PaymentStatus.COMPLETED,
      ...(payment.refundedAt
        ? { refundedAt: payment.refundedAt, refundAmount: payment.refundAmount }
        : { OR: [{ refundedAt: null }, { refundedAt: { isSet: false } }] }),
    },
    data: {
      status: isFullRefund ? PaymentStatus.REFUNDED : PaymentStatus.COMPLETED,
      // Running total; the reason, channel, admin and time are the latest refund's
      refundAmount: koboToNaira(totalRefundedKobo),
      refundReason: input.reason,
      refundedBy: input.refundedBy ?? null,
      refundedVia: input.via,
      refundedAt: new Date(),
      providerPayout: koboToNaira(split.providerPayoutKobo),
      commission: koboToNaira(split.commissionKobo),
    },
  });

  if (count === 0) {
    throw new GraphQLError('This payment has already been refunded', {
      extensions: { code: 'ALREADY_REFUNDED' },
    });
  }

  const transaction = await applyWalletCredit(tx, {
    walletId,
    amount: refundKobo,
    source: 'REFUND',
    description: `Refund for booking #${payment.bookingId.slice(-8)}: ${input.reason}`,
    reference: LedgerReference.refund(payment.id, previousKobo),
    bookingId: payment.bookingId,
    paymentId: payment.id,
  });

  return {
    refundKobo,
    // Nothing is left to refund: the payment is now REFUNDED
    isFullRefund,
    totalRefundedKobo,
    remainingKobo: amountKobo - totalRefundedKobo,
    providerPayoutKobo: split.providerPayoutKobo,
    transaction,
    bookingId: payment.bookingId,
    customerUserId: payment.booking.userId,
  };
};

// ==========================================
// Release
// ==========================================

/**
 * Bookings whose payment is due to be released: completed, not yet released,
 * and either past the release time set at confirmation or completed long
 * enough ago without a confirmation
 */
const releaseDue = (now: Date): Prisma.BookingWhereInput => ({
  status: BookingStatus.COMPLETED,
  AND: [
    { OR: [{ paymentReleasedAt: null }, { paymentReleasedAt: { isSet: false } }] },
    {
      OR: [
        { paymentReleaseAt: { lte: now } },
        {
          AND: [
            { OR: [{ paymentReleaseAt: null }, { paymentReleaseAt: { isSet: false } }] },
            { completedAt: { lte: new Date(now.getTime() - AUTO_RELEASE_DAYS * DAY_MS) } },
          ],
        },
      ],
    },
  ],
});

/**
 * IDs of paid bookings due for release, oldest first
 */
export const findBookingsDueForRelease = async (limit = 100): Promise<string[]> => {
  const bookings = await prisma.booking.findMany({
    where: {
      ...releaseDue(new Date()),
      payment: { is: { status: PaymentStatus.COMPLETED } },
    },
    select: { id: true },
    orderBy: { completedAt: 'asc' },
    take: limit,
  });

  return bookings.map((booking) => booking.id);
};

/**
 * Release a booking's payment to the provider's wallet. Returns null when the
 * booking isn't due, including when another run has just released it.
 */
export const releaseBookingPayment = async (bookingId: string) => {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: {
      provider: { select: { userId: true } },
      service: { select: { name: true } },
    },
  });

  if (!booking) return null;

  const wallet = await ensureWallet(booking.provider.userId);
  const now = new Date();

  const released = await withTransaction(async (tx) => {
    // Claim the booking; a concurrent run's claim matches nothing
    const { count } = await tx.booking.updateMany({
      where: { id: bookingId, ...releaseDue(now) },
      data: { paymentReleasedAt: now },
    });

    if (count === 0) return null;

    const payment = await tx.payment.findUnique({ where: { bookingId } });

    if (!payment || payment.status !== PaymentStatus.COMPLETED) {
      // Undoes the claim
      throw new Error(`Booking ${bookingId} has no completed payment to release`);
    }

    const payoutKobo = nairaToKobo(payment.providerPayout);

    const transaction = payoutKobo > 0
      ? await applyWalletCredit(tx, {
          walletId: wallet.id,
          amount: payoutKobo,
          source: 'SERVICE_EARNING',
          description: `Earnings from booking #${bookingId.slice(-8)}`,
          reference: LedgerReference.earning(payment.id),
          bookingId,
          paymentId: payment.id,
        })
      : null;

    await tx.payment.update({
      where: { id: payment.id },
      data: {
        payoutAt: now,
        withdrawableAt: now,
        ...(transaction ? { walletTransactionId: transaction.id } : {}),
      },
    });

    return { paymentId: payment.id, payoutKobo };
  });

  if (!released) return null;

  return {
    ...released,
    bookingId,
    providerUserId: booking.provider.userId,
    customerUserId: booking.userId,
    serviceName: booking.service.name,
  };
};
