/**
 * Dispute Service
 * Handles booking dispute operations
 *
 * Features:
 * - Users or providers can raise disputes on bookings, until the payment has
 *   been released to the provider. Active admins are alerted.
 * - An admin can take a dispute under review, which records who took it and
 *   tells both parties
 * - Admin reviews and resolves disputes, and the resolution moves the money:
 *   - REFUND_FULL: everything not yet refunded goes to the customer's wallet
 *     and the booking is cancelled
 *   - REFUND_PARTIAL, or MUTUAL_AGREEMENT with a refund: that amount goes to
 *     the customer's wallet and the rest is released to the provider now
 *   - NO_REFUND, DISMISSED, or MUTUAL_AGREEMENT without a refund: the booking
 *     returns to the status it had; a finished, paid job is released now
 *   - REDO_SERVICE: the booking goes back to ACCEPTED and the money stays held
 *     until the redone job is confirmed
 * - Evidence is files uploaded to Easykonnet's Cloudinary account, at most 10
 *   per dispute
 */

import { GraphQLError } from 'graphql';
import {
  AdminAction,
  type BookingStatus as BookingStatusValue,
  type DisputeResolution as DisputeResolutionValue,
  type Prisma,
} from '@prisma/client';
import prisma from '@/lib/prisma';
import { CloudinaryFolders } from '@/lib/cloudinary';
import { withTransaction } from '@/lib/transaction';
import {
  AUTO_RELEASE_DAYS,
  BookingStatus,
  DisputeStatus,
  DisputeResolution,
  NotificationType,
  PaymentStatus,
  RELEASE_DELAY_HOURS,
  UserRole,
} from '@/constants';
import { sanitizeBasic, validateText, MAX_LENGTHS } from '@/utils/security';
import { createAuditLog } from './audit.service';
import { refundableKobo, refundPaymentToWallet } from './escrow.service';
import { createBulkNotifications, createNotification } from './notification.service';
import { sendPushToUser } from './push.service';
import { extractOwnedAsset } from './upload.service';
import { ensureWallet, koboToNaira, nairaToKobo } from './wallet.service';

// ==================
// Types
// ==================

interface CreateDisputeInput {
  bookingId: string;
  reason: string;
  description: string;
  evidence?: string[];
}

interface ResolveDisputeInput {
  resolution: string;
  resolutionNotes: string;
  refundAmount?: number | null; // Naira
}

interface DisputeFilters {
  status?: string;
  raisedByRole?: string;
}

interface PaginationInput {
  page: number;
  limit: number;
}

// ==================
// Constants
// ==================

export const MAX_EVIDENCE = 10;
const DAY_MS = 24 * 60 * 60 * 1000;
const ADMIN_ROLES: string[] = [UserRole.ADMIN, UserRole.SUPER_ADMIN];

// ==================
// Helper Functions
// ==================

const disputeInclude = {
  booking: {
    include: {
      user: true,
      provider: {
        include: { user: true },
      },
      service: true,
    },
  },
} satisfies Prisma.DisputeInclude;

type DisputeWithBooking = Prisma.DisputeGetPayload<{ include: typeof disputeInclude }>;

/**
 * Format dispute response for GraphQL
 */
const formatDisputeResponse = (dispute: DisputeWithBooking) => ({
  id: dispute.id,
  reason: dispute.reason,
  description: dispute.description,
  evidence: dispute.evidence,
  status: dispute.status,
  raisedByRole: dispute.raisedByRole,
  // Returned to admins only (see the Dispute field resolvers)
  reviewedBy: dispute.reviewedById ?? null,
  reviewStartedAt: dispute.reviewStartedAt?.toISOString() ?? null,
  resolution: dispute.resolution,
  resolutionNotes: dispute.resolutionNotes,
  refundAmount: dispute.refundAmount,
  resolvedAt: dispute.resolvedAt?.toISOString() || null,
  createdAt: dispute.createdAt.toISOString(),
  updatedAt: dispute.updatedAt.toISOString(),
  booking: dispute.booking ? {
    id: dispute.booking.id,
    status: dispute.booking.status,
    scheduledDate: dispute.booking.scheduledDate.toISOString().split('T')[0],
    scheduledTime: dispute.booking.scheduledTime,
    servicePrice: dispute.booking.servicePrice,
    totalAmount: dispute.booking.totalAmount,
    user: dispute.booking.user ? {
      id: dispute.booking.user.id,
      firstName: dispute.booking.user.firstName,
      lastName: dispute.booking.user.lastName,
      email: dispute.booking.user.email,
    } : null,
    provider: dispute.booking.provider ? {
      id: dispute.booking.provider.id,
      businessName: dispute.booking.provider.businessName,
      user: dispute.booking.provider.user ? {
        id: dispute.booking.provider.user.id,
        firstName: dispute.booking.provider.user.firstName,
        lastName: dispute.booking.provider.user.lastName,
        email: dispute.booking.provider.user.email,
      } : null,
    } : null,
    service: dispute.booking.service ? {
      id: dispute.booking.service.id,
      name: dispute.booking.service.name,
      price: dispute.booking.service.price,
    } : null,
  } : null,
});

/**
 * The same error for a booking that doesn't exist and for one the caller
 * isn't on, so outsiders learn nothing about it
 */
const bookingNotFound = () =>
  new GraphQLError('Booking not found', {
    extensions: { code: 'NOT_FOUND' },
  });

const tooMuchEvidence = () =>
  new GraphQLError(`Maximum ${MAX_EVIDENCE} evidence files allowed`, {
    extensions: { code: 'MAX_EVIDENCE_EXCEEDED' },
  });

/**
 * Whether a URL is an https link to an evidence file `userId` uploaded to
 * Easykonnet's Cloudinary account: in the evidence folder, and named
 * `<userId>_...` as getEvidenceUploadParams uploads are
 */
export const isEvidenceUrl = (value: string, userId: string): boolean => {
  if (typeof value !== 'string' || value !== value.trim() || value.length > MAX_LENGTHS.URL) {
    return false;
  }

  if (!value.startsWith('https://')) return false;

  const asset = extractOwnedAsset(value, userId);
  return Boolean(asset && asset.publicId.startsWith(`${CloudinaryFolders.EVIDENCE}/`));
};

const checkEvidenceUrls = (urls: string[], userId: string) => {
  if (!urls.every((url) => isEvidenceUrl(url, userId))) {
    throw new GraphQLError(
      'Evidence must be files you uploaded through Easykonnet. Upload each file first, then send the URL you get back.',
      { extensions: { code: 'INVALID_EVIDENCE_URL' } }
    );
  }
};

/**
 * In-app notification and push. Failures are logged, never thrown: the change
 * they describe has already been saved. The push carries the DISPUTE_* type,
 * so it follows the user's notifyDisputeUpdates setting; the in-app
 * notification is always saved.
 */
const notifyUser = async (
  userId: string,
  type: string,
  title: string,
  message: string,
  disputeId: string,
  metadata: Record<string, string>
) => {
  let notificationId: string | undefined;

  try {
    const notification = await createNotification({
      userId,
      type,
      title,
      message,
      entityType: 'dispute',
      entityId: disputeId,
      metadata,
    });
    notificationId = notification?.id;
  } catch (error) {
    console.error('Failed to write dispute notification:', error);
  }

  try {
    await sendPushToUser(userId, {
      title,
      message,
      data: { type, disputeId, ...metadata },
      ...(notificationId ? { notificationId } : {}),
    });
  } catch (error) {
    console.error('Failed to send dispute push:', error);
  }
};

/**
 * Tell every active admin a dispute is waiting for a decision. Failures are
 * logged: the dispute is saved and in the admin queue either way.
 */
const alertAdmins = async (params: {
  disputeId: string;
  bookingId: string;
  serviceName: string;
  raisedByCustomer: boolean;
  reopened: boolean;
}) => {
  const { disputeId, bookingId, serviceName, raisedByCustomer, reopened } = params;
  const raiser = raisedByCustomer ? 'customer' : 'provider';

  try {
    const admins = await prisma.user.findMany({
      where: { role: { in: ['ADMIN', 'SUPER_ADMIN'] }, status: 'ACTIVE' },
      select: { id: true },
    });

    if (admins.length === 0) return;

    await createBulkNotifications(
      admins.map((admin) => admin.id),
      NotificationType.DISPUTE_OPENED,
      reopened ? 'Dispute reopened' : 'New dispute to review',
      reopened
        ? `The ${raiser} reopened the dispute about the booking of ${serviceName}.`
        : `The ${raiser} opened a dispute about the booking of ${serviceName}.`,
      'dispute',
      disputeId,
      { disputeId, bookingId }
    );
  } catch (error) {
    console.error('Failed to alert admins about a dispute:', error);
  }
};

// ==================
// Dispute Functions
// ==================

/**
 * Create a dispute for a booking (User or Provider)
 */
export const createDispute = async (
  userId: string,
  userRole: string,
  input: CreateDisputeInput
) => {
  const { bookingId, reason, description, evidence = [] } = input;

  // Validate reason length
  if (!reason || reason.trim().length < 10) {
    throw new GraphQLError('Dispute reason must be at least 10 characters', {
      extensions: { code: 'INVALID_INPUT' },
    });
  }

  // Validate description length
  if (!description || description.trim().length < 20) {
    throw new GraphQLError('Dispute description must be at least 20 characters', {
      extensions: { code: 'INVALID_INPUT' },
    });
  }

  // Evidence is files uploaded through Easykonnet, at most MAX_EVIDENCE of them
  checkEvidenceUrls(evidence, userId);
  if (evidence.length > MAX_EVIDENCE) {
    throw tooMuchEvidence();
  }

  // Get booking with relations
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: {
      user: true,
      provider: {
        include: { user: true },
      },
      service: true,
      dispute: true,
    },
  });

  const isUser = booking?.userId === userId;
  const isProvider = booking?.provider.userId === userId;

  // Only the booking's customer and provider, and admins, learn whether the
  // booking exists or already has a dispute
  if (!booking || (!isUser && !isProvider && !ADMIN_ROLES.includes(userRole))) {
    throw bookingNotFound();
  }

  // Admins settle disputes; they don't raise them
  if (!isUser && !isProvider) {
    throw new GraphQLError('You are not authorized to raise a dispute for this booking', {
      extensions: { code: 'FORBIDDEN' },
    });
  }

  // One dispute per booking; after a redo it can be reopened about the redone job
  const reopening =
    booking.dispute?.status === DisputeStatus.RESOLVED &&
    booking.dispute.resolution === DisputeResolution.REDO_SERVICE;

  if (booking.dispute && !reopening) {
    throw new GraphQLError('A dispute already exists for this booking', {
      extensions: { code: 'DISPUTE_EXISTS' },
    });
  }

  // Check booking status - disputes can only be raised for certain statuses
  const disputeableStatuses = [
    BookingStatus.ACCEPTED,
    BookingStatus.IN_PROGRESS,
    BookingStatus.COMPLETED,
  ];

  if (!(disputeableStatuses as string[]).includes(booking.status)) {
    throw new GraphQLError(
      `Cannot raise a dispute for a booking with status: ${booking.status}. Disputes can only be raised for accepted, in-progress, or completed bookings.`,
      { extensions: { code: 'INVALID_BOOKING_STATUS' } }
    );
  }

  // Money can only be disputed while it's still held
  if (booking.paymentReleasedAt) {
    throw new GraphQLError(
      'The payment for this booking has already been released to the provider. Please contact support for help.',
      { extensions: { code: 'DISPUTE_WINDOW_EXPIRED' } }
    );
  }

  // A completed job's payment is released RELEASE_DELAY_HOURS after the
  // customer confirms, or AUTO_RELEASE_DAYS after completion without a
  // confirmation. Once that time comes, the window has closed.
  if (booking.status === BookingStatus.COMPLETED) {
    const releaseDue =
      booking.paymentReleaseAt ??
      (booking.completedAt ? new Date(booking.completedAt.getTime() + AUTO_RELEASE_DAYS * DAY_MS) : null);

    if (releaseDue && releaseDue.getTime() <= Date.now()) {
      throw new GraphQLError(
        `Dispute window has expired. Disputes can be raised until the provider's payment is released: ${RELEASE_DELAY_HOURS} hours after the customer confirms delivery, or ${AUTO_RELEASE_DAYS} days after the job is completed if they don't.`,
        { extensions: { code: 'DISPUTE_WINDOW_EXPIRED' } }
      );
    }
  }

  // A reopened dispute keeps its earlier evidence, and the cap covers both
  const allEvidence = reopening && booking.dispute ? [...booking.dispute.evidence, ...evidence] : evidence;
  if (evidence.length > 0 && allEvidence.length > MAX_EVIDENCE) {
    throw tooMuchEvidence();
  }

  // Sanitize user inputs to prevent XSS
  const sanitizedReason = sanitizeBasic(reason.trim());
  const sanitizedDescription = validateText(
    sanitizeBasic(description.trim()),
    'Description',
    20,
    MAX_LENGTHS.DESCRIPTION
  );

  const dispute = await withTransaction(async (tx) => {
    // The booking must be unchanged since the checks above and not yet
    // released; the write also conflicts with a release running now
    const { count } = await tx.booking.updateMany({
      where: {
        id: bookingId,
        status: booking.status,
        OR: [{ paymentReleasedAt: null }, { paymentReleasedAt: { isSet: false } }],
      },
      data: { status: BookingStatus.DISPUTED },
    });

    if (count === 0) {
      throw new GraphQLError('This booking changed while the dispute was being raised. Please refresh and try again.', {
        extensions: { code: 'INVALID_BOOKING_STATUS' },
      });
    }

    const details = {
      raisedById: userId,
      raisedByRole: isUser ? UserRole.SERVICE_USER : UserRole.SERVICE_PROVIDER,
      reason: sanitizedReason,
      description: sanitizedDescription,
      status: DisputeStatus.OPEN,
      previousBookingStatus: booking.status,
    };

    if (reopening && booking.dispute) {
      // The earlier resolution stays in the audit log
      return tx.dispute.update({
        where: { id: booking.dispute.id },
        data: {
          ...details,
          evidence: allEvidence,
          reviewedById: null,
          reviewStartedAt: null,
          resolution: null,
          resolutionNotes: null,
          refundAmount: null,
          resolvedById: null,
          resolvedAt: null,
        },
        include: disputeInclude,
      });
    }

    return tx.dispute.create({
      data: { bookingId, ...details, evidence },
      include: disputeInclude,
    });
  });

  await Promise.all([
    notifyUser(
      isUser ? booking.provider.userId : booking.userId,
      NotificationType.DISPUTE_OPENED,
      'Dispute opened',
      `A dispute has been opened for the booking of ${booking.service.name}. Easykonnet will review it.`,
      dispute.id,
      { bookingId }
    ),
    alertAdmins({
      disputeId: dispute.id,
      bookingId,
      serviceName: booking.service.name,
      raisedByCustomer: isUser,
      reopened: reopening,
    }),
  ]);

  return formatDisputeResponse(dispute);
};

/**
 * Get dispute by ID
 */
export const getDisputeById = async (disputeId: string, userId?: string, isAdmin?: boolean) => {
  const dispute = await prisma.dispute.findUnique({
    where: { id: disputeId },
    include: disputeInclude,
  });

  if (!dispute) {
    throw new GraphQLError('Dispute not found', {
      extensions: { code: 'NOT_FOUND' },
    });
  }

  // If not admin, check authorization
  if (!isAdmin && userId) {
    const isUser = dispute.booking.userId === userId;
    const isProvider = dispute.booking.provider.userId === userId;

    // Same answer as a missing dispute, so outsiders can't tell one exists
    if (!isUser && !isProvider) {
      throw new GraphQLError('Dispute not found', {
        extensions: { code: 'NOT_FOUND' },
      });
    }
  }

  return formatDisputeResponse(dispute);
};

/**
 * Get the dispute for a booking, or null if it has none. Only the booking's
 * customer and provider, and admins, can ask.
 */
export const getBookingDispute = async (bookingId: string, userId?: string, isAdmin?: boolean) => {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: { userId: true, provider: { select: { userId: true } } },
  });

  const isParty = Boolean(userId) && (booking?.userId === userId || booking?.provider.userId === userId);

  if (!booking || (!isAdmin && !isParty)) {
    throw bookingNotFound();
  }

  const dispute = await prisma.dispute.findUnique({
    where: { bookingId },
    include: disputeInclude,
  });

  return dispute ? formatDisputeResponse(dispute) : null;
};

/**
 * The status and raisedByRole filters, as a query. GraphQL's enums have
 * already checked the values.
 */
const disputeFilterWhere = (filters: DisputeFilters): Prisma.DisputeWhereInput => ({
  ...(filters.status ? { status: filters.status as Prisma.DisputeWhereInput['status'] } : {}),
  ...(filters.raisedByRole ? { raisedByRole: filters.raisedByRole as Prisma.DisputeWhereInput['raisedByRole'] } : {}),
});

/**
 * Get user's disputes (as user or provider)
 */
export const getMyDisputes = async (
  userId: string,
  filters: DisputeFilters = {},
  pagination: PaginationInput = { page: 1, limit: 10 }
) => {
  const { page, limit } = pagination;
  const skip = (page - 1) * limit;

  // Get provider ID if user is a provider
  const provider = await prisma.serviceProvider.findUnique({
    where: { userId },
  });

  // Disputes on the user's bookings, as the customer or as the provider
  const where: Prisma.DisputeWhereInput = {
    OR: [
      { booking: { userId } },
      ...(provider ? [{ booking: { providerId: provider.id } }] : []),
    ],
    ...disputeFilterWhere(filters),
  };

  const [disputes, total] = await Promise.all([
    prisma.dispute.findMany({
      where,
      include: disputeInclude,
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
    }),
    prisma.dispute.count({ where }),
  ]);

  const totalPages = Math.ceil(total / limit);

  return {
    disputes: disputes.map(formatDisputeResponse),
    total,
    page,
    limit,
    totalPages,
    hasNextPage: page < totalPages,
    hasPreviousPage: page > 1,
  };
};

/**
 * Get all disputes (Admin only)
 */
export const getAllDisputes = async (
  filters: DisputeFilters = {},
  pagination: PaginationInput = { page: 1, limit: 10 }
) => {
  const { page, limit } = pagination;
  const skip = (page - 1) * limit;

  const where = disputeFilterWhere(filters);

  const [disputes, total] = await Promise.all([
    prisma.dispute.findMany({
      where,
      include: disputeInclude,
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
    }),
    prisma.dispute.count({ where }),
  ]);

  const totalPages = Math.ceil(total / limit);

  return {
    disputes: disputes.map(formatDisputeResponse),
    total,
    page,
    limit,
    totalPages,
    hasNextPage: page < totalPages,
    hasPreviousPage: page > 1,
  };
};

/**
 * Get open disputes count (Admin dashboard)
 */
export const getOpenDisputesCount = async () => {
  const count = await prisma.dispute.count({
    where: {
      status: {
        in: [DisputeStatus.OPEN, DisputeStatus.UNDER_REVIEW],
      },
    },
  });

  return { count };
};

/**
 * Admin takes dispute under review. Records who took it and when, and tells
 * both parties.
 */
export const takeDisputeUnderReview = async (disputeId: string, adminId: string) => {
  const dispute = await prisma.dispute.findUnique({
    where: { id: disputeId },
  });

  if (!dispute) {
    throw new GraphQLError('Dispute not found', {
      extensions: { code: 'NOT_FOUND' },
    });
  }

  // Conditional, so a dispute settled or taken meanwhile isn't changed
  const { count } = await prisma.dispute.updateMany({
    where: { id: disputeId, status: DisputeStatus.OPEN },
    data: { status: DisputeStatus.UNDER_REVIEW, reviewedById: adminId, reviewStartedAt: new Date() },
  });

  if (count === 0) {
    throw new GraphQLError(
      `Cannot take dispute under review. Current status: ${dispute.status}`,
      { extensions: { code: 'INVALID_STATUS' } }
    );
  }

  const updatedDispute = await prisma.dispute.findUniqueOrThrow({
    where: { id: disputeId },
    include: disputeInclude,
  });

  const { booking } = updatedDispute;
  const message = `Easykonnet is now reviewing the dispute for ${booking.service.name}. We'll let you know when it's settled.`;

  await Promise.all(
    [booking.userId, booking.provider.userId].map((recipientId) =>
      notifyUser(
        recipientId,
        NotificationType.DISPUTE_UPDATED,
        'Dispute under review',
        message,
        disputeId,
        { bookingId: booking.id }
      )
    )
  );

  return formatDisputeResponse(updatedDispute);
};

// ==================
// Resolution
// ==================

const RESOLUTION_OUTCOMES: Record<string, string> = {
  [DisputeResolution.REFUND_FULL]: 'a full refund',
  [DisputeResolution.REFUND_PARTIAL]: 'a partial refund',
  [DisputeResolution.NO_REFUND]: 'no refund',
  [DisputeResolution.REDO_SERVICE]: 'the service being redone',
  [DisputeResolution.MUTUAL_AGREEMENT]: 'a mutual agreement',
  [DisputeResolution.DISMISSED]: 'the dispute being dismissed',
};

/**
 * How much a resolution refunds, in kobo. `paidKobo` is the booking's
 * completed payment (0 if it wasn't paid), `refundedKobo` the part of it an
 * earlier refund already returned, and `requestedKobo` the amount the admin
 * entered, if any. Refunds are measured against what hasn't been refunded yet.
 */
export const refundForResolution = (
  resolution: string,
  requestedKobo: number | null,
  paidKobo: number,
  refundedKobo = 0
): number => {
  const naira = (kobo: number) => `₦${koboToNaira(kobo).toLocaleString()}`;
  const refundableKobo = Math.max(paidKobo - refundedKobo, 0);

  // What the amount is measured against, as the error messages say it
  const limit = refundedKobo > 0
    ? `${naira(refundableKobo)} not yet refunded (${naira(refundedKobo)} of the ${naira(paidKobo)} paid was refunded earlier)`
    : `${naira(paidKobo)} paid`;

  const invalidAmount = (message: string) =>
    new GraphQLError(message, { extensions: { code: 'INVALID_REFUND_AMOUNT' } });

  const requirePayment = () => {
    if (paidKobo <= 0) {
      throw new GraphQLError('This booking has no completed payment to refund', {
        extensions: { code: 'NO_PAYMENT_TO_REFUND' },
      });
    }
    if (refundableKobo <= 0) {
      throw new GraphQLError('This payment has already been refunded', {
        extensions: { code: 'ALREADY_REFUNDED' },
      });
    }
  };

  switch (resolution) {
    case DisputeResolution.REFUND_FULL:
      requirePayment();
      if (requestedKobo !== null && requestedKobo !== refundableKobo) {
        throw invalidAmount(
          refundedKobo > 0
            ? `A full refund is the ${limit}. Leave the amount empty, or choose a partial refund.`
            : `A full refund is the whole ${limit}. Leave the amount empty, or choose a partial refund.`
        );
      }
      return refundableKobo;

    case DisputeResolution.REFUND_PARTIAL:
      if (requestedKobo === null) {
        throw new GraphQLError('Refund amount is required for a partial refund', {
          extensions: { code: 'REFUND_AMOUNT_REQUIRED' },
        });
      }
      requirePayment();
      if (requestedKobo <= 0 || requestedKobo >= refundableKobo) {
        throw invalidAmount(`A partial refund must be more than ₦0 and less than the ${limit}`);
      }
      return requestedKobo;

    case DisputeResolution.MUTUAL_AGREEMENT:
      if (!requestedKobo) return 0;
      requirePayment();
      if (requestedKobo < 0 || requestedKobo > refundableKobo) {
        throw invalidAmount(`The agreed refund must be between ₦0 and the ${limit}`);
      }
      return requestedKobo;

    default:
      if (requestedKobo) {
        throw invalidAmount('This resolution doesn’t include a refund. Remove the refund amount, or choose a refund resolution.');
      }
      return 0;
  }
};

/**
 * Where the booking goes when its dispute is settled. `paidKobo` is what's
 * still held for the booking: the payment less any earlier refund.
 */
export const bookingAfterResolution = (params: {
  resolution: string;
  refundKobo: number;
  paidKobo: number;
  previousStatus: BookingStatusValue;
  completedAt: Date | null;
  now: Date;
}): Prisma.BookingUpdateInput => {
  const { resolution, refundKobo, paidKobo, previousStatus, completedAt, now } = params;

  if (refundKobo > 0 && refundKobo === paidKobo) {
    return {
      status: BookingStatus.CANCELLED,
      cancelledAt: now,
      cancellationReason: 'Dispute resolved with a full refund',
    };
  }

  if (resolution === DisputeResolution.REDO_SERVICE) {
    // Held until the redone job is completed and confirmed
    return {
      status: BookingStatus.ACCEPTED,
      completedAt: null,
      customerConfirmedAt: null,
      paymentReleaseAt: null,
    };
  }

  if (refundKobo > 0) {
    // Settled: the rest goes to the provider now
    return {
      status: BookingStatus.COMPLETED,
      completedAt: completedAt ?? now,
      paymentReleaseAt: now,
    };
  }

  // Nothing refunded: back to where it was, and a finished, paid job is released
  if (previousStatus === BookingStatus.COMPLETED) {
    return {
      status: BookingStatus.COMPLETED,
      ...(paidKobo > 0 ? { paymentReleaseAt: now } : {}),
    };
  }

  return { status: previousStatus };
};

/**
 * Settle a dispute: record the resolution, refund to the customer's wallet if
 * the resolution includes one, and move the booking on, all together
 */
const settleDispute = async (
  disputeId: string,
  admin: { id: string; role: string },
  input: { resolution: string; notes: string; refundAmount?: number | null; close: boolean }
) => {
  const dispute = await prisma.dispute.findUnique({
    where: { id: disputeId },
    include: {
      booking: {
        include: {
          payment: true,
          service: true,
          provider: { select: { userId: true } },
        },
      },
    },
  });

  if (!dispute) {
    throw new GraphQLError('Dispute not found', {
      extensions: { code: 'NOT_FOUND' },
    });
  }

  if (dispute.status === DisputeStatus.RESOLVED || dispute.status === DisputeStatus.CLOSED) {
    throw new GraphQLError('This dispute has already been resolved or closed', {
      extensions: { code: 'ALREADY_RESOLVED' },
    });
  }

  const { booking } = dispute;
  const payment = booking.payment?.status === PaymentStatus.COMPLETED ? booking.payment : null;
  const paidKobo = payment ? nairaToKobo(payment.amount) : 0;
  // An earlier partial refund leaves less to refund; escrow works it out the same way
  const refundedKobo = payment ? paidKobo - refundableKobo(payment) : 0;
  const requestedKobo = input.refundAmount == null ? null : nairaToKobo(input.refundAmount);
  const refundKobo = refundForResolution(input.resolution, requestedKobo, paidKobo, refundedKobo);

  const now = new Date();
  const bookingUpdate = bookingAfterResolution({
    resolution: input.resolution,
    refundKobo,
    paidKobo: paidKobo - refundedKobo,
    // Disputes opened before this was recorded: infer it
    previousStatus:
      dispute.previousBookingStatus ??
      (booking.completedAt ? BookingStatus.COMPLETED : BookingStatus.ACCEPTED),
    completedAt: booking.completedAt,
    now,
  });

  // Created before the transaction: a failed create would abort it
  const wallet = refundKobo > 0 ? await ensureWallet(booking.userId) : null;

  const refund = await withTransaction(async (tx) => {
    // Claim the dispute, so two admins can't settle it at once
    const { count } = await tx.dispute.updateMany({
      where: {
        id: disputeId,
        status: { in: [DisputeStatus.OPEN, DisputeStatus.UNDER_REVIEW] },
      },
      data: {
        status: input.close ? DisputeStatus.CLOSED : DisputeStatus.RESOLVED,
        resolution: input.resolution as DisputeResolutionValue,
        resolutionNotes: input.notes,
        refundAmount: refundKobo > 0 ? koboToNaira(refundKobo) : null,
        resolvedById: admin.id,
        resolvedAt: now,
      },
    });

    if (count === 0) {
      throw new GraphQLError('This dispute has already been resolved or closed', {
        extensions: { code: 'ALREADY_RESOLVED' },
      });
    }

    const result = payment && wallet && refundKobo > 0
      ? await refundPaymentToWallet(tx, wallet.id, {
          paymentId: payment.id,
          amountKobo: refundKobo,
          reason: `Dispute resolution: ${input.notes}`,
          via: 'DISPUTE',
          refundedBy: admin.id,
        })
      : null;

    await tx.booking.update({
      where: { id: booking.id },
      data: bookingUpdate,
    });

    return result;
  });

  try {
    await createAuditLog({
      action: AdminAction.RESOLVE_DISPUTE,
      targetType: 'Dispute',
      targetId: disputeId,
      performedBy: admin.id,
      performedByRole: admin.role,
      previousValue: { status: dispute.status, bookingStatus: booking.status },
      newValue: {
        status: input.close ? DisputeStatus.CLOSED : DisputeStatus.RESOLVED,
        resolution: input.resolution,
        refundAmount: koboToNaira(refundKobo),
        bookingStatus: bookingUpdate.status,
      },
      reason: input.notes,
    });
  } catch (error) {
    console.error('Failed to write dispute audit log:', error);
  }

  const serviceName = booking.service.name;
  const outcome = RESOLUTION_OUTCOMES[input.resolution] ?? input.resolution;
  const metadata = { bookingId: booking.id };
  const releasedNow = bookingUpdate.paymentReleaseAt instanceof Date;
  const providerShareKobo = refund ? refund.providerPayoutKobo : nairaToKobo(payment?.providerPayout ?? 0);

  const customerNote = refund
    ? ` ₦${koboToNaira(refund.refundKobo).toLocaleString()} has been added to your Easykonnet wallet.`
    : '';

  const providerNote = refund?.isFullRefund
    ? ' The booking was cancelled.'
    : input.resolution === DisputeResolution.REDO_SERVICE
      ? ' Please arrange with the customer to redo the service.'
      : releasedNow
        ? ` ₦${koboToNaira(providerShareKobo).toLocaleString()} will be released to your wallet shortly.`
        : '';

  await Promise.all([
    notifyUser(
      booking.userId,
      NotificationType.DISPUTE_RESOLVED,
      'Dispute resolved',
      `The dispute for ${serviceName} was settled with ${outcome}.${customerNote}`,
      disputeId,
      metadata
    ),
    notifyUser(
      booking.provider.userId,
      NotificationType.DISPUTE_RESOLVED,
      'Dispute resolved',
      `The dispute for ${serviceName} was settled with ${outcome}.${providerNote}`,
      disputeId,
      metadata
    ),
  ]);

  const settled = await prisma.dispute.findUniqueOrThrow({
    where: { id: disputeId },
    include: disputeInclude,
  });

  return formatDisputeResponse(settled);
};

/**
 * Admin resolves a dispute
 */
export const resolveDispute = async (
  disputeId: string,
  adminId: string,
  input: ResolveDisputeInput,
  adminRole: string = UserRole.ADMIN
) => {
  const { resolution, resolutionNotes, refundAmount } = input;

  // Validate resolution type. GraphQL's DisputeResolution enum rejects a bad
  // value first, so this only guards direct callers.
  const validResolutions: string[] = Object.values(DisputeResolution);
  if (!validResolutions.includes(resolution)) {
    throw new GraphQLError(
      `Invalid resolution type. Must be one of: ${validResolutions.join(', ')}`,
      { extensions: { code: 'INVALID_RESOLUTION' } }
    );
  }

  // Validate resolution notes
  if (!resolutionNotes || resolutionNotes.trim().length < 10) {
    throw new GraphQLError('Resolution notes must be at least 10 characters', {
      extensions: { code: 'INVALID_INPUT' },
    });
  }

  return settleDispute(disputeId, { id: adminId, role: adminRole }, {
    resolution,
    notes: sanitizeBasic(resolutionNotes.trim()),
    refundAmount,
    close: false,
  });
};

/**
 * Add evidence to a dispute (User or Provider who raised it)
 */
export const addDisputeEvidence = async (
  disputeId: string,
  userId: string,
  evidenceUrls: string[]
) => {
  checkEvidenceUrls(evidenceUrls, userId);

  const dispute = await prisma.dispute.findUnique({
    where: { id: disputeId },
    include: {
      booking: {
        include: {
          provider: true,
        },
      },
    },
  });

  if (!dispute) {
    throw new GraphQLError('Dispute not found', {
      extensions: { code: 'NOT_FOUND' },
    });
  }

  // Check if user is authorized (must be the one who raised the dispute)
  const isUser = dispute.booking.userId === userId;
  const isProvider = dispute.booking.provider.userId === userId;

  // Same answer as a missing dispute, so outsiders can't tell one exists
  if (!isUser && !isProvider) {
    throw new GraphQLError('Dispute not found', {
      extensions: { code: 'NOT_FOUND' },
    });
  }

  const isRaiser =
    (isUser && dispute.raisedByRole === UserRole.SERVICE_USER) ||
    (isProvider && dispute.raisedByRole === UserRole.SERVICE_PROVIDER);

  if (!isRaiser) {
    throw new GraphQLError('Only the dispute raiser can add evidence', {
      extensions: { code: 'FORBIDDEN' },
    });
  }

  // Check dispute status
  if (dispute.status !== DisputeStatus.OPEN && dispute.status !== DisputeStatus.UNDER_REVIEW) {
    throw new GraphQLError('Cannot add evidence to a resolved or closed dispute', {
      extensions: { code: 'INVALID_STATUS' },
    });
  }

  // Limit evidence count
  if (dispute.evidence.length + evidenceUrls.length > MAX_EVIDENCE) {
    throw tooMuchEvidence();
  }

  const updatedDispute = await prisma.dispute.update({
    where: { id: disputeId },
    data: {
      evidence: {
        push: evidenceUrls,
      },
    },
    include: disputeInclude,
  });

  return formatDisputeResponse(updatedDispute);
};

/**
 * Close a dispute without resolution (Admin only - for invalid disputes).
 * The booking returns to the status it had, and a finished, paid job is
 * released to the provider.
 */
export const closeDispute = async (
  disputeId: string,
  adminId: string,
  reason: string,
  adminRole: string = UserRole.ADMIN
) => {
  if (!reason || reason.trim().length < 10) {
    throw new GraphQLError('Closure reason must be at least 10 characters', {
      extensions: { code: 'INVALID_INPUT' },
    });
  }

  return settleDispute(disputeId, { id: adminId, role: adminRole }, {
    resolution: DisputeResolution.DISMISSED,
    notes: sanitizeBasic(reason.trim()),
    close: true,
  });
};

/**
 * Get dispute statistics (Admin dashboard)
 */
export const getDisputeStats = async () => {
  const [total, open, underReview, resolved, closed] = await Promise.all([
    prisma.dispute.count(),
    prisma.dispute.count({ where: { status: DisputeStatus.OPEN } }),
    prisma.dispute.count({ where: { status: DisputeStatus.UNDER_REVIEW } }),
    prisma.dispute.count({ where: { status: DisputeStatus.RESOLVED } }),
    prisma.dispute.count({ where: { status: DisputeStatus.CLOSED } }),
  ]);

  // Get resolution breakdown
  const resolutionBreakdown = await prisma.dispute.groupBy({
    by: ['resolution'],
    where: {
      status: {
        in: [DisputeStatus.RESOLVED, DisputeStatus.CLOSED],
      },
    },
    _count: { id: true },
  });

  const resolutions: Record<string, number> = {};
  resolutionBreakdown.forEach((item) => {
    if (item.resolution) {
      resolutions[item.resolution] = item._count.id;
    }
  });

  return {
    total,
    open,
    underReview,
    resolved,
    closed,
    pending: open + underReview,
    resolutions,
  };
};
