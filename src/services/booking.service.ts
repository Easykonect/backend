/**
 * Booking Service
 * Handles all booking-related business logic
 *
 * Flow:
 * 1. USER creates booking -> status: PENDING
 * 2. PROVIDER accepts -> status: ACCEPTED
 * 3. PROVIDER starts service -> status: IN_PROGRESS
 * 4. PROVIDER completes -> status: COMPLETED
 *
 * Cancellation:
 * - USER can cancel before ACCEPTED (or within cancellation window after)
 * - PROVIDER can reject PENDING bookings
 * - A paid booking that is cancelled is refunded to the customer's wallet
 *
 * Schedules are Lagos time: scheduledDate (YYYY-MM-DD) and scheduledTime (HH:mm)
 * are read in Africa/Lagos for the lead-time, 30-day and cancellation checks.
 */

import { AdminAction } from '@prisma/client';
import prisma from '@/lib/prisma';
import {
  BookingStatus,
  NotificationType,
  PaymentStatus,
  RELEASE_DELAY_HOURS,
  UserRole,
  ServiceStatus,
} from '@/constants';
import { GraphQLError } from 'graphql';
import { emitToUser } from '@/lib/socket';
import { withTransaction, type TransactionClient } from '@/lib/transaction';
import { assertAcceptableText } from '@/lib/content-filter';
import { sanitizeBasic, sanitizeStrict } from '@/utils/security';
import {
  createNotification,
  notifyBookingCreated,
  notifyBookingAccepted,
  notifyBookingRejected,
  notifyBookingStarted,
  notifyBookingCompleted,
  notifyBookingCancelled,
} from '@/services/notification.service';
import { sendBookingPush, sendPushToUser } from '@/services/push.service';
import { createAuditLog } from '@/services/audit.service';
import { refundPaymentToWallet } from '@/services/escrow.service';
import { isBlockedBetween } from '@/services/block.service';
import { ensureWallet, koboToNaira } from '@/services/wallet.service';
import { getCommissionRate } from '@/services/platform-settings.service';
import { logger } from '@/lib/logger';

// ==================
// Types
// ==================

interface CreateBookingInput {
  serviceId: string;
  scheduledDate: string; // YYYY-MM-DD, a Lagos calendar day
  scheduledTime: string; // HH:mm, 24-hour Lagos time
  address: string;
  city: string;
  state: string;
  notes?: string | null;
}

interface UpdateBookingInput {
  scheduledDate?: string | null;
  scheduledTime?: string | null;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  notes?: string | null;
}

interface BookingFilters {
  status?: string;
  startDate?: string;
  endDate?: string;
}

interface PaginationInput {
  page: number;
  limit: number;
}

interface ProviderProfileSource {
  id: string;
  businessName: string;
  businessDescription?: string | null;
  verificationStatus?: string;
  address?: string;
  city?: string;
  state?: string;
  country?: string;
  latitude?: number | null;
  longitude?: number | null;
  documents?: string[];
  images?: string[];
  createdAt?: Date | string;
  updatedAt?: Date | string;
}

// ==================
// Constants
// ==================

// Africa/Lagos is UTC+1 all year, with no daylight saving
const LAGOS_UTC_OFFSET = '+01:00';
const LAGOS_OFFSET_MS = 60 * 60 * 1000;

const SCHEDULED_DATE_FORMAT = /^(\d{4})-(\d{2})-(\d{2})$/;
const SCHEDULED_TIME_FORMAT = /^([01]\d|2[0-3]):[0-5]\d$/;

const MIN_LEAD_TIME_MS = 2 * 60 * 60 * 1000;
const MAX_ADVANCE_MS = 30 * 24 * 60 * 60 * 1000;
const CANCELLATION_WINDOW_MS = 24 * 60 * 60 * 1000;

// Longest free text accepted on a booking, counted after cleaning
const BOOKING_TEXT_LIMITS = {
  address: 300,
  city: 100,
  state: 100,
  notes: 1000,
  reason: 500,
} as const;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const DELIVERY_CONFIRMED_TITLE = 'Delivery Confirmed';

// ==================
// Helper Functions
// ==================

/**
 * A provider as the ServiceProviderProfile type expects it
 */
const toProviderProfile = (provider: ProviderProfileSource) => ({
  id: provider.id,
  businessName: provider.businessName,
  businessDescription: provider.businessDescription,
  verificationStatus: provider.verificationStatus,
  address: provider.address,
  city: provider.city,
  state: provider.state,
  country: provider.country,
  latitude: provider.latitude,
  longitude: provider.longitude,
  documents: provider.documents,
  images: provider.images ?? [],
  createdAt: provider.createdAt,
  updatedAt: provider.updatedAt,
});

/**
 * Format booking response for GraphQL
 * Maps provider to ServiceProviderProfile type
 */
const formatBookingResponse = (booking: any) => {
  const provider = booking.provider ? toProviderProfile(booking.provider) : null;

  return {
    ...booking,
    // Include customer confirmation and payment release fields
    customerConfirmedAt: booking.customerConfirmedAt?.toISOString() || null,
    paymentReleaseAt: booking.paymentReleaseAt?.toISOString() || null,
    paymentReleasedAt: booking.paymentReleasedAt?.toISOString() || null,
    provider,
    service: booking.service
      ? {
          ...booking.service,
          provider: booking.service.provider ? toProviderProfile(booking.service.provider) : provider,
        }
      : null,
    // A review an admin removed isn't shown
    review: booking.review && !booking.review.deletedAt ? booking.review : null,
  };
};

/**
 * Calculate booking pricing
 */
const calculateBookingPricing = (servicePrice: number, commissionRate: number) => {
  // In whole kobo, so the payment split adds up exactly
  const commission = Math.round(servicePrice * 100 * commissionRate) / 100;
  const totalAmount = servicePrice; // Customer pays service price
  return { servicePrice, commission, totalAmount };
};

const invalidBookingTime = (message: string) =>
  new GraphQLError(message, { extensions: { code: 'INVALID_BOOKING_TIME' } });

/**
 * Throw unless the date is a real calendar day written YYYY-MM-DD
 */
const assertScheduledDate = (scheduledDate: unknown) => {
  const match = typeof scheduledDate === 'string' ? SCHEDULED_DATE_FORMAT.exec(scheduledDate) : null;

  if (match) {
    const [year, month, day] = match.slice(1).map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day) {
      return;
    }
  }

  throw invalidBookingTime('Scheduled date must be a real date in YYYY-MM-DD format, for example 2026-09-20');
};

/**
 * Throw unless the time is a 24-hour HH:mm time
 */
const assertScheduledTime = (scheduledTime: unknown) => {
  if (typeof scheduledTime !== 'string' || !SCHEDULED_TIME_FORMAT.test(scheduledTime)) {
    throw invalidBookingTime('Scheduled time must be a 24-hour time in HH:mm format, from 00:00 to 23:59');
  }
};

/**
 * The moment a booking is scheduled for: its day and time read as Lagos time.
 * An Invalid Date when a stored schedule can't be read.
 */
const scheduledMoment = (scheduledDate: string, scheduledTime: string) =>
  new Date(`${scheduledDate}T${scheduledTime.slice(0, 5)}:00${LAGOS_UTC_OFFSET}`);

/**
 * Validate a booking's date and time: the formats, then at least 2 hours and
 * at most 30 days from now, in Lagos time
 */
const validateBookingDateTime = (scheduledDate: string, scheduledTime: string) => {
  assertScheduledDate(scheduledDate);
  assertScheduledTime(scheduledTime);

  const bookingTime = scheduledMoment(scheduledDate, scheduledTime).getTime();
  const now = Date.now();

  if (bookingTime < now + MIN_LEAD_TIME_MS) {
    throw invalidBookingTime('Booking must be scheduled at least 2 hours in advance');
  }

  if (bookingTime > now + MAX_ADVANCE_MS) {
    throw invalidBookingTime('Booking cannot be scheduled more than 30 days in advance');
  }
};

/**
 * A moment as Lagos time, e.g. "21 Sep 2026 at 16:02"
 */
const formatLagosDateTime = (moment: Date) => {
  const lagos = new Date(moment.getTime() + LAGOS_OFFSET_MS);
  const hours = String(lagos.getUTCHours()).padStart(2, '0');
  const minutes = String(lagos.getUTCMinutes()).padStart(2, '0');
  return `${lagos.getUTCDate()} ${MONTHS[lagos.getUTCMonth()]} ${lagos.getUTCFullYear()} at ${hours}:${minutes}`;
};

/**
 * Clean free text the other party sees: plain text, no longer than the limit,
 * and without blocked language. Contact details are refused unless allowed.
 */
const cleanBookingText = (
  value: string,
  field: string,
  maxLength: number,
  options: { singleLine?: boolean; allowContactDetails?: boolean } = {}
): string => {
  const cleaned = options.singleLine ? sanitizeStrict(value) : sanitizeBasic(value);

  if (cleaned.length > maxLength) {
    throw new GraphQLError(`${field} must be at most ${maxLength} characters`, {
      extensions: { code: 'INVALID_INPUT' },
    });
  }

  assertAcceptableText(cleaned, field, { allowContactDetails: options.allowContactDetails });

  return cleaned;
};

// The booking is for the provider taking the job, so contact details are
// allowed in where it happens and in the notes
const cleanAddress = (value: string) =>
  cleanBookingText(value, 'The address', BOOKING_TEXT_LIMITS.address, { singleLine: true, allowContactDetails: true });
const cleanCity = (value: string) =>
  cleanBookingText(value, 'The city', BOOKING_TEXT_LIMITS.city, { singleLine: true, allowContactDetails: true });
const cleanState = (value: string) =>
  cleanBookingText(value, 'The state', BOOKING_TEXT_LIMITS.state, { singleLine: true, allowContactDetails: true });
const cleanNotes = (value: string) =>
  cleanBookingText(value, 'Your note to the provider', BOOKING_TEXT_LIMITS.notes, { allowContactDetails: true });

const fullName = (person: { firstName?: string | null; lastName?: string | null } | null | undefined, fallback: string) =>
  `${person?.firstName ?? ''} ${person?.lastName ?? ''}`.trim() || fallback;

const bookingChanged = () =>
  new GraphQLError('This booking has changed. Please refresh and try again.', {
    extensions: { code: 'INVALID_BOOKING_STATUS' },
  });

// ==================
// User Booking Functions
// ==================

/**
 * Create a new booking (USER only)
 */
export const createBooking = async (userId: string, input: CreateBookingInput) => {
  // Get the service with provider info
  const service = await prisma.service.findUnique({
    where: { id: input.serviceId },
    include: {
      provider: true,
      category: true
    }
  });

  if (!service) {
    throw new GraphQLError('Service not found', {
      extensions: { code: 'SERVICE_NOT_FOUND' }
    });
  }

  // Block providers from booking their own services even when they hit
  // the mutation directly with a valid service ID. The list queries also
  // filter these out, but this guard is the source of truth.
  if (service.provider.userId === userId) {
    throw new GraphQLError('You cannot book your own service', {
      extensions: { code: 'SELF_BOOKING_NOT_ALLOWED' }
    });
  }

  // No bookings between people when either has blocked the other
  if (await isBlockedBetween(userId, service.provider.userId)) {
    throw new GraphQLError("You can't book this provider", {
      extensions: { code: 'BOOKING_NOT_ALLOWED' }
    });
  }

  // Check service is active
  if (service.status !== ServiceStatus.ACTIVE) {
    throw new GraphQLError('This service is not currently available for booking', {
      extensions: { code: 'SERVICE_NOT_AVAILABLE' }
    });
  }

  // Check provider is verified
  if (service.provider.verificationStatus !== 'VERIFIED') {
    throw new GraphQLError('This service provider is not verified', {
      extensions: { code: 'PROVIDER_NOT_VERIFIED' }
    });
  }

  // Validate booking date/time
  validateBookingDateTime(input.scheduledDate, input.scheduledTime);

  const address = cleanAddress(input.address);
  const city = cleanCity(input.city);
  const state = cleanState(input.state);
  const notes = input.notes == null ? input.notes : cleanNotes(input.notes);

  // Calculate pricing
  // The booking keeps today's rate, whatever a Super Admin changes later
  const pricing = calculateBookingPricing(service.price, await getCommissionRate());

  // Create the booking
  const booking = await prisma.booking.create({
    data: {
      userId,
      providerId: service.providerId,
      serviceId: service.id,
      status: BookingStatus.PENDING,
      scheduledDate: new Date(input.scheduledDate),
      scheduledTime: input.scheduledTime,
      address,
      city,
      state,
      notes,
      servicePrice: pricing.servicePrice,
      commission: pricing.commission,
      totalAmount: pricing.totalAmount,
    },
    include: {
      user: true,
      provider: {
        include: { user: true }
      },
      service: {
        include: { category: true, provider: true }
      }
    }
  });

  const response = formatBookingResponse(booking);

  // Tell the provider about the request. The booking is already saved, so a
  // failure here is logged rather than returned.
  await dispatchBookingEvent({
    kind: 'created',
    recipientUserId: service.provider.userId,
    bookingId: booking.id,
    serviceName: booking.service.name,
    customerName: fullName(booking.user, 'A customer'),
    bookingPayload: response,
  });

  return response;
};

/**
 * Get user's bookings (as customer)
 */
export const getUserBookings = async (
  userId: string,
  filters: BookingFilters = {},
  pagination: PaginationInput = { page: 1, limit: 10 }
) => {
  const { page, limit } = pagination;
  const skip = (page - 1) * limit;

  const where: any = { userId };

  if (filters.status) {
    where.status = filters.status;
  }

  if (filters.startDate) {
    where.scheduledDate = { ...where.scheduledDate, gte: new Date(filters.startDate) };
  }

  if (filters.endDate) {
    where.scheduledDate = { ...where.scheduledDate, lte: new Date(filters.endDate) };
  }

  const [bookings, total] = await Promise.all([
    prisma.booking.findMany({
      where,
      include: {
        user: true,
        provider: {
          include: { user: true }
        },
        service: {
          include: { category: true, provider: true }
        },
        payment: true,
        review: true
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit
    }),
    prisma.booking.count({ where })
  ]);

  return {
    items: bookings.map(formatBookingResponse),
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
    hasNextPage: page * limit < total,
    hasPreviousPage: page > 1
  };
};

/**
 * Get booking by ID (for user or provider)
 */
export const getBookingById = async (bookingId: string, requesterId: string, role: string) => {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: {
      user: true,
      provider: {
        include: { user: true }
      },
      service: {
        include: { category: true, provider: true }
      },
      payment: true,
      review: true
    }
  });

  if (!booking) {
    throw new GraphQLError('Booking not found', {
      extensions: { code: 'BOOKING_NOT_FOUND' }
    });
  }

  // Check access - user, provider, or admin can view
  const isUser = booking.userId === requesterId;
  const isProvider = booking.provider.userId === requesterId;
  const isAdmin = role === UserRole.ADMIN || role === UserRole.SUPER_ADMIN;

  if (!isUser && !isProvider && !isAdmin) {
    throw new GraphQLError('You do not have permission to view this booking', {
      extensions: { code: 'UNAUTHORIZED' }
    });
  }

  return formatBookingResponse(booking);
};

/**
 * Cancel booking (USER only - before it's accepted or within cancellation window)
 */
export const cancelBooking = async (bookingId: string, userId: string, reason: string) => {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: { service: true }
  });

  if (!booking) {
    throw new GraphQLError('Booking not found', {
      extensions: { code: 'BOOKING_NOT_FOUND' }
    });
  }

  if (booking.userId !== userId) {
    throw new GraphQLError('You can only cancel your own bookings', {
      extensions: { code: 'UNAUTHORIZED' }
    });
  }

  // Can only cancel PENDING or ACCEPTED bookings
  const cancellableStatuses = [BookingStatus.PENDING, BookingStatus.ACCEPTED];
  if (!cancellableStatuses.includes(booking.status as any)) {
    throw new GraphQLError(`Cannot cancel a booking with status: ${booking.status}`, {
      extensions: { code: 'INVALID_BOOKING_STATUS' }
    });
  }

  // If already accepted, check cancellation window (24 hours before the
  // scheduled time, in Lagos time)
  if (booking.status === BookingStatus.ACCEPTED) {
    const scheduledAt = scheduledMoment(booking.scheduledDate.toISOString().slice(0, 10), booking.scheduledTime);

    if (Date.now() > scheduledAt.getTime() - CANCELLATION_WINDOW_MS) {
      throw new GraphQLError('Cannot cancel booking within 24 hours of scheduled time. Please contact the provider.', {
        extensions: { code: 'CANCELLATION_WINDOW_PASSED' }
      });
    }
  }

  const cleanedReason = cleanBookingText(reason, 'Your cancellation reason', BOOKING_TEXT_LIMITS.reason);

  // Only an accepted booking can have been paid
  const wallet = booking.status === BookingStatus.ACCEPTED ? await ensureWallet(booking.userId) : null;

  const refund = await withTransaction(async (tx) => {
    const { count } = await tx.booking.updateMany({
      where: { id: bookingId, status: { in: cancellableStatuses } },
      data: {
        status: BookingStatus.CANCELLED,
        cancelledAt: new Date(),
        cancellationReason: cleanedReason,
      },
    });

    if (count === 0) {
      throw new GraphQLError('This booking can no longer be cancelled', {
        extensions: { code: 'INVALID_BOOKING_STATUS' }
      });
    }

    return refundIfPaid(tx, bookingId, wallet?.id, {
      reason: 'Booking cancelled by the customer',
    });
  });

  const cancelledBooking = await prisma.booking.findUniqueOrThrow({
    where: { id: bookingId },
    include: {
      user: true,
      provider: {
        include: { user: true }
      },
      service: {
        include: { category: true, provider: true }
      }
    }
  });

  const response = formatBookingResponse(cancelledBooking);

  // Customer cancelled -> notify the provider (their user account)
  await dispatchBookingEvent({
    kind: 'cancelled',
    recipientUserId: cancelledBooking.provider.user.id,
    bookingId: cancelledBooking.id,
    serviceName: cancelledBooking.service.name,
    cancelledByLabel: fullName(cancelledBooking.user, 'the customer'),
    reason: cleanedReason,
    bookingPayload: response,
  });

  if (refund) {
    await notifyWalletRefund(cancelledBooking.userId, bookingId, cancelledBooking.service.name, refund.refundKobo);
  }

  return response;
};

/**
 * Update booking (USER only - before it's accepted)
 */
export const updateBooking = async (bookingId: string, userId: string, input: UpdateBookingInput) => {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId }
  });

  if (!booking) {
    throw new GraphQLError('Booking not found', {
      extensions: { code: 'BOOKING_NOT_FOUND' }
    });
  }

  if (booking.userId !== userId) {
    throw new GraphQLError('You can only update your own bookings', {
      extensions: { code: 'UNAUTHORIZED' }
    });
  }

  // Can only update PENDING bookings
  if (booking.status !== BookingStatus.PENDING) {
    throw new GraphQLError('Can only update pending bookings', {
      extensions: { code: 'INVALID_BOOKING_STATUS' }
    });
  }

  // Validate new date/time if provided, combined with the current values
  if (input.scheduledDate || input.scheduledTime) {
    const newDate = input.scheduledDate || booking.scheduledDate.toISOString().slice(0, 10);
    const newTime = input.scheduledTime || booking.scheduledTime;
    validateBookingDateTime(newDate, newTime);
  }

  // Empty address, city and state keep the current value
  const address = input.address ? cleanAddress(input.address) : '';
  const city = input.city ? cleanCity(input.city) : '';
  const state = input.state ? cleanState(input.state) : '';

  // Conditional, so a booking accepted, rejected or cancelled meanwhile isn't changed
  const { count } = await prisma.booking.updateMany({
    where: { id: bookingId, status: BookingStatus.PENDING },
    data: {
      ...(input.scheduledDate && { scheduledDate: new Date(input.scheduledDate) }),
      ...(input.scheduledTime && { scheduledTime: input.scheduledTime }),
      ...(address && { address }),
      ...(city && { city }),
      ...(state && { state }),
      ...(input.notes !== undefined && { notes: input.notes === null ? null : cleanNotes(input.notes) }),
    },
  });

  if (count === 0) {
    throw bookingChanged();
  }

  const updatedBooking = await prisma.booking.findUniqueOrThrow({
    where: { id: bookingId },
    include: {
      user: true,
      provider: {
        include: { user: true }
      },
      service: {
        include: { category: true, provider: true }
      }
    }
  });

  return formatBookingResponse(updatedBooking);
};

// ==================
// Provider Booking Functions
// ==================

/**
 * Get provider's bookings
 */
export const getProviderBookings = async (
  userId: string,
  filters: BookingFilters = {},
  pagination: PaginationInput = { page: 1, limit: 10 }
) => {
  // Get provider profile
  const provider = await prisma.serviceProvider.findUnique({
    where: { userId }
  });

  if (!provider) {
    throw new GraphQLError('Provider profile not found', {
      extensions: { code: 'PROVIDER_NOT_FOUND' }
    });
  }

  const { page, limit } = pagination;
  const skip = (page - 1) * limit;

  const where: any = { providerId: provider.id };

  if (filters.status) {
    where.status = filters.status;
  }

  if (filters.startDate) {
    where.scheduledDate = { ...where.scheduledDate, gte: new Date(filters.startDate) };
  }

  if (filters.endDate) {
    where.scheduledDate = { ...where.scheduledDate, lte: new Date(filters.endDate) };
  }

  const [bookings, total] = await Promise.all([
    prisma.booking.findMany({
      where,
      include: {
        user: true,
        provider: {
          include: { user: true }
        },
        service: {
          include: { category: true, provider: true }
        },
        payment: true,
        review: true
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit
    }),
    prisma.booking.count({ where })
  ]);

  return {
    items: bookings.map(formatBookingResponse),
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
    hasNextPage: page * limit < total,
    hasPreviousPage: page > 1
  };
};

interface BookingEventSource {
  id: string;
  status: string;
  scheduledDate: Date | string;
  scheduledTime: string;
  totalAmount: number;
  cancellationReason?: string | null;
  updatedAt: Date | string;
  service?: { id: string; name: string } | null;
  provider?: { id: string; businessName: string } | null;
  user?: { id: string; firstName: string; lastName: string; profilePhoto?: string | null } | null;
}

const toIsoString = (value: Date | string) => (value instanceof Date ? value.toISOString() : value);

/**
 * What a booking socket event carries: enough for the app to update the
 * booking in place or refetch it. Only these summary fields are sent, never the
 * full records loaded for the booking.
 */
const toBookingEventPayload = (booking: BookingEventSource) => ({
  id: booking.id,
  status: booking.status,
  scheduledDate: toIsoString(booking.scheduledDate),
  scheduledTime: booking.scheduledTime,
  totalAmount: booking.totalAmount,
  cancellationReason: booking.cancellationReason ?? null,
  updatedAt: toIsoString(booking.updatedAt),
  service: booking.service ? { id: booking.service.id, name: booking.service.name } : null,
  provider: booking.provider
    ? { id: booking.provider.id, businessName: booking.provider.businessName }
    : null,
  user: booking.user
    ? {
        id: booking.user.id,
        firstName: booking.user.firstName,
        lastName: booking.user.lastName,
        profilePhoto: booking.user.profilePhoto ?? null,
      }
    : null,
});

/**
 * What the provider is told when the customer confirms delivery
 */
const deliveryConfirmedMessage = (
  customerName: string,
  serviceName: string,
  paymentReleaseAt: Date,
  providerPayout?: number | null
) => {
  const amount =
    typeof providerPayout === 'number'
      ? `₦${providerPayout.toLocaleString('en-NG', { maximumFractionDigits: 2 })}`
      : 'Your payment';

  return `${customerName} confirmed delivery of ${serviceName}. ${amount} will be released to your wallet on ${formatLagosDateTime(paymentReleaseAt)} (Lagos time), unless a dispute is opened before then.`;
};

/**
 * Fan out a booking event to: socket emit, in-app notification, push.
 * Failures are swallowed (logged) — the DB change has already succeeded
 * and a downstream messaging hiccup must not roll it back.
 */
type BookingEventKind = 'created' | 'accepted' | 'rejected' | 'started' | 'completed' | 'cancelled' | 'confirmed';
const dispatchBookingEvent = async (params: {
  kind: BookingEventKind;
  recipientUserId: string;
  bookingId: string;
  serviceName: string;
  providerName?: string;
  customerName?: string;
  reason?: string;
  cancelledByLabel?: string;
  paymentReleaseAt?: Date;
  providerPayout?: number | null;
  bookingPayload: BookingEventSource;
}) => {
  const { kind, recipientUserId, bookingId, serviceName, providerName, reason, cancelledByLabel, bookingPayload } = params;

  const confirmation =
    kind === 'confirmed' && params.paymentReleaseAt
      ? deliveryConfirmedMessage(params.customerName ?? 'The customer', serviceName, params.paymentReleaseAt, params.providerPayout)
      : '';

  // 1. Real-time socket event
  try {
    await emitToUser(recipientUserId, `booking:${kind}`, {
      bookingId,
      booking: toBookingEventPayload(bookingPayload),
    });
  } catch (err) {
    logger.error('Failed to emit booking socket event', { kind, bookingId, err });
  }

  // 2. In-app notification (DB row)
  try {
    if (kind === 'created') {
      await notifyBookingCreated(recipientUserId, bookingId, serviceName, params.customerName ?? 'A customer');
    } else if (kind === 'accepted') {
      await notifyBookingAccepted(recipientUserId, bookingId, serviceName, providerName ?? 'The provider');
    } else if (kind === 'rejected') {
      await notifyBookingRejected(recipientUserId, bookingId, serviceName, reason);
    } else if (kind === 'started') {
      await notifyBookingStarted(recipientUserId, bookingId, serviceName);
    } else if (kind === 'completed') {
      await notifyBookingCompleted(recipientUserId, bookingId, serviceName);
    } else if (kind === 'cancelled') {
      await notifyBookingCancelled(recipientUserId, bookingId, serviceName, cancelledByLabel ?? 'the other party', reason);
    } else if (kind === 'confirmed') {
      await createNotification({
        userId: recipientUserId,
        type: NotificationType.BOOKING_COMPLETED,
        title: DELIVERY_CONFIRMED_TITLE,
        message: confirmation,
        entityType: 'booking',
        entityId: bookingId,
      });
    }
  } catch (err) {
    logger.error('Failed to write booking notification', { kind, bookingId, err });
  }

  // 3. Push notification (there's no push for 'started')
  try {
    if (kind === 'confirmed') {
      await sendPushToUser(recipientUserId, {
        title: DELIVERY_CONFIRMED_TITLE,
        message: confirmation,
        data: { type: 'BOOKING', bookingId, action: 'confirmed' },
      });
    } else if (kind !== 'started') {
      await sendBookingPush(recipientUserId, kind === 'created' ? 'new' : kind, bookingId, serviceName);
    }
  } catch (err) {
    logger.error('Failed to send booking push', { kind, bookingId, err });
  }
};

/**
 * Inside a cancellation's transaction: refund the booking's payment to the
 * customer's wallet if it has been paid
 */
const refundIfPaid = async (
  tx: TransactionClient,
  bookingId: string,
  walletId: string | undefined,
  options: { reason: string; refundedBy?: string }
) => {
  const payment = await tx.payment.findUnique({ where: { bookingId } });

  if (payment?.status !== PaymentStatus.COMPLETED) return null;

  if (!walletId) {
    throw new GraphQLError('This booking was just paid. Please try again.', {
      extensions: { code: 'BOOKING_CHANGED' }
    });
  }

  return refundPaymentToWallet(tx, walletId, {
    paymentId: payment.id,
    reason: options.reason,
    via: 'CANCELLATION',
    refundedBy: options.refundedBy,
  });
};

/**
 * Tell the customer a refund reached their wallet. Failures are logged: the
 * refund has already been made.
 */
const notifyWalletRefund = async (userId: string, bookingId: string, serviceName: string, refundKobo: number) => {
  const title = 'Refund added to your wallet';
  const message = `₦${koboToNaira(refundKobo).toLocaleString()} for ${serviceName} has been added to your Easykonnet wallet.`;

  try {
    await createNotification({
      userId,
      type: NotificationType.REFUND_PROCESSED,
      title,
      message,
      entityType: 'booking',
      entityId: bookingId,
    });
  } catch (err) {
    logger.error('Failed to write refund notification', { bookingId, err });
  }

  try {
    await sendPushToUser(userId, {
      title,
      message,
      data: { type: NotificationType.REFUND_PROCESSED, bookingId },
    });
  } catch (err) {
    logger.error('Failed to send refund push', { bookingId, err });
  }
};

/**
 * Accept booking (PROVIDER only)
 */
export const acceptBooking = async (bookingId: string, userId: string) => {
  const provider = await prisma.serviceProvider.findUnique({
    where: { userId }
  });

  if (!provider) {
    throw new GraphQLError('Provider profile not found', {
      extensions: { code: 'PROVIDER_NOT_FOUND' }
    });
  }

  const booking = await prisma.booking.findUnique({
    where: { id: bookingId }
  });

  if (!booking) {
    throw new GraphQLError('Booking not found', {
      extensions: { code: 'BOOKING_NOT_FOUND' }
    });
  }

  if (booking.providerId !== provider.id) {
    throw new GraphQLError('You can only accept bookings for your services', {
      extensions: { code: 'UNAUTHORIZED' }
    });
  }

  if (booking.status !== BookingStatus.PENDING) {
    throw new GraphQLError(`Cannot accept a booking with status: ${booking.status}`, {
      extensions: { code: 'INVALID_BOOKING_STATUS' }
    });
  }

  // A request can't be accepted once either person has blocked the other.
  // Bookings accepted before the block carry on.
  if (await isBlockedBetween(booking.userId, userId)) {
    throw new GraphQLError("You can't accept this booking", {
      extensions: { code: 'BOOKING_NOT_ALLOWED' }
    });
  }

  // Conditional, so a booking cancelled meanwhile isn't accepted
  const { count } = await prisma.booking.updateMany({
    where: { id: bookingId, status: BookingStatus.PENDING },
    data: { status: BookingStatus.ACCEPTED },
  });

  if (count === 0) {
    throw bookingChanged();
  }

  const acceptedBooking = await prisma.booking.findUniqueOrThrow({
    where: { id: bookingId },
    include: {
      user: true,
      provider: {
        include: { user: true }
      },
      service: {
        include: { category: true, provider: true }
      }
    }
  });

  const response = formatBookingResponse(acceptedBooking);

  await dispatchBookingEvent({
    kind: 'accepted',
    recipientUserId: acceptedBooking.userId,
    bookingId: acceptedBooking.id,
    serviceName: acceptedBooking.service.name,
    providerName: acceptedBooking.provider.businessName,
    bookingPayload: response,
  });

  return response;
};

/**
 * Reject booking (PROVIDER only)
 */
export const rejectBooking = async (bookingId: string, userId: string, reason: string) => {
  const provider = await prisma.serviceProvider.findUnique({
    where: { userId }
  });

  if (!provider) {
    throw new GraphQLError('Provider profile not found', {
      extensions: { code: 'PROVIDER_NOT_FOUND' }
    });
  }

  const booking = await prisma.booking.findUnique({
    where: { id: bookingId }
  });

  if (!booking) {
    throw new GraphQLError('Booking not found', {
      extensions: { code: 'BOOKING_NOT_FOUND' }
    });
  }

  if (booking.providerId !== provider.id) {
    throw new GraphQLError('You can only reject bookings for your services', {
      extensions: { code: 'UNAUTHORIZED' }
    });
  }

  if (booking.status !== BookingStatus.PENDING) {
    throw new GraphQLError(`Cannot reject a booking with status: ${booking.status}`, {
      extensions: { code: 'INVALID_BOOKING_STATUS' }
    });
  }

  const cleanedReason = cleanBookingText(reason, 'Your rejection reason', BOOKING_TEXT_LIMITS.reason);

  // Conditional, so a booking cancelled meanwhile isn't overwritten
  const { count } = await prisma.booking.updateMany({
    where: { id: bookingId, status: BookingStatus.PENDING },
    data: {
      status: BookingStatus.REJECTED,
      cancellationReason: cleanedReason,
    },
  });

  if (count === 0) {
    throw bookingChanged();
  }

  const rejectedBooking = await prisma.booking.findUniqueOrThrow({
    where: { id: bookingId },
    include: {
      user: true,
      provider: {
        include: { user: true }
      },
      service: {
        include: { category: true, provider: true }
      }
    }
  });

  const response = formatBookingResponse(rejectedBooking);

  await dispatchBookingEvent({
    kind: 'rejected',
    recipientUserId: rejectedBooking.userId,
    bookingId: rejectedBooking.id,
    serviceName: rejectedBooking.service.name,
    reason: cleanedReason,
    bookingPayload: response,
  });

  return response;
};

/**
 * Start service (PROVIDER only - marks booking as IN_PROGRESS)
 */
export const startService = async (bookingId: string, userId: string) => {
  const provider = await prisma.serviceProvider.findUnique({
    where: { userId }
  });

  if (!provider) {
    throw new GraphQLError('Provider profile not found', {
      extensions: { code: 'PROVIDER_NOT_FOUND' }
    });
  }

  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: { payment: true },
  });

  if (!booking) {
    throw new GraphQLError('Booking not found', {
      extensions: { code: 'BOOKING_NOT_FOUND' }
    });
  }

  if (booking.providerId !== provider.id) {
    throw new GraphQLError('You can only start your own service bookings', {
      extensions: { code: 'UNAUTHORIZED' }
    });
  }

  if (booking.status !== BookingStatus.ACCEPTED) {
    throw new GraphQLError(
      `Cannot start a booking with status: ${booking.status}. Booking must be ACCEPTED before it can be started.`,
      { extensions: { code: 'INVALID_BOOKING_STATUS' } }
    );
  }

  if (booking.payment?.status !== PaymentStatus.COMPLETED) {
    throw new GraphQLError(
      'Customer has not paid yet. Service can only start after payment is confirmed.',
      { extensions: { code: 'PAYMENT_REQUIRED' } }
    );
  }

  // Conditional, so a booking cancelled or disputed meanwhile isn't restarted
  const { count } = await prisma.booking.updateMany({
    where: { id: bookingId, status: BookingStatus.ACCEPTED },
    data: { status: BookingStatus.IN_PROGRESS },
  });

  if (count === 0) {
    throw bookingChanged();
  }

  const inProgressBooking = await prisma.booking.findUniqueOrThrow({
    where: { id: bookingId },
    include: {
      user: true,
      provider: {
        include: { user: true }
      },
      service: {
        include: { category: true, provider: true }
      }
    }
  });

  const response = formatBookingResponse(inProgressBooking);

  await dispatchBookingEvent({
    kind: 'started',
    recipientUserId: inProgressBooking.userId,
    bookingId: inProgressBooking.id,
    serviceName: inProgressBooking.service.name,
    bookingPayload: response,
  });

  return response;
};

/**
 * Complete service (PROVIDER only - marks booking as COMPLETED)
 */
export const completeService = async (bookingId: string, userId: string) => {
  const provider = await prisma.serviceProvider.findUnique({
    where: { userId }
  });

  if (!provider) {
    throw new GraphQLError('Provider profile not found', {
      extensions: { code: 'PROVIDER_NOT_FOUND' }
    });
  }

  const booking = await prisma.booking.findUnique({
    where: { id: bookingId }
  });

  if (!booking) {
    throw new GraphQLError('Booking not found', {
      extensions: { code: 'BOOKING_NOT_FOUND' }
    });
  }

  if (booking.providerId !== provider.id) {
    throw new GraphQLError('You can only complete your own service bookings', {
      extensions: { code: 'UNAUTHORIZED' }
    });
  }

  if (booking.status !== BookingStatus.IN_PROGRESS) {
    throw new GraphQLError(`Cannot complete a booking with status: ${booking.status}. Service must be IN_PROGRESS.`, {
      extensions: { code: 'INVALID_BOOKING_STATUS' }
    });
  }

  // Conditional, so a booking cancelled or disputed meanwhile isn't completed
  const { count } = await prisma.booking.updateMany({
    where: { id: bookingId, status: BookingStatus.IN_PROGRESS },
    data: {
      status: BookingStatus.COMPLETED,
      completedAt: new Date(),
    },
  });

  if (count === 0) {
    throw bookingChanged();
  }

  const completedBooking = await prisma.booking.findUniqueOrThrow({
    where: { id: bookingId },
    include: {
      user: true,
      provider: {
        include: { user: true }
      },
      service: {
        include: { category: true, provider: true }
      }
    }
  });

  const response = formatBookingResponse(completedBooking);

  await dispatchBookingEvent({
    kind: 'completed',
    recipientUserId: completedBooking.userId,
    bookingId: completedBooking.id,
    serviceName: completedBooking.service.name,
    bookingPayload: response,
  });

  return response;
};

/**
 * Confirm service delivery (USER only)
 * The payment is released to the provider RELEASE_DELAY_HOURS later, unless a
 * dispute is raised first
 */
export const confirmServiceDelivery = async (bookingId: string, userId: string) => {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: {
      payment: true,
      user: true,
      provider: {
        include: { user: true }
      },
      service: true,
    }
  });

  if (!booking) {
    throw new GraphQLError('Booking not found', {
      extensions: { code: 'BOOKING_NOT_FOUND' }
    });
  }

  // Verify user owns this booking
  if (booking.userId !== userId) {
    throw new GraphQLError('You can only confirm delivery for your own bookings', {
      extensions: { code: 'UNAUTHORIZED' }
    });
  }

  // Must be in COMPLETED status (provider marked as done)
  if (booking.status !== BookingStatus.COMPLETED) {
    throw new GraphQLError(
      `Cannot confirm delivery for a booking with status: ${booking.status}. Service must be marked as completed by the provider first.`,
      { extensions: { code: 'INVALID_BOOKING_STATUS' } }
    );
  }

  // Check if already confirmed
  if (booking.customerConfirmedAt) {
    throw new GraphQLError('Service delivery has already been confirmed', {
      extensions: { code: 'ALREADY_CONFIRMED' }
    });
  }

  // Check if payment exists and is completed
  if (!booking.payment || booking.payment.status !== 'COMPLETED') {
    throw new GraphQLError('Payment must be completed before confirming delivery', {
      extensions: { code: 'PAYMENT_NOT_COMPLETED' }
    });
  }

  const now = new Date();
  const paymentReleaseAt = new Date(now.getTime() + RELEASE_DELAY_HOURS * 60 * 60 * 1000);

  // Conditional, so a second confirmation can't push the release back
  const { count } = await prisma.booking.updateMany({
    where: {
      id: bookingId,
      status: BookingStatus.COMPLETED,
      OR: [{ customerConfirmedAt: null }, { customerConfirmedAt: { isSet: false } }],
    },
    data: {
      customerConfirmedAt: now,
      paymentReleaseAt,
    },
  });

  if (count === 0) {
    throw new GraphQLError('Service delivery has already been confirmed', {
      extensions: { code: 'ALREADY_CONFIRMED' }
    });
  }

  const confirmedBooking = await prisma.booking.findUniqueOrThrow({
    where: { id: bookingId },
    include: {
      user: true,
      provider: {
        include: { user: true }
      },
      service: {
        include: { category: true, provider: true }
      },
      payment: true,
    }
  });

  // Update payment withdrawableAt
  await prisma.payment.update({
    where: { id: booking.payment.id },
    data: {
      withdrawableAt: paymentReleaseAt,
    }
  });

  const response = formatBookingResponse(confirmedBooking);

  // Tell the provider when their money will arrive
  await dispatchBookingEvent({
    kind: 'confirmed',
    recipientUserId: confirmedBooking.provider.user.id,
    bookingId,
    serviceName: confirmedBooking.service.name,
    customerName: fullName(confirmedBooking.user, 'The customer'),
    paymentReleaseAt,
    providerPayout: confirmedBooking.payment?.providerPayout,
    bookingPayload: response,
  });

  return response;
};

// ==================
// Admin Booking Functions
// ==================

/**
 * Get all bookings (ADMIN only)
 */
export const getAllBookings = async (
  filters: BookingFilters = {},
  pagination: PaginationInput = { page: 1, limit: 10 }
) => {
  const { page, limit } = pagination;
  const skip = (page - 1) * limit;

  const where: any = {};

  if (filters.status) {
    where.status = filters.status;
  }

  if (filters.startDate) {
    where.scheduledDate = { ...where.scheduledDate, gte: new Date(filters.startDate) };
  }

  if (filters.endDate) {
    where.scheduledDate = { ...where.scheduledDate, lte: new Date(filters.endDate) };
  }

  const [bookings, total] = await Promise.all([
    prisma.booking.findMany({
      where,
      include: {
        user: true,
        provider: {
          include: { user: true }
        },
        service: {
          include: { category: true, provider: true }
        },
        payment: true,
        review: true
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit
    }),
    prisma.booking.count({ where })
  ]);

  return {
    items: bookings.map(formatBookingResponse),
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
    hasNextPage: page * limit < total,
    hasPreviousPage: page > 1
  };
};

/**
 * Admin cancel booking. A paid booking is refunded to the customer's wallet.
 */
export const adminCancelBooking = async (
  bookingId: string,
  reason: string,
  admin?: { id: string; role: string }
) => {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId }
  });

  if (!booking) {
    throw new GraphQLError('Booking not found', {
      extensions: { code: 'BOOKING_NOT_FOUND' }
    });
  }

  // A dispute decides where a disputed booking's money goes
  if (booking.status === BookingStatus.DISPUTED) {
    throw new GraphQLError('This booking has an open dispute. Resolve the dispute instead of cancelling the booking.', {
      extensions: { code: 'INVALID_BOOKING_STATUS' }
    });
  }

  const cancellableStatuses = [BookingStatus.PENDING, BookingStatus.ACCEPTED, BookingStatus.IN_PROGRESS];

  if (!(cancellableStatuses as string[]).includes(booking.status)) {
    throw new GraphQLError(`Cannot cancel a booking with status: ${booking.status}`, {
      extensions: { code: 'INVALID_BOOKING_STATUS' }
    });
  }

  // Support may point people to a phone number or email, so contact details are allowed
  const cleanedReason = cleanBookingText(reason, 'The cancellation reason', BOOKING_TEXT_LIMITS.reason, {
    allowContactDetails: true,
  });

  // Only accepted bookings can have been paid
  const wallet = booking.status === BookingStatus.PENDING ? null : await ensureWallet(booking.userId);

  const refund = await withTransaction(async (tx) => {
    const { count } = await tx.booking.updateMany({
      where: { id: bookingId, status: { in: cancellableStatuses } },
      data: {
        status: BookingStatus.CANCELLED,
        cancelledAt: new Date(),
        cancellationReason: `[Admin] ${cleanedReason}`,
      },
    });

    if (count === 0) {
      throw new GraphQLError('This booking can no longer be cancelled', {
        extensions: { code: 'INVALID_BOOKING_STATUS' }
      });
    }

    return refundIfPaid(tx, bookingId, wallet?.id, {
      reason: `Booking cancelled by Easykonnet: ${cleanedReason}`,
      refundedBy: admin?.id,
    });
  });

  const cancelledBooking = await prisma.booking.findUniqueOrThrow({
    where: { id: bookingId },
    include: {
      user: true,
      provider: {
        include: { user: true }
      },
      service: {
        include: { category: true, provider: true }
      }
    }
  });

  const response = formatBookingResponse(cancelledBooking);

  await Promise.all(
    [cancelledBooking.userId, cancelledBooking.provider.user.id].map((recipientUserId) =>
      dispatchBookingEvent({
        kind: 'cancelled',
        recipientUserId,
        bookingId,
        serviceName: cancelledBooking.service.name,
        cancelledByLabel: 'Easykonnet support',
        reason: cleanedReason,
        bookingPayload: response,
      })
    )
  );

  if (refund) {
    await notifyWalletRefund(cancelledBooking.userId, bookingId, cancelledBooking.service.name, refund.refundKobo);

    if (admin) {
      try {
        await createAuditLog({
          action: AdminAction.PROCESS_REFUND,
          targetType: 'Booking',
          targetId: bookingId,
          performedBy: admin.id,
          performedByRole: admin.role,
          previousValue: { status: booking.status },
          newValue: {
            status: BookingStatus.CANCELLED,
            refundAmount: koboToNaira(refund.refundKobo),
            refundedTo: 'wallet',
          },
          reason: cleanedReason,
        });
      } catch (err) {
        logger.error('Failed to write cancellation audit log', { bookingId, err });
      }
    }
  }

  return response;
};

// ==================
// Statistics Functions
// ==================

/**
 * Get booking statistics for provider dashboard
 */
export const getProviderBookingStats = async (userId: string) => {
  const provider = await prisma.serviceProvider.findUnique({
    where: { userId }
  });

  if (!provider) {
    throw new GraphQLError('Provider profile not found', {
      extensions: { code: 'PROVIDER_NOT_FOUND' }
    });
  }

  const [
    totalBookings,
    pendingBookings,
    completedBookings,
    cancelledBookings,
    revenue
  ] = await Promise.all([
    prisma.booking.count({ where: { providerId: provider.id } }),
    prisma.booking.count({ where: { providerId: provider.id, status: BookingStatus.PENDING } }),
    prisma.booking.count({ where: { providerId: provider.id, status: BookingStatus.COMPLETED } }),
    prisma.booking.count({ where: { providerId: provider.id, status: BookingStatus.CANCELLED } }),
    // The provider's share of paid, completed bookings. providerPayout is
    // already net of commission and of any partial refund; a fully refunded
    // payment is REFUNDED and left out. Released and still-held payments count.
    prisma.payment.aggregate({
      where: {
        status: PaymentStatus.COMPLETED,
        booking: { providerId: provider.id, status: BookingStatus.COMPLETED },
      },
      _sum: { providerPayout: true },
    }),
  ]);

  return {
    totalBookings,
    pendingBookings,
    completedBookings,
    cancelledBookings,
    totalRevenue: Math.round((revenue._sum.providerPayout ?? 0) * 100) / 100,
    // Percentage with one decimal place, e.g. 78.8
    completionRate: totalBookings > 0 ? Math.round((completedBookings / totalBookings) * 1000) / 10 : 0
  };
};

/**
 * Get booking statistics for user dashboard
 */
export const getUserBookingStats = async (userId: string) => {
  const [
    totalBookings,
    pendingBookings,
    completedBookings,
    cancelledBookings,
    totalSpent
  ] = await Promise.all([
    prisma.booking.count({ where: { userId } }),
    prisma.booking.count({ where: { userId, status: BookingStatus.PENDING } }),
    prisma.booking.count({ where: { userId, status: BookingStatus.COMPLETED } }),
    prisma.booking.count({ where: { userId, status: BookingStatus.CANCELLED } }),
    prisma.booking.aggregate({
      where: { userId, status: BookingStatus.COMPLETED },
      _sum: { totalAmount: true }
    })
  ]);

  return {
    totalBookings,
    pendingBookings,
    completedBookings,
    cancelledBookings,
    totalSpent: totalSpent._sum.totalAmount || 0
  };
};
