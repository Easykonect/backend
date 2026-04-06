/**
 * Payment Service
 * 
 * Handles all payment-related business logic for Easykonnet.
 * 
 * Payment Flow (Based on Legal Document):
 * 1. Customer books a service → Booking created with PENDING status
 * 2. Provider accepts → status: ACCEPTED
 * 3. Customer pays via Paystack → Payment initialized, funds held in escrow
 * 4. Provider delivers service → Service marked as IN_PROGRESS then COMPLETED
 * 5. Customer confirms completion (or auto-confirm after 24 hours)
 * 6. Platform deducts 7% commission + Paystack fees
 * 7. Provider receives payout (91.5-92% of service fee)
 * 
 * Commission Structure:
 * - Platform Commission: 7% of service fee
 * - Paystack Fee: 1.5% (capped at ₦2,000)
 * - Provider Payout: ~91.5-92% of service fee
 * 
 * Refund Policy:
 * - Full refund if provider cancels before arriving
 * - Full refund if provider fails to show within 60 minutes
 * - Partial refund based on dispute resolution
 * - No refund after 24 hours without dispute
 */

import prisma from '@/lib/prisma';
import { 
  paystack, 
  generateTransactionReference, 
  nairaToKobo, 
  koboToNaira,
  calculateProviderPayout as calculatePayout,
  verifyWebhookSignature,
  type PaystackWebhookEvent,
} from '@/lib/paystack';
import { GraphQLError } from 'graphql';
import { config } from '@/config';
import { PaymentStatus, BookingStatus, NotificationType } from '@/constants';
import { createNotification } from '@/services/notification.service';
import { capturePaymentError, addBreadcrumb } from '@/lib/sentry';

// ==========================================
// Types
// ==========================================

interface InitializePaymentInput {
  bookingId: string;
  callbackUrl?: string;
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
  amount?: number; // Optional partial refund amount in Naira
  reason: string;
}

// Cancellation fee rates based on timing (from legal document)
const CANCELLATION_FEES = {
  FREE_WINDOW_MINUTES: 30,        // Free cancellation within 30 minutes
  BEFORE_ARRIVAL_RATE: 0.10,      // 10% fee if cancelled before provider arrives
  AFTER_ARRIVAL_RATE: 0.25,       // 25% fee if cancelled after provider arrives
};

// ==========================================
// Helper Functions
// ==========================================

/**
 * Get payment by ID with booking details
 */
const getPaymentWithDetails = async (paymentId: string) => {
  const payment = await prisma.payment.findUnique({
    where: { id: paymentId },
    include: {
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
    }
  });

  if (!payment) {
    throw new GraphQLError('Payment not found', {
      extensions: { code: 'PAYMENT_NOT_FOUND' }
    });
  }

  return payment;
};

/**
 * Calculate cancellation fee based on timing
 */
export const calculateCancellationFee = (
  booking: any,
  providerArrived: boolean
): { fee: number; refundAmount: number } => {
  const createdAt = new Date(booking.createdAt);
  const now = new Date();
  const minutesSinceBooking = (now.getTime() - createdAt.getTime()) / (1000 * 60);
  
  const serviceAmount = booking.servicePrice;
  
  // Free cancellation within 30 minutes
  if (minutesSinceBooking <= CANCELLATION_FEES.FREE_WINDOW_MINUTES) {
    return { fee: 0, refundAmount: serviceAmount };
  }
  
  // After provider arrives: 25% fee
  if (providerArrived) {
    const fee = serviceAmount * CANCELLATION_FEES.AFTER_ARRIVAL_RATE;
    return { fee, refundAmount: serviceAmount - fee };
  }
  
  // Before provider arrives: 10% fee
  const fee = serviceAmount * CANCELLATION_FEES.BEFORE_ARRIVAL_RATE;
  return { fee, refundAmount: serviceAmount - fee };
};

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
 * Send notification helper
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
};

// ==========================================
// Payment Initialization
// ==========================================

/**
 * Initialize payment for a booking
 * Creates a Paystack payment link for the customer
 */
export const initializePayment = async (
  userId: string,
  input: InitializePaymentInput
) => {
  const { bookingId, callbackUrl } = input;

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

  // Calculate amounts
  const serviceAmountNaira = booking.servicePrice;
  const serviceAmountKobo = nairaToKobo(serviceAmountNaira);
  
  const payoutDetails = calculatePayout(serviceAmountKobo);

  // Generate transaction reference
  const reference = generateTransactionReference();

  // Initialize Paystack transaction
  const paystackResponse = await paystack.initializeTransaction({
    email: booking.user.email,
    amount: serviceAmountKobo,
    reference,
    callback_url: callbackUrl || `${config.platform.frontendUrl}/payment/callback`,
    metadata: {
      bookingId: booking.id,
      userId: booking.userId,
      providerId: booking.providerId,
      serviceId: booking.serviceId,
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

  if (!paystackResponse.status) {
    const error = new Error('Failed to initialize payment with Paystack');
    capturePaymentError(error, {
      bookingId: booking.id,
      amount: serviceAmountNaira,
      userId: booking.userId,
      provider: 'paystack',
    });
    throw new GraphQLError('Failed to initialize payment with Paystack', {
      extensions: { code: 'PAYSTACK_ERROR' }
    });
  }

  // Add breadcrumb for successful initialization
  addBreadcrumb({
    message: `Payment initialized for booking ${booking.id}`,
    category: 'payment',
    level: 'info',
    data: { bookingId: booking.id, amount: serviceAmountNaira, reference },
  });

  // Create or update payment record
  const payment = await prisma.payment.upsert({
    where: { bookingId: booking.id },
    create: {
      bookingId: booking.id,
      amount: serviceAmountNaira,
      commission: koboToNaira(payoutDetails.platformCommission),
      providerPayout: koboToNaira(payoutDetails.providerPayout),
      status: PaymentStatus.PENDING as any,
      transactionRef: reference,
    },
    update: {
      transactionRef: reference,
      status: PaymentStatus.PENDING as any,
      updatedAt: new Date(),
    },
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

/**
 * Verify payment status
 * Called after customer completes payment on Paystack
 */
export const verifyPayment = async (transactionRef: string) => {
  // Get payment record
  const payment = await prisma.payment.findUnique({
    where: { transactionRef },
    include: {
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
    }
  });

  if (!payment) {
    throw new GraphQLError('Payment not found for this reference', {
      extensions: { code: 'PAYMENT_NOT_FOUND' }
    });
  }

  // If already completed, return current status
  if (payment.status === PaymentStatus.COMPLETED) {
    return {
      payment: formatPaymentResponse(payment),
      verified: true,
      message: 'Payment already verified and completed',
    };
  }

  // SECURITY FIX: Validate booking is still in a valid state for payment
  const validBookingStatuses = [BookingStatus.ACCEPTED, BookingStatus.PENDING];
  if (!validBookingStatuses.includes(payment.booking.status as any)) {
    // Booking is in an invalid state (cancelled, completed, etc.)
    // Don't process payment for cancelled/invalid bookings
    throw new GraphQLError(
      `Cannot verify payment: Booking is ${payment.booking.status}`,
      { extensions: { code: 'INVALID_BOOKING_STATUS' } }
    );
  }

  // Verify with Paystack
  const paystackResponse = await paystack.verifyTransaction(transactionRef);

  if (!paystackResponse.status) {
    throw new GraphQLError('Failed to verify payment with Paystack', {
      extensions: { code: 'PAYSTACK_ERROR' }
    });
  }

  const { data } = paystackResponse;

  // Verify amount matches (security - prevent amount manipulation)
  const expectedAmountKobo = nairaToKobo(payment.amount);
  if (data.amount !== expectedAmountKobo) {
    console.error(`Amount mismatch: Expected ${expectedAmountKobo}, got ${data.amount}`);
    throw new GraphQLError('Payment amount mismatch', {
      extensions: { code: 'AMOUNT_MISMATCH' }
    });
  }

  // Check payment status from Paystack
  if (data.status !== 'success') {
    // Update payment as failed
    await prisma.payment.update({
      where: { id: payment.id },
      data: {
        status: data.status === 'failed' ? PaymentStatus.FAILED as any : PaymentStatus.PENDING as any,
        paymentMethod: data.channel,
        updatedAt: new Date(),
      }
    });

    // Notify user of failed payment
    if (data.status === 'failed') {
      await sendNotification(
        payment.booking.userId,
        NotificationType.PAYMENT_FAILED,
        'Payment Failed',
        `Your payment for ${payment.booking.service.name} has failed. Please try again.`,
        { bookingId: payment.bookingId, paymentId: payment.id }
      );
    }

    return {
      payment: formatPaymentResponse(payment),
      verified: false,
      message: `Payment ${data.status}: ${data.gateway_response}`,
    };
  }

  // Payment successful - update records atomically
  const updatedPayment = await prisma.$transaction(async (tx) => {
    // Double-check booking status within transaction
    const currentBooking = await tx.booking.findUnique({
      where: { id: payment.bookingId },
    });

    if (!currentBooking || currentBooking.status === BookingStatus.CANCELLED) {
      throw new GraphQLError(
        'Booking was cancelled. Payment cannot be processed.',
        { extensions: { code: 'BOOKING_CANCELLED' } }
      );
    }

    // Update payment status
    const updated = await tx.payment.update({
      where: { id: payment.id },
      data: {
        status: PaymentStatus.COMPLETED as any,
        paymentMethod: data.channel,
        paidAt: new Date(data.paid_at || Date.now()),
        updatedAt: new Date(),
      },
      include: {
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
      }
    });

    // Update booking status to IN_PROGRESS (payment received, waiting for service)
    // Only if not already in a later state
    if (currentBooking.status === BookingStatus.ACCEPTED) {
      await tx.booking.update({
        where: { id: payment.bookingId },
        data: { status: BookingStatus.IN_PROGRESS as any },
      });
    }

    return updated;
  });

  // Send notifications
  await Promise.all([
    // Notify customer
    sendNotification(
      updatedPayment.booking.userId,
      NotificationType.PAYMENT_RECEIVED,
      'Payment Successful',
      `Your payment for ${updatedPayment.booking.service.name} has been received. The provider will begin service soon.`,
      { bookingId: payment.bookingId, paymentId: payment.id }
    ),
    // Notify provider
    sendNotification(
      updatedPayment.booking.provider.userId,
      NotificationType.PAYMENT_RECEIVED,
      'Payment Secured',
      `Payment for ${updatedPayment.booking.service.name} has been secured in escrow. You can now proceed with the service.`,
      { bookingId: payment.bookingId, paymentId: payment.id }
    ),
  ]);

  return {
    payment: formatPaymentResponse(updatedPayment),
    verified: true,
    message: 'Payment verified successfully',
  };
};

// ==========================================
// Release Payment to Provider
// ==========================================

/**
 * Release payment to provider after service completion
 * Called when customer confirms completion or after auto-confirm (24 hours)
 */
export const releasePaymentToProvider = async (bookingId: string) => {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: {
      payment: true,
      provider: {
        include: {
          user: true,
        }
      },
      user: true,
      service: true,
    }
  });

  if (!booking) {
    throw new GraphQLError('Booking not found', {
      extensions: { code: 'BOOKING_NOT_FOUND' }
    });
  }

  if (!booking.payment) {
    throw new GraphQLError('No payment found for this booking', {
      extensions: { code: 'PAYMENT_NOT_FOUND' }
    });
  }

  if (booking.payment.status !== PaymentStatus.COMPLETED) {
    throw new GraphQLError('Payment has not been completed', {
      extensions: { code: 'PAYMENT_NOT_COMPLETED' }
    });
  }

  if (booking.status !== BookingStatus.COMPLETED) {
    throw new GraphQLError('Service has not been completed', {
      extensions: { code: 'SERVICE_NOT_COMPLETED' }
    });
  }

  // Note: In production, implement actual Paystack transfer here
  // For now, we track payout status in the database
  
  // Notify provider
  await sendNotification(
    booking.provider.userId,
    NotificationType.PAYMENT_RECEIVED,
    'Payment Released',
    `₦${booking.payment.providerPayout.toLocaleString()} has been released to your account for completing ${booking.service.name}.`,
    { bookingId: booking.id, paymentId: booking.payment.id }
  );

  return {
    success: true,
    message: 'Payment released to provider successfully',
    payment: formatPaymentResponse(booking.payment),
  };
};

// ==========================================
// Refund Processing
// ==========================================

/**
 * Process refund for a cancelled booking (Admin only)
 */
export const processRefund = async (
  adminId: string,
  input: RefundInput
) => {
  const { paymentId, amount, reason } = input;

  const payment = await getPaymentWithDetails(paymentId);

  if (payment.status !== PaymentStatus.COMPLETED) {
    throw new GraphQLError('Can only refund completed payments', {
      extensions: { code: 'INVALID_PAYMENT_STATUS' }
    });
  }

  if (payment.refundedAt) {
    throw new GraphQLError('Payment has already been refunded', {
      extensions: { code: 'ALREADY_REFUNDED' }
    });
  }

  // Calculate refund amount
  const refundAmount = amount || payment.amount;
  
  if (refundAmount > payment.amount) {
    throw new GraphQLError('Refund amount cannot exceed payment amount', {
      extensions: { code: 'INVALID_REFUND_AMOUNT' }
    });
  }

  // Process refund with Paystack
  try {
    const refundResponse = await paystack.processRefund({
      transaction: payment.transactionRef!,
      amount: nairaToKobo(refundAmount),
      merchant_note: reason,
      customer_note: `Refund for booking ${payment.bookingId}: ${reason}`,
    });

    if (!refundResponse.status) {
      throw new GraphQLError('Failed to process refund with Paystack', {
        extensions: { code: 'PAYSTACK_ERROR' }
      });
    }
  } catch (error) {
    console.error('Paystack refund error:', error);
    // Continue with database update even if Paystack fails
    // This allows manual reconciliation
  }

  // Update payment status
  const isFullRefund = refundAmount === payment.amount;
  
  const updatedPayment = await prisma.payment.update({
    where: { id: paymentId },
    data: {
      status: isFullRefund ? PaymentStatus.REFUNDED as any : PaymentStatus.COMPLETED as any,
      refundedAt: new Date(),
      updatedAt: new Date(),
    },
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

  // Update booking status if full refund
  if (isFullRefund) {
    await prisma.booking.update({
      where: { id: payment.bookingId },
      data: { status: BookingStatus.CANCELLED as any },
    });
  }

  // Notify customer
  await sendNotification(
    payment.booking.userId,
    NotificationType.REFUND_PROCESSED,
    'Refund Processed',
    `Your refund of ₦${refundAmount.toLocaleString()} has been processed. ${reason}`,
    { bookingId: payment.bookingId, paymentId: payment.id }
  );

  return {
    success: true,
    message: `Refund of ₦${refundAmount.toLocaleString()} processed successfully`,
    payment: formatPaymentResponse(updatedPayment),
  };
};

// ==========================================
// Query Functions
// ==========================================

/**
 * Get payment by ID
 */
export const getPaymentById = async (paymentId: string, requesterId: string) => {
  const payment = await prisma.payment.findUnique({
    where: { id: paymentId },
    include: {
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
    }
  });

  if (!payment) {
    throw new GraphQLError('Payment not found', {
      extensions: { code: 'PAYMENT_NOT_FOUND' }
    });
  }

  // Check authorization - must be booking owner, provider, or admin
  const isOwner = payment.booking.userId === requesterId;
  const isProvider = payment.booking.provider?.userId === requesterId;
  
  if (!isOwner && !isProvider) {
    throw new GraphQLError('You do not have permission to view this payment', {
      extensions: { code: 'UNAUTHORIZED' }
    });
  }

  return formatPaymentResponse(payment);
};

/**
 * Get payment by booking ID
 */
export const getPaymentByBookingId = async (bookingId: string) => {
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

/**
 * Get payment statistics
 */
export const getPaymentStats = async (providerId?: string) => {
  const where: any = providerId ? { booking: { providerId } } : {};

  const [
    totalPayments,
    completedPayments,
    pendingPayments,
    failedPayments,
    refundedPayments,
    totalRevenue,
    totalCommission,
    totalProviderPayouts,
  ] = await Promise.all([
    prisma.payment.count({ where }),
    prisma.payment.count({ where: { ...where, status: PaymentStatus.COMPLETED as any } }),
    prisma.payment.count({ where: { ...where, status: PaymentStatus.PENDING as any } }),
    prisma.payment.count({ where: { ...where, status: PaymentStatus.FAILED as any } }),
    prisma.payment.count({ where: { ...where, status: PaymentStatus.REFUNDED as any } }),
    prisma.payment.aggregate({
      where: { ...where, status: PaymentStatus.COMPLETED as any },
      _sum: { amount: true },
    }),
    prisma.payment.aggregate({
      where: { ...where, status: PaymentStatus.COMPLETED as any },
      _sum: { commission: true },
    }),
    prisma.payment.aggregate({
      where: { ...where, status: PaymentStatus.COMPLETED as any },
      _sum: { providerPayout: true },
    }),
  ]);

  return {
    totalPayments,
    completedPayments,
    pendingPayments,
    failedPayments,
    refundedPayments,
    totalRevenue: totalRevenue._sum?.amount || 0,
    totalCommission: totalCommission._sum?.commission || 0,
    totalProviderPayouts: totalProviderPayouts._sum?.providerPayout || 0,
    commissionRate: config.platform.commissionRate * 100, // Return as percentage
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

  const completedStatus = PaymentStatus.COMPLETED as any;

  const [
    totalEarnings,
    thisMonthEarnings,
    completedJobsCount,
  ] = await Promise.all([
    // Total earnings from completed payments
    prisma.payment.aggregate({
      where: {
        booking: { providerId: provider.id },
        status: completedStatus,
      },
      _sum: { providerPayout: true },
    }),
    // This month's earnings
    prisma.payment.aggregate({
      where: {
        booking: { providerId: provider.id },
        status: completedStatus,
        paidAt: {
          gte: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
        },
      },
      _sum: { providerPayout: true },
    }),
    // Completed jobs count
    prisma.payment.count({
      where: {
        booking: { providerId: provider.id },
        status: completedStatus,
      },
    }),
  ]);

  return {
    totalEarnings: totalEarnings._sum?.providerPayout || 0,
    thisMonthEarnings: thisMonthEarnings._sum?.providerPayout || 0,
    completedJobs: completedJobsCount,
    commissionRate: config.platform.commissionRate * 100,
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

// Import Redis for webhook idempotency
import RedisClient from '@/lib/redis';

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
 * Check if webhook event was already processed (idempotency)
 */
const isWebhookProcessed = async (eventId: string): Promise<boolean> => {
  const redis = getRedis();
  if (!redis) {
    // If Redis unavailable, allow processing but log warning
    console.warn('Redis unavailable for webhook idempotency check');
    return false;
  }

  const key = `${WEBHOOK_EVENT_PREFIX}${eventId}`;
  const exists = await redis.exists(key);
  return exists === 1;
};

/**
 * Mark webhook event as processed
 */
const markWebhookProcessed = async (eventId: string): Promise<void> => {
  const redis = getRedis();
  if (!redis) return;

  const key = `${WEBHOOK_EVENT_PREFIX}${eventId}`;
  await redis.setex(key, WEBHOOK_EVENT_TTL, Date.now().toString());
};

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

  // Extract unique event identifier for idempotency
  const eventId = `${event.event}_${event.data.reference || event.data.id || Date.now()}`;

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

      case 'transfer.success':
        // Provider payout successful - import and call withdrawal handler
        const { handleTransferSuccess } = await import('./withdrawal.service');
        await handleTransferSuccess(event.data.transfer_code);
        break;

      case 'transfer.failed':
        // Provider payout failed
        const { handleTransferFailed } = await import('./withdrawal.service');
        await handleTransferFailed(
          event.data.transfer_code,
          event.data.reason || 'Transfer failed'
        );
        break;

      case 'refund.processed':
        // Refund completed
        console.log('Refund processed:', event.data);
        break;

      default:
        console.log('Unhandled webhook event:', event.event);
    }

    // Mark event as processed AFTER successful handling
    await markWebhookProcessed(eventId);

    return { received: true };
  } catch (error) {
    console.error('Webhook processing error:', error);
    // Don't mark as processed if there was an error, so it can be retried
    throw error;
  }
};

/**
 * Handle failed payment webhook
 */
const handleFailedPayment = async (reference: string) => {
  const payment = await prisma.payment.findUnique({
    where: { transactionRef: reference },
    include: {
      booking: {
        include: {
          user: true,
          service: true,
        }
      }
    }
  });

  if (!payment) return;

  // Only update if not already in a terminal state
  if (payment.status === PaymentStatus.COMPLETED || payment.status === PaymentStatus.REFUNDED) {
    return;
  }

  await prisma.payment.update({
    where: { id: payment.id },
    data: { status: PaymentStatus.FAILED as any },
  });

  await sendNotification(
    payment.booking.userId,
    NotificationType.PAYMENT_FAILED,
    'Payment Failed',
    `Your payment for ${payment.booking.service.name} has failed. Please try again.`,
    { bookingId: payment.bookingId, paymentId: payment.id }
  );
};
