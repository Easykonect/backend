/**
 * Payment Service
 *
 * Handles all payment-related business logic for Easykonnet.
 *
 * Payment Flow:
 * 1. Customer books a service → Booking created with PENDING status
 * 2. Provider accepts → status: ACCEPTED
 * 3. Customer pays through Paystack or from their wallet → Payment COMPLETED,
 *    money held in escrow. The booking stays ACCEPTED.
 * 4. Provider starts the service (IN_PROGRESS), then completes it (COMPLETED)
 * 5. Customer confirms delivery. The provider's share is released to their
 *    wallet RELEASE_DELAY_HOURS later, or AUTO_RELEASE_DAYS after completion if
 *    the customer never confirms (see escrow.service)
 *
 * Commission:
 * - booking.commission, fixed when the booking is created at the rate a Super
 *   Admin sets (COMMISSION_RATE until one is set)
 * - Provider payout: the amount paid minus that commission
 *
 * Refunds go to the customer's wallet (see escrow.service). A Paystack charge
 * that can't be applied to its booking (the booking was cancelled, or was
 * already paid) is credited to the customer's wallet too.
 */

import { AdminAction, Prisma } from '@prisma/client';
import prisma from '@/lib/prisma';
import {
  paystack,
  generateTransactionReference,
  nairaToKobo,
  koboToNaira,
  verifyWebhookSignature,
  PaystackRequestError,
  type PaystackInitializeResponse,
  type PaystackVerifyResponse,
  type PaystackWebhookEvent,
} from '@/lib/paystack';
import { GraphQLError } from 'graphql';
import { config } from '@/config';
import { BookingStatus, LedgerReference, NotificationType, PaymentStatus, UserRole } from '@/constants';
import { createNotification, createBulkNotifications } from '@/services/notification.service';
import { sendPushToUser } from '@/services/push.service';
import { capturePaymentError, addBreadcrumb, captureException } from '@/lib/sentry';
import { withTransaction } from '@/lib/transaction';
import RedisClient from '@/lib/redis';
import { isAllowedCallbackUrl, isAllowedReturnLink } from '@/lib/return-link';
import { isRestrictionActive } from '@/utils/security';
import {
  applyWalletCredit,
  applyWalletDebit,
  ensureWallet,
  formatTransaction,
  MAX_SINGLE_TRANSACTION_KOBO,
} from '@/services/wallet.service';
import { refundPaymentToWallet } from '@/services/escrow.service';
import { getCommissionRate, toPercent } from '@/services/platform-settings.service';
import { createAuditLog } from '@/services/audit.service';

// ==========================================
// Types
// ==========================================

interface InitializePaymentInput {
  bookingId: string;
  callbackUrl?: string;
  returnDeepLink?: string;
}

interface PaymentFilters {
  status?: string;
  startDate?: string;
  endDate?: string;
}

interface PaginationInput {
  page: number;
  limit: number;
}

interface RefundInput {
  paymentId: string;
  amount?: number | null; // Optional partial refund amount in Naira
  reason: string;
}

interface Requester {
  userId: string;
  role: string;
}

const ADMIN_ROLES: string[] = [UserRole.ADMIN, UserRole.SUPER_ADMIN];

const paymentDetailsInclude = {
  booking: {
    include: {
      user: true,
      provider: {
        include: {
          user: true,
        }
      },
      service: true,
    }
  }
} satisfies Prisma.PaymentInclude;

// ==========================================
// Helper Functions
// ==========================================

/**
 * Get payment by ID with booking details
 */
const getPaymentWithDetails = async (paymentId: string) => {
  const payment = await prisma.payment.findUnique({
    where: { id: paymentId },
    include: paymentDetailsInclude,
  });

  if (!payment) {
    throw new GraphQLError('Payment not found', {
      extensions: { code: 'PAYMENT_NOT_FOUND' }
    });
  }

  return payment;
};

/**
 * Find a payment by any Paystack reference issued for it. Reopening checkout
 * issues a new reference, and the customer may still pay on an older one.
 */
const findPaymentByReference = (reference: string) =>
  prisma.payment.findFirst({
    where: {
      OR: [{ transactionRef: reference }, { transactionRefs: { has: reference } }],
    },
    include: paymentDetailsInclude,
  });

const isUniqueViolation = (error: unknown) =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';

/**
 * Customers see their own payments, providers the payments for their
 * bookings, admins all of them
 */
const canViewPayment = (
  booking: { userId: string; provider?: { userId: string } | null },
  requester: Requester
) =>
  ADMIN_ROLES.includes(requester.role) ||
  booking.userId === requester.userId ||
  booking.provider?.userId === requester.userId;

/**
 * The split recorded on a payment: the commission fixed on the booking when
 * it was created, and the rest for the provider
 */
const paymentSplit = (booking: { totalAmount: number; commission: number }) => {
  const amountKobo = nairaToKobo(booking.totalAmount);
  const commissionKobo = Math.min(nairaToKobo(booking.commission), amountKobo);

  return {
    amountKobo,
    commission: koboToNaira(commissionKobo),
    providerPayout: koboToNaira(amountKobo - commissionKobo),
  };
};

/**
 * Tell every active admin about a payment that needs manual action
 */
const alertAdmins = async (title: string, message: string, metadata: Record<string, unknown>) => {
  captureException(new Error(title), { tags: { area: 'payments' }, extra: { message, ...metadata } });

  try {
    const admins = await prisma.user.findMany({
      where: { role: { in: ['ADMIN', 'SUPER_ADMIN'] }, status: 'ACTIVE' },
      select: { id: true },
    });
    await createBulkNotifications(
      admins.map((admin) => admin.id),
      NotificationType.SYSTEM_ANNOUNCEMENT,
      title,
      message,
      'payment',
      undefined,
      metadata
    );
  } catch (error) {
    console.error('Failed to alert admins about a payment:', error);
  }
};

// A charge that can't be matched to a payment won't succeed on redelivery
const PERMANENT_WEBHOOK_ERRORS = new Set([
  'PAYMENT_NOT_FOUND',
  'AMOUNT_MISMATCH',
]);

/**
 * Format payment response for GraphQL
 */
const formatPaymentResponse = (payment: any) => {
  return {
    id: payment.id,
    bookingId: payment.bookingId,
    amount: payment.amount,
    commission: payment.commission,
    providerPayout: payment.providerPayout,
    paystackFee: payment.paystackFee || 0,
    status: payment.status,
    paymentMethod: payment.paymentMethod,
    transactionRef: payment.transactionRef,
    paidAt: payment.paidAt?.toISOString() || null,
    refundedAt: payment.refundedAt?.toISOString() || null,
    payoutAt: payment.payoutAt?.toISOString() || null,
    refundAmount: payment.refundAmount || null,
    refundReason: payment.refundReason || null,
    refundedVia: payment.refundedVia || null,
    createdAt: payment.createdAt.toISOString(),
    updatedAt: payment.updatedAt.toISOString(),
    booking: payment.booking ? {
      id: payment.booking.id,
      status: payment.booking.status,
      scheduledDate: payment.booking.scheduledDate,
      service: payment.booking.service,
      user: payment.booking.user,
      provider: payment.booking.provider,
    } : undefined,
  };
};

/**
 * Send notification helper — writes an in-app notification row AND fires a
 * push notification. Both failures are swallowed so the calling payment
 * flow is never rolled back by a flaky downstream service.
 */
const sendNotification = async (
  userId: string,
  type: string,
  title: string,
  message: string,
  metadata?: Record<string, any>
) => {
  try {
    await createNotification({
      userId,
      type,
      title,
      message,
      metadata,
    });
  } catch (error) {
    console.error('Failed to send notification:', error);
  }

  try {
    await sendPushToUser(userId, {
      title,
      message,
      data: { type, ...(metadata ?? {}) },
    });
  } catch (error) {
    console.error('Failed to send push:', error);
  }
};

const formatNaira = (kobo: number) => `₦${koboToNaira(kobo).toLocaleString()}`;

// A payment that has taken its money: paid, or paid and since refunded
const isSettled = (status: string) =>
  status === PaymentStatus.COMPLETED || status === PaymentStatus.REFUNDED;

/**
 * Verification result for a charge that was already applied to its payment
 */
const alreadyApplied = (payment: Awaited<ReturnType<typeof getPaymentWithDetails>>) => ({
  payment: formatPaymentResponse(payment),
  verified: payment.status === PaymentStatus.COMPLETED,
  message: payment.status === PaymentStatus.COMPLETED
    ? 'Payment already verified and completed'
    : 'This payment has been refunded',
});

// ==========================================
// Payment Initialization
// ==========================================

/**
 * Save a new checkout reference on the booking's payment. Earlier references
 * are kept, since the customer may still pay on an older checkout. A payment
 * that completed in the meantime is never reopened.
 */
const recordCheckout = async (
  bookingId: string,
  existing: { transactionRef: string | null; transactionRefs: string[] } | null,
  reference: string,
  split: { amount: number; commission: number; providerPayout: number }
) => {
  if (!existing) {
    try {
      return await prisma.payment.create({
        data: {
          bookingId,
          ...split,
          status: PaymentStatus.PENDING,
          transactionRef: reference,
          transactionRefs: [reference],
        },
      });
    } catch (error) {
      // A concurrent request created it; add this reference below
      if (!isUniqueViolation(error)) throw error;
    }
  }

  // Payments from before every reference was tracked only have transactionRef
  const untracked =
    existing?.transactionRef && !existing.transactionRefs.includes(existing.transactionRef)
      ? [existing.transactionRef]
      : [];

  const { count } = await prisma.payment.updateMany({
    where: {
      bookingId,
      // Every unpaid status. Nothing sets PROCESSING today, but the enum value
      // stays for API compatibility, and a payment carrying it is still unpaid.
      status: { in: [PaymentStatus.PENDING, PaymentStatus.PROCESSING, PaymentStatus.FAILED] },
    },
    data: {
      ...split,
      status: PaymentStatus.PENDING,
      transactionRef: reference,
      transactionRefs: { push: [...untracked, reference] },
    },
  });

  if (count === 0) {
    throw new GraphQLError('Payment has already been completed for this booking', {
      extensions: { code: 'PAYMENT_ALREADY_COMPLETED' }
    });
  }

  return prisma.payment.findUniqueOrThrow({ where: { bookingId } });
};

/**
 * Initialize payment for a booking
 * Creates a Paystack payment link for the customer
 */
export const initializePayment = async (
  userId: string,
  input: InitializePaymentInput
) => {
  const { bookingId, callbackUrl, returnDeepLink } = input;

  if (returnDeepLink && !isAllowedReturnLink(returnDeepLink)) {
    throw new GraphQLError('returnDeepLink must be a link into the Easykonnet app', {
      extensions: { code: 'INVALID_RETURN_LINK' }
    });
  }

  // callbackUrl is only used without returnDeepLink, so only checked then
  if (!returnDeepLink && callbackUrl && !isAllowedCallbackUrl(callbackUrl)) {
    throw new GraphQLError('callbackUrl must be a page on the Easykonnet website', {
      extensions: { code: 'INVALID_RETURN_LINK' }
    });
  }

  // Get booking with user details
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: {
      user: true,
      service: true,
      provider: true,
      payment: true,
    }
  });

  if (!booking) {
    throw new GraphQLError('Booking not found', {
      extensions: { code: 'BOOKING_NOT_FOUND' }
    });
  }

  // Verify user owns this booking
  if (booking.userId !== userId) {
    throw new GraphQLError('You can only pay for your own bookings', {
      extensions: { code: 'UNAUTHORIZED' }
    });
  }

  // Check booking status - must be ACCEPTED (provider accepted the job)
  if (booking.status !== BookingStatus.ACCEPTED) {
    throw new GraphQLError(
      `Cannot pay for booking with status: ${booking.status}. Booking must be accepted by the provider first.`,
      { extensions: { code: 'INVALID_BOOKING_STATUS' } }
    );
  }

  // Check if payment already exists and is completed
  if (booking.payment && booking.payment.status === PaymentStatus.COMPLETED) {
    throw new GraphQLError('Payment has already been completed for this booking', {
      extensions: { code: 'PAYMENT_ALREADY_COMPLETED' }
    });
  }

  if (isRestrictionActive(booking.user)) {
    throw new GraphQLError('Your account is restricted, so you can’t make payments right now.', {
      extensions: { code: 'ACCOUNT_RESTRICTED' }
    });
  }

  // Calculate amounts
  const { amountKobo, commission, providerPayout } = paymentSplit(booking);

  // Generate transaction reference
  const reference = generateTransactionReference();

  // Resolve the callback URL Paystack will redirect to after checkout.
  // - Native app flow: caller sets returnDeepLink. We force Paystack to land
  //   on our HTTPS bridge route, which then bounces to the deep link. This is
  //   required because Paystack's hosted checkout cannot navigate browsers
  //   directly to non-http(s) schemes.
  // - Web/legacy flow: caller passes a fully-formed HTTPS callbackUrl.
  // - Fallback: FRONTEND_URL/payment/callback.
  let resolvedCallbackUrl: string;
  if (returnDeepLink) {
    if (!config.platform.backendUrl) {
      console.warn(
        '⚠️ BACKEND_URL is not set: the Paystack callback bridge falls back to FRONTEND_URL, so mobile checkouts land on the website instead of returning to the app.'
      );
    }
    const base = config.platform.backendUrl || config.platform.frontendUrl;
    resolvedCallbackUrl = `${base}/api/payments/paystack/callback`;
  } else if (callbackUrl) {
    resolvedCallbackUrl = callbackUrl;
  } else {
    resolvedCallbackUrl = `${config.platform.frontendUrl}/payment/callback`;
  }

  const paystackFailure = (error: Error) => {
    capturePaymentError(error, {
      bookingId: booking.id,
      amount: koboToNaira(amountKobo),
      userId: booking.userId,
      transactionRef: reference,
      provider: 'paystack',
    });
    return new GraphQLError('Failed to initialize payment with Paystack', {
      extensions: { code: 'PAYSTACK_ERROR' }
    });
  };

  // Initialize Paystack transaction. An error answer, a timeout or a network
  // failure is PAYSTACK_ERROR: nothing has been saved and the customer can retry.
  let paystackResponse: PaystackInitializeResponse;
  try {
    paystackResponse = await paystack.initializeTransaction({
      email: booking.user.email,
      amount: amountKobo,
      reference,
      callback_url: resolvedCallbackUrl,
      metadata: {
        bookingId: booking.id,
        userId: booking.userId,
        providerId: booking.providerId,
        serviceId: booking.serviceId,
        // Stored on the Paystack transaction so the bridge route can recover it
        // from /transaction/verify without holding state on the backend.
        returnDeepLink: returnDeepLink || null,
        custom_fields: [
          {
            display_name: 'Booking ID',
            variable_name: 'booking_id',
            value: booking.id,
          },
          {
            display_name: 'Service',
            variable_name: 'service_name',
            value: booking.service.name,
          }
        ]
      },
      channels: ['card', 'bank', 'ussd', 'bank_transfer'],
    });
  } catch (error) {
    if (!(error instanceof PaystackRequestError)) throw error;
    throw paystackFailure(error);
  }

  if (!paystackResponse.status) {
    throw paystackFailure(new Error('Paystack declined to initialize the transaction'));
  }

  // Add breadcrumb for successful initialization
  addBreadcrumb({
    message: `Payment initialized for booking ${booking.id}`,
    category: 'payment',
    level: 'info',
    data: { bookingId: booking.id, amount: koboToNaira(amountKobo), reference },
  });

  const payment = await recordCheckout(booking.id, booking.payment, reference, {
    amount: koboToNaira(amountKobo),
    commission,
    providerPayout,
  });

  return {
    payment: formatPaymentResponse(payment),
    authorizationUrl: paystackResponse.data.authorization_url,
    accessCode: paystackResponse.data.access_code,
    reference: paystackResponse.data.reference,
  };
};

// ==========================================
// Payment Verification
// ==========================================

type ChargeOutcome =
  | { kind: 'already' }
  | { kind: 'completed' }
  | { kind: 'duplicate' | 'unapplied'; creditedNow: boolean };

/**
 * Apply a successful Paystack charge. If its booking can't take it (the
 * booking was cancelled or disputed, or was already paid on another checkout)
 * the amount is credited to the customer's wallet instead, once per charge.
 */
const applySuccessfulCharge = async (
  payment: { id: string; bookingId: string; booking: { userId: string } },
  transactionRef: string,
  data: PaystackVerifyResponse['data']
): Promise<ChargeOutcome> => {
  // Created before the transaction: a failed create would abort it
  const wallet = await ensureWallet(payment.booking.userId);
  const paidAt = new Date(data.paid_at || Date.now());
  const paystackFee = koboToNaira(data.fees ?? 0);
  const creditReference = LedgerReference.unappliedCharge(transactionRef);

  return withTransaction(async (tx): Promise<ChargeOutcome> => {
    const current = await tx.payment.findUnique({ where: { id: payment.id } });

    if (!current) {
      throw new GraphQLError('Payment not found for this reference', {
        extensions: { code: 'PAYMENT_NOT_FOUND' }
      });
    }

    const settled = isSettled(current.status);

    // This is the charge the payment was settled with, even if it has since
    // been refunded; crediting it again would refund it twice
    if (settled && current.transactionRef === transactionRef) {
      return { kind: 'already' };
    }

    // A charge already credited to the wallet is never applied to the booking too
    const alreadyCredited = await tx.walletTransaction.findUnique({
      where: { reference: creditReference },
    });

    if (alreadyCredited) {
      return { kind: settled ? 'duplicate' : 'unapplied', creditedNow: false };
    }

    if (!settled) {
      // Writing the booking also makes a concurrent cancellation conflict with
      // this transaction, instead of both committing
      const { count } = await tx.booking.updateMany({
        where: { id: current.bookingId, status: BookingStatus.ACCEPTED },
        data: { updatedAt: new Date() },
      });

      if (count === 1) {
        await tx.payment.update({
          where: { id: current.id },
          data: {
            status: PaymentStatus.COMPLETED,
            // The reference that was actually charged
            transactionRef,
            paymentMethod: data.channel,
            paidAt,
            paystackFee,
          },
        });
        return { kind: 'completed' };
      }
    }

    await applyWalletCredit(tx, {
      walletId: wallet.id,
      amount: data.amount,
      source: 'REFUND',
      description: settled
        ? `Refund of a second payment for booking #${current.bookingId.slice(-8)}`
        : `Refund of a payment for booking #${current.bookingId.slice(-8)}, which could no longer be paid for`,
      reference: creditReference,
      bookingId: current.bookingId,
      paymentId: current.id,
    });

    return { kind: settled ? 'duplicate' : 'unapplied', creditedNow: true };
  });
};

/**
 * Record a charge Paystack reports as not (yet) successful
 */
const recordUnsuccessfulCharge = async (
  payment: Awaited<ReturnType<typeof getPaymentWithDetails>>,
  transactionRef: string,
  data: PaystackVerifyResponse['data']
) => {
  const result = {
    payment: formatPaymentResponse(payment),
    verified: false,
    message: `Payment ${data.status}: ${data.gateway_response}`,
  };

  // An older checkout that wasn't paid says nothing about the current one
  if (payment.transactionRef !== transactionRef) {
    return result;
  }

  const failed = data.status === 'failed';

  // Only an open payment changes, so a repeated check doesn't notify again
  const { count } = await prisma.payment.updateMany({
    where: {
      id: payment.id,
      transactionRef,
      status: { in: [PaymentStatus.PENDING, PaymentStatus.PROCESSING] },
    },
    data: {
      status: failed ? PaymentStatus.FAILED : PaymentStatus.PENDING,
      paymentMethod: data.channel,
    },
  });

  if (failed && count > 0) {
    await sendNotification(
      payment.booking.userId,
      NotificationType.PAYMENT_FAILED,
      'Payment Failed',
      `Your payment for ${payment.booking.service.name} has failed. Please try again.`,
      { bookingId: payment.bookingId, paymentId: payment.id }
    );
  }

  return result;
};

/**
 * Verify payment status
 * Called after the customer completes checkout, by the charge webhook and by
 * the callback bridge. Pass `requester` when a user asks, to check they may.
 */
export const verifyPayment = async (transactionRef: string, requester?: Requester) => {
  const payment = await findPaymentByReference(transactionRef);

  if (!payment) {
    throw new GraphQLError('Payment not found for this reference', {
      extensions: { code: 'PAYMENT_NOT_FOUND' }
    });
  }

  if (requester && !canViewPayment(payment.booking, requester)) {
    throw new GraphQLError('You do not have permission to verify this payment', {
      extensions: { code: 'UNAUTHORIZED' }
    });
  }

  // Already applied from this reference (and possibly refunded since)
  if (isSettled(payment.status) && payment.transactionRef === transactionRef) {
    return alreadyApplied(payment);
  }

  // Verify with Paystack. An error answer (such as an unknown reference), a
  // timeout or a network failure is PAYSTACK_ERROR, and nothing changes.
  let paystackResponse: PaystackVerifyResponse;
  try {
    paystackResponse = await paystack.verifyTransaction(transactionRef);
  } catch (error) {
    if (!(error instanceof PaystackRequestError)) throw error;
    capturePaymentError(error, {
      paymentId: payment.id,
      bookingId: payment.bookingId,
      transactionRef,
      provider: 'paystack',
    });
    throw new GraphQLError('Failed to verify payment with Paystack', {
      extensions: { code: 'PAYSTACK_ERROR' }
    });
  }

  if (!paystackResponse.status) {
    throw new GraphQLError('Failed to verify payment with Paystack', {
      extensions: { code: 'PAYSTACK_ERROR' }
    });
  }

  const { data } = paystackResponse;

  if (data.status !== 'success') {
    return recordUnsuccessfulCharge(payment, transactionRef, data);
  }

  // Security: the charge must be for the amount this payment expects
  const expectedAmountKobo = nairaToKobo(payment.amount);
  if (data.amount !== expectedAmountKobo || (data.currency && data.currency !== 'NGN')) {
    console.error(
      `Amount mismatch for ${transactionRef}: expected ${expectedAmountKobo} kobo, got ${data.amount} ${data.currency}`
    );
    throw new GraphQLError('Payment amount mismatch', {
      extensions: { code: 'AMOUNT_MISMATCH' }
    });
  }

  const outcome = await applySuccessfulCharge(payment, transactionRef, data);
  const serviceName = payment.booking.service.name;
  const metadata = { bookingId: payment.bookingId, paymentId: payment.id };

  if (outcome.kind === 'already') {
    return alreadyApplied(await getPaymentWithDetails(payment.id));
  }

  if (outcome.kind === 'duplicate' || outcome.kind === 'unapplied') {
    const duplicate = outcome.kind === 'duplicate';

    if (outcome.creditedNow) {
      await sendNotification(
        payment.booking.userId,
        NotificationType.REFUND_PROCESSED,
        'Payment added to your wallet',
        duplicate
          ? `Your booking for ${serviceName} was already paid, so your extra payment of ${formatNaira(data.amount)} has been added to your Easykonnet wallet.`
          : `Your booking for ${serviceName} could no longer be paid for when your payment arrived, so ${formatNaira(data.amount)} has been added to your Easykonnet wallet.`,
        metadata
      );
    }

    return {
      payment: formatPaymentResponse(await getPaymentWithDetails(payment.id)),
      verified: duplicate,
      message: duplicate
        ? `This booking was already paid. Your extra payment of ${formatNaira(data.amount)} has been added to your wallet.`
        : `This booking can no longer be paid for. Your payment of ${formatNaira(data.amount)} has been added to your wallet.`,
    };
  }

  const updatedPayment = await getPaymentWithDetails(payment.id);

  // Send notifications
  await Promise.all([
    // Notify customer
    sendNotification(
      updatedPayment.booking.userId,
      NotificationType.PAYMENT_RECEIVED,
      'Payment Successful',
      `Your payment for ${serviceName} has been received. The provider will begin service soon.`,
      metadata
    ),
    // Notify provider
    sendNotification(
      updatedPayment.booking.provider.userId,
      NotificationType.PAYMENT_RECEIVED,
      'Payment Secured',
      `Payment for ${serviceName} has been secured in escrow. You can now proceed with the service.`,
      metadata
    ),
  ]);

  return {
    payment: formatPaymentResponse(updatedPayment),
    verified: true,
    message: 'Payment verified successfully',
  };
};

// ==========================================
// Wallet Payments
// ==========================================

/**
 * Pay for an accepted booking from the customer's wallet. The amount comes
 * from the booking, never from the client.
 */
export const payWithWallet = async (userId: string, bookingId: string) => {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: {
      user: true,
      provider: true,
      service: true,
      payment: true,
    },
  });

  if (!booking) {
    throw new GraphQLError('Booking not found', {
      extensions: { code: 'BOOKING_NOT_FOUND' }
    });
  }

  if (booking.userId !== userId) {
    throw new GraphQLError('You can only pay for your own bookings', {
      extensions: { code: 'UNAUTHORIZED' }
    });
  }

  if (booking.status !== BookingStatus.ACCEPTED) {
    throw new GraphQLError(
      `Cannot pay for booking with status: ${booking.status}. Booking must be accepted by the provider first.`,
      { extensions: { code: 'INVALID_BOOKING_STATUS' } }
    );
  }

  if (booking.payment?.status === PaymentStatus.COMPLETED) {
    throw new GraphQLError('Payment has already been completed for this booking', {
      extensions: { code: 'PAYMENT_ALREADY_COMPLETED' }
    });
  }

  if (isRestrictionActive(booking.user)) {
    throw new GraphQLError('Your account is restricted, so you can’t make payments right now.', {
      extensions: { code: 'ACCOUNT_RESTRICTED' }
    });
  }

  const { amountKobo, commission, providerPayout } = paymentSplit(booking);

  if (amountKobo > MAX_SINGLE_TRANSACTION_KOBO) {
    throw new GraphQLError(
      `Wallet payments are limited to ${formatNaira(MAX_SINGLE_TRANSACTION_KOBO)}. Please pay with card, bank transfer or USSD.`,
      { extensions: { code: 'AMOUNT_TOO_LARGE' } }
    );
  }

  const wallet = await prisma.wallet.findUnique({ where: { userId } });

  if (!wallet || wallet.balance < amountKobo) {
    throw new GraphQLError(
      `Your wallet balance is too low to pay ${formatNaira(amountKobo)}. Please pay with card, bank transfer or USSD.`,
      { extensions: { code: 'INSUFFICIENT_BALANCE' } }
    );
  }

  const reference = LedgerReference.walletPayment(bookingId);

  const { transaction, payment } = await withTransaction(async (tx) => {
    // Still ours and still waiting for payment; the write also conflicts with
    // a concurrent cancellation or card payment of this booking
    const { count } = await tx.booking.updateMany({
      where: { id: bookingId, userId, status: BookingStatus.ACCEPTED },
      data: { updatedAt: new Date() },
    });

    if (count === 0) {
      throw new GraphQLError('This booking can no longer be paid for', {
        extensions: { code: 'INVALID_BOOKING_STATUS' }
      });
    }

    const current = await tx.payment.findUnique({ where: { bookingId } });

    if (current?.status === PaymentStatus.COMPLETED || current?.status === PaymentStatus.REFUNDED) {
      throw new GraphQLError('Payment has already been completed for this booking', {
        extensions: { code: 'PAYMENT_ALREADY_COMPLETED' }
      });
    }

    const debit = await applyWalletDebit(tx, {
      walletId: wallet.id,
      amount: amountKobo,
      source: 'BOOKING_PAYMENT',
      description: `Payment for ${booking.service.name}`,
      reference,
      bookingId,
    });

    const paymentData = {
      amount: koboToNaira(amountKobo),
      commission,
      providerPayout,
      paystackFee: 0,
      status: PaymentStatus.COMPLETED,
      paymentMethod: 'wallet',
      transactionRef: reference,
      paidAt: new Date(),
    };

    // Keep open checkout references, so a card payment on one of them is
    // recognised as a second payment and returned to the wallet
    const untracked =
      current?.transactionRef && !current.transactionRefs.includes(current.transactionRef)
        ? [current.transactionRef]
        : [];

    const saved = current
      ? await tx.payment.update({
          where: { id: current.id },
          data: {
            ...paymentData,
            ...(untracked.length > 0 ? { transactionRefs: { push: untracked } } : {}),
          },
        })
      : await tx.payment.create({
          data: { bookingId, ...paymentData, transactionRefs: [] },
        });

    return { transaction: debit, payment: saved };
  });

  const metadata = { bookingId, paymentId: payment.id };

  await Promise.all([
    sendNotification(
      userId,
      NotificationType.PAYMENT_RECEIVED,
      'Payment Successful',
      `You paid ${formatNaira(amountKobo)} for ${booking.service.name} from your wallet. The provider will begin service soon.`,
      metadata
    ),
    sendNotification(
      booking.provider.userId,
      NotificationType.PAYMENT_RECEIVED,
      'Payment Secured',
      `Payment for ${booking.service.name} has been secured in escrow. You can now proceed with the service.`,
      metadata
    ),
  ]);

  return {
    success: true,
    message: 'Payment successful',
    remainingBalance: koboToNaira(transaction.balanceAfter),
    transaction: formatTransaction(transaction),
    payment: formatPaymentResponse(payment),
  };
};

// ==========================================
// Refund Processing
// ==========================================

/**
 * Refund a payment to the customer's wallet (Super Admin)
 * Omit `amount` to refund everything not yet refunded. A payment can be
 * refunded in parts. Once it's fully refunded, an accepted or started booking
 * is cancelled; a completed booking stays completed.
 */
export const processRefund = async (
  adminId: string,
  input: RefundInput,
  adminRole: string = UserRole.SUPER_ADMIN
) => {
  const { paymentId, amount } = input;
  const reason = input.reason?.trim();

  if (!reason) {
    throw new GraphQLError('Please give a reason for the refund', {
      extensions: { code: 'INVALID_INPUT' }
    });
  }

  if (amount != null && !(amount > 0)) {
    throw new GraphQLError('Refund amount must be more than ₦0', {
      extensions: { code: 'INVALID_REFUND_AMOUNT' }
    });
  }

  const payment = await getPaymentWithDetails(paymentId);

  if (payment.booking.status === BookingStatus.DISPUTED) {
    throw new GraphQLError('This booking has an open dispute. Resolve the dispute to refund it.', {
      extensions: { code: 'INVALID_BOOKING_STATUS' }
    });
  }

  const wallet = await ensureWallet(payment.booking.userId);
  const now = new Date();

  // A full refund leaves nothing to pay for a job that hasn't been done
  const cancellableByFullRefund = [BookingStatus.ACCEPTED, BookingStatus.IN_PROGRESS];

  const refund = await withTransaction(async (tx) => {
    const result = await refundPaymentToWallet(tx, wallet.id, {
      paymentId,
      amountKobo: amount != null ? nairaToKobo(amount) : undefined,
      reason,
      via: 'MANUAL',
      refundedBy: adminId,
    });

    // A full refund cancels an accepted or started booking. A completed booking
    // stays COMPLETED: the work was done, and a REFUNDED payment is never
    // released to the provider.
    const bookingCancelled = result.isFullRefund
      && (await tx.booking.updateMany({
        where: { id: payment.bookingId, status: { in: cancellableByFullRefund } },
        data: { status: BookingStatus.CANCELLED, cancelledAt: now, cancellationReason: `Refunded: ${reason}` },
      })).count === 1;

    if (!bookingCancelled) {
      // Conditional, so a dispute opened meanwhile stops the refund (the
      // transaction is undone)
      const { count } = await tx.booking.updateMany({
        where: { id: payment.bookingId, status: { not: BookingStatus.DISPUTED } },
        data: { updatedAt: now },
      });

      if (count === 0) {
        throw new GraphQLError('This booking has an open dispute. Resolve the dispute to refund it.', {
          extensions: { code: 'INVALID_BOOKING_STATUS' }
        });
      }
    }

    return { ...result, bookingCancelled };
  });

  try {
    await createAuditLog({
      action: AdminAction.PROCESS_REFUND,
      targetType: 'Payment',
      targetId: paymentId,
      performedBy: adminId,
      performedByRole: adminRole,
      previousValue: {
        status: payment.status,
        bookingStatus: payment.booking.status,
        providerPayout: payment.providerPayout,
        refundAmount: payment.refundAmount ?? 0,
      },
      newValue: {
        refundAmount: koboToNaira(refund.refundKobo),
        totalRefunded: koboToNaira(refund.totalRefundedKobo),
        providerPayout: koboToNaira(refund.providerPayoutKobo),
        bookingStatus: refund.bookingCancelled ? BookingStatus.CANCELLED : payment.booking.status,
        refundedTo: 'wallet',
      },
      reason,
    });
  } catch (error) {
    captureException(error, { tags: { area: 'payments' }, extra: { paymentId } });
  }

  const serviceName = payment.booking.service.name;
  const metadata = { bookingId: payment.bookingId, paymentId };

  await Promise.all([
    sendNotification(
      payment.booking.userId,
      NotificationType.REFUND_PROCESSED,
      'Refund added to your wallet',
      `${formatNaira(refund.refundKobo)} for ${serviceName} has been added to your Easykonnet wallet. ${reason}`,
      metadata
    ),
    sendNotification(
      payment.booking.provider.userId,
      NotificationType.REFUND_PROCESSED,
      'Booking refunded',
      !refund.isFullRefund
        ? `${formatNaira(refund.refundKobo)} of the payment for ${serviceName} was refunded to the customer. ${formatNaira(refund.providerPayoutKobo)} will be released to you.`
        : refund.bookingCancelled
          ? `The payment for ${serviceName} was refunded to the customer, and the booking was cancelled.`
          : `The payment for ${serviceName} was refunded to the customer in full, so nothing will be released to you for this booking.`,
      metadata
    ),
  ]);

  return {
    success: true,
    message: `${formatNaira(refund.refundKobo)} has been refunded to the customer's wallet`,
    payment: formatPaymentResponse(await getPaymentWithDetails(paymentId)),
  };
};

// ==========================================
// Query Functions
// ==========================================

/**
 * Get payment by ID
 */
export const getPaymentById = async (paymentId: string, requesterId: string, requesterRole: string = '') => {
  const payment = await prisma.payment.findUnique({
    where: { id: paymentId },
    include: paymentDetailsInclude,
  });

  if (!payment) {
    throw new GraphQLError('Payment not found', {
      extensions: { code: 'PAYMENT_NOT_FOUND' }
    });
  }

  // Check authorization - must be booking owner, provider, or admin
  if (!canViewPayment(payment.booking, { userId: requesterId, role: requesterRole })) {
    throw new GraphQLError('You do not have permission to view this payment', {
      extensions: { code: 'UNAUTHORIZED' }
    });
  }

  return formatPaymentResponse(payment);
};

/**
 * Get payment by booking ID
 */
export const getPaymentByBookingId = async (bookingId: string, requester: Requester) => {
  const payment = await prisma.payment.findUnique({
    where: { bookingId },
    include: {
      booking: {
        include: {
          user: true,
          provider: true,
          service: true,
        }
      }
    }
  });

  if (!payment) {
    return null;
  }

  if (!canViewPayment(payment.booking, requester)) {
    throw new GraphQLError('You do not have permission to view this payment', {
      extensions: { code: 'UNAUTHORIZED' }
    });
  }

  return formatPaymentResponse(payment);
};

/**
 * Get user's payment history
 */
export const getUserPayments = async (
  userId: string,
  filters: PaymentFilters = {},
  pagination: PaginationInput = { page: 1, limit: 10 }
) => {
  const { status, startDate, endDate } = filters;
  const { page, limit } = pagination;
  const skip = (page - 1) * limit;

  const where: any = {
    booking: {
      userId,
    }
  };

  if (status) {
    where.status = status;
  }

  if (startDate || endDate) {
    where.createdAt = {};
    if (startDate) where.createdAt.gte = new Date(startDate);
    if (endDate) where.createdAt.lte = new Date(endDate);
  }

  const [payments, total] = await Promise.all([
    prisma.payment.findMany({
      where,
      include: {
        booking: {
          include: {
            service: true,
            provider: true,
          }
        }
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.payment.count({ where }),
  ]);

  const totalPages = Math.ceil(total / limit);

  return {
    items: payments.map(formatPaymentResponse),
    total,
    page,
    totalPages,
    hasNextPage: page < totalPages,
  };
};

/**
 * Get provider's earnings/payment history
 */
export const getProviderPayments = async (
  userId: string,
  filters: PaymentFilters = {},
  pagination: PaginationInput = { page: 1, limit: 10 }
) => {
  // Get provider profile
  const provider = await prisma.serviceProvider.findUnique({
    where: { userId },
  });

  if (!provider) {
    throw new GraphQLError('Provider profile not found', {
      extensions: { code: 'PROVIDER_NOT_FOUND' }
    });
  }

  const { status, startDate, endDate } = filters;
  const { page, limit } = pagination;
  const skip = (page - 1) * limit;

  const where: any = {
    booking: {
      providerId: provider.id,
    }
  };

  if (status) {
    where.status = status;
  }

  if (startDate || endDate) {
    where.createdAt = {};
    if (startDate) where.createdAt.gte = new Date(startDate);
    if (endDate) where.createdAt.lte = new Date(endDate);
  }

  const [payments, total] = await Promise.all([
    prisma.payment.findMany({
      where,
      include: {
        booking: {
          include: {
            service: true,
            user: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                email: true,
              }
            },
          }
        }
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.payment.count({ where }),
  ]);

  const totalPages = Math.ceil(total / limit);

  return {
    items: payments.map(formatPaymentResponse),
    total,
    page,
    totalPages,
    hasNextPage: page < totalPages,
  };
};

/**
 * Get all payments (Admin)
 */
export const getAllPayments = async (
  filters: PaymentFilters = {},
  pagination: PaginationInput = { page: 1, limit: 10 }
) => {
  const { status, startDate, endDate } = filters;
  const { page, limit } = pagination;
  const skip = (page - 1) * limit;

  const where: any = {};

  if (status) {
    where.status = status;
  }

  if (startDate || endDate) {
    where.createdAt = {};
    if (startDate) where.createdAt.gte = new Date(startDate);
    if (endDate) where.createdAt.lte = new Date(endDate);
  }

  const [payments, total] = await Promise.all([
    prisma.payment.findMany({
      where,
      include: {
        booking: {
          include: {
            service: true,
            user: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                email: true,
              }
            },
            provider: {
              include: {
                user: {
                  select: {
                    id: true,
                    firstName: true,
                    lastName: true,
                  }
                }
              }
            },
          }
        }
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.payment.count({ where }),
  ]);

  const totalPages = Math.ceil(total / limit);

  return {
    items: payments.map(formatPaymentResponse),
    total,
    page,
    totalPages,
    hasNextPage: page < totalPages,
  };
};

// A naira total to the kobo, without floating-point residue
const roundNaira = (naira: number) => koboToNaira(nairaToKobo(naira));

/**
 * Get payment statistics. Money totals are over COMPLETED payments, after
 * partial refunds, so totalRevenue = totalCommission + totalProviderPayouts.
 */
export const getPaymentStats = async (providerId?: string) => {
  const where: Prisma.PaymentWhereInput = providerId ? { booking: { providerId } } : {};

  const [totalPayments, completedPayments, pendingPayments, failedPayments, refundedPayments, totals] =
    await Promise.all([
      prisma.payment.count({ where }),
      prisma.payment.count({ where: { ...where, status: PaymentStatus.COMPLETED } }),
      prisma.payment.count({ where: { ...where, status: PaymentStatus.PENDING } }),
      prisma.payment.count({ where: { ...where, status: PaymentStatus.FAILED } }),
      prisma.payment.count({ where: { ...where, status: PaymentStatus.REFUNDED } }),
      prisma.payment.aggregate({
        where: { ...where, status: PaymentStatus.COMPLETED },
        _sum: { amount: true, refundAmount: true, commission: true, providerPayout: true },
      }),
    ]);

  const sums = totals._sum;

  return {
    totalPayments,
    completedPayments,
    pendingPayments,
    failedPayments,
    refundedPayments,
    // What those payments kept: a partly refunded payment counts without its refund
    totalRevenue: roundNaira((sums.amount ?? 0) - (sums.refundAmount ?? 0)),
    totalCommission: roundNaira(sums.commission ?? 0),
    totalProviderPayouts: roundNaira(sums.providerPayout ?? 0),
    commissionRate: toPercent(await getCommissionRate()), // Percentage for new bookings
  };
};

/**
 * Get provider earnings summary
 */
export const getProviderEarnings = async (userId: string) => {
  const provider = await prisma.serviceProvider.findUnique({
    where: { userId },
  });

  if (!provider) {
    throw new GraphQLError('Provider profile not found', {
      extensions: { code: 'PROVIDER_NOT_FOUND' }
    });
  }

  const paid = { booking: { providerId: provider.id }, status: PaymentStatus.COMPLETED };

  const [totals, thisMonthEarnings, completedJobsCount] = await Promise.all([
    // Earnings from completed payments, and the commission charged on them
    prisma.payment.aggregate({
      where: paid,
      _sum: { providerPayout: true, amount: true, refundAmount: true, commission: true },
    }),
    // This month's earnings
    prisma.payment.aggregate({
      where: {
        ...paid,
        paidAt: {
          gte: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
        },
      },
      _sum: { providerPayout: true },
    }),
    // Completed jobs count
    prisma.payment.count({ where: paid }),
  ]);

  // The rate charged on this provider's paid bookings: commission over what the
  // payments kept (both shrink in proportion after a refund). With nothing kept
  // yet, the rate their next booking would get.
  const keptKobo = nairaToKobo(totals._sum.amount ?? 0) - nairaToKobo(totals._sum.refundAmount ?? 0);
  const commissionRate = keptKobo > 0
    ? nairaToKobo(totals._sum.commission ?? 0) / keptKobo
    : await getCommissionRate();

  return {
    totalEarnings: roundNaira(totals._sum.providerPayout ?? 0),
    thisMonthEarnings: roundNaira(thisMonthEarnings._sum.providerPayout ?? 0),
    completedJobs: completedJobsCount,
    commissionRate: toPercent(commissionRate),
  };
};

// ==========================================
// Bank Account Management
// ==========================================

/**
 * List available banks
 */
export const listBanks = async () => {
  const response = await paystack.listBanks();
  return response.data;
};

/**
 * Verify bank account
 */
export const verifyBankAccount = async (
  accountNumber: string,
  bankCode: string
) => {
  const response = await paystack.resolveAccount(accountNumber, bankCode);
  return response.data;
};

// ==========================================
// Webhook Handler
// ==========================================

const getRedis = () => {
  try {
    return RedisClient.getInstance();
  } catch {
    return null;
  }
};

// Webhook event ID tracking for idempotency
const WEBHOOK_EVENT_PREFIX = 'webhook_event:';
const WEBHOOK_EVENT_TTL = 86400; // 24 hours

/**
 * Check if webhook event was already processed. Every handler is idempotent,
 * so when Redis is unavailable the event is simply processed again.
 */
const isWebhookProcessed = async (eventId: string): Promise<boolean> => {
  const redis = getRedis();
  if (!redis) {
    console.warn('Redis unavailable for webhook idempotency check');
    return false;
  }

  try {
    const exists = await redis.exists(`${WEBHOOK_EVENT_PREFIX}${eventId}`);
    return exists === 1;
  } catch (error) {
    console.warn('Webhook idempotency check failed:', (error as Error).message);
    return false;
  }
};

/**
 * Mark webhook event as processed
 */
const markWebhookProcessed = async (eventId: string): Promise<void> => {
  const redis = getRedis();
  if (!redis) return;

  try {
    await redis.setex(`${WEBHOOK_EVENT_PREFIX}${eventId}`, WEBHOOK_EVENT_TTL, Date.now().toString());
  } catch (error) {
    console.warn('Failed to record processed webhook:', (error as Error).message);
  }
};

const transferEvent = (event: PaystackWebhookEvent) => ({
  reference: event.data.reference as string | undefined,
  transferCode: event.data.transfer_code as string | undefined,
});

/**
 * Handle Paystack webhook events
 * SECURITY:
 * - Signature verification
 * - Event ID idempotency check (prevents replay attacks)
 */
export const handlePaystackWebhook = async (
  payload: string,
  signature: string
) => {
  // Verify signature
  if (!verifyWebhookSignature(payload, signature)) {
    throw new GraphQLError('Invalid webhook signature', {
      extensions: { code: 'INVALID_SIGNATURE' }
    });
  }

  const event: PaystackWebhookEvent = JSON.parse(payload);

  // Paystack's id is unique per transaction or transfer attempt; a retried
  // withdrawal gets a new transfer, so its events aren't mistaken for repeats
  const eventId = `${event.event}_${event.data.id ?? event.data.reference ?? Date.now()}`;

  // Check if this event was already processed (prevents replay attacks)
  if (await isWebhookProcessed(eventId)) {
    console.log(`Webhook event already processed: ${eventId}`);
    return { received: true, duplicate: true };
  }

  try {
    switch (event.event) {
      case 'charge.success':
        // Payment successful - verify and update
        await verifyPayment(event.data.reference);
        break;

      case 'charge.failed':
        // Payment failed
        await handleFailedPayment(event.data.reference);
        break;

      case 'transfer.success': {
        const { handleTransferSuccess } = await import('./withdrawal.service');
        await handleTransferSuccess(transferEvent(event));
        break;
      }

      case 'transfer.failed': {
        const { handleTransferFailed } = await import('./withdrawal.service');
        await handleTransferFailed(
          transferEvent(event),
          event.data.reason || event.data.gateway_response || 'Transfer failed'
        );
        break;
      }

      case 'transfer.reversed': {
        const { handleTransferReversed } = await import('./withdrawal.service');
        await handleTransferReversed(transferEvent(event));
        break;
      }

      case 'refund.processed':
      case 'refund.failed':
        // The app refunds to wallets; these only come from refunds made in the
        // Paystack dashboard
        console.log(`Paystack ${event.event}:`, event.data?.transaction_reference ?? event.data?.id);
        break;

      default:
        console.log('Unhandled webhook event:', event.event);
    }

    // Mark event as processed AFTER successful handling
    await markWebhookProcessed(eventId);

    return { received: true };
  } catch (error) {
    const code = error instanceof GraphQLError ? String(error.extensions.code) : undefined;

    // Retrying won't help: flag the charge for an admin and acknowledge the
    // event, instead of Paystack redelivering it for 72 hours
    if (code && PERMANENT_WEBHOOK_ERRORS.has(code)) {
      if (event.event === 'charge.success') {
        await alertAdmins(
          'Paystack payment could not be applied',
          `Reference ${event.data.reference} was charged but could not be matched to its payment (${code}). Check the booking and refund the customer if needed.`,
          { reference: event.data.reference, code }
        );
      }
      await markWebhookProcessed(eventId);
      return { received: true, flagged: code };
    }

    console.error('Webhook processing error:', error);
    // Not marked as processed: the route answers with an error so Paystack retries
    throw error;
  }
};

/**
 * Handle failed payment webhook
 */
const handleFailedPayment = async (reference: string) => {
  const payment = await findPaymentByReference(reference);

  // Ignore unknown references and failures on an older checkout
  if (!payment || payment.transactionRef !== reference) return;

  // Only an open payment fails, and only once
  const { count } = await prisma.payment.updateMany({
    where: {
      id: payment.id,
      transactionRef: reference,
      status: { in: [PaymentStatus.PENDING, PaymentStatus.PROCESSING] },
    },
    data: { status: PaymentStatus.FAILED },
  });

  if (count === 0) return;

  await sendNotification(
    payment.booking.userId,
    NotificationType.PAYMENT_FAILED,
    'Payment Failed',
    `Your payment for ${payment.booking.service.name} has failed. Please try again.`,
    { bookingId: payment.bookingId, paymentId: payment.id }
  );
};
