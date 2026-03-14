/**
 * Dispute Service
 * Handles booking dispute operations
 * 
 * Features:
 * - Users or providers can raise disputes on bookings
 * - Admin reviews and resolves disputes
 * - Track dispute status and resolution
 * - Support for evidence uploads
 */

import { GraphQLError } from 'graphql';
import prisma from '@/lib/prisma';
import { BookingStatus, DisputeStatus, DisputeResolution, UserRole } from '@/constants';

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
  refundAmount?: number;
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
// Helper Functions
// ==================

/**
 * Format dispute response for GraphQL
 */
const formatDisputeResponse = (dispute: any) => ({
  id: dispute.id,
  reason: dispute.reason,
  description: dispute.description,
  evidence: dispute.evidence,
  status: dispute.status,
  raisedByRole: dispute.raisedByRole,
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

  if (!booking) {
    throw new GraphQLError('Booking not found', {
      extensions: { code: 'NOT_FOUND' },
    });
  }

  // Check if dispute already exists
  if (booking.dispute) {
    throw new GraphQLError('A dispute already exists for this booking', {
      extensions: { code: 'DISPUTE_EXISTS' },
    });
  }

  // Determine if user is authorized to raise dispute
  const isUser = booking.userId === userId;
  const isProvider = booking.provider.userId === userId;

  if (!isUser && !isProvider) {
    throw new GraphQLError('You are not authorized to raise a dispute for this booking', {
      extensions: { code: 'FORBIDDEN' },
    });
  }

  // Check booking status - disputes can only be raised for certain statuses
  const disputeableStatuses = [
    BookingStatus.ACCEPTED,
    BookingStatus.IN_PROGRESS,
    BookingStatus.COMPLETED,
  ];

  if (!disputeableStatuses.includes(booking.status as any)) {
    throw new GraphQLError(
      `Cannot raise a dispute for a booking with status: ${booking.status}. Disputes can only be raised for accepted, in-progress, or completed bookings.`,
      { extensions: { code: 'INVALID_BOOKING_STATUS' } }
    );
  }

  // For completed bookings, check if within dispute window (e.g., 7 days)
  if (booking.status === BookingStatus.COMPLETED && booking.completedAt) {
    const disputeWindowDays = 7;
    const disputeDeadline = new Date(booking.completedAt);
    disputeDeadline.setDate(disputeDeadline.getDate() + disputeWindowDays);
    
    if (new Date() > disputeDeadline) {
      throw new GraphQLError(
        `Dispute window has expired. Disputes must be raised within ${disputeWindowDays} days of service completion.`,
        { extensions: { code: 'DISPUTE_WINDOW_EXPIRED' } }
      );
    }
  }

  // Create dispute and update booking status
  const [dispute] = await prisma.$transaction([
    prisma.dispute.create({
      data: {
        bookingId,
        raisedById: userId,
        raisedByRole: isUser ? UserRole.SERVICE_USER : UserRole.SERVICE_PROVIDER,
        reason: reason.trim(),
        description: description.trim(),
        evidence,
        status: DisputeStatus.OPEN,
      },
      include: {
        booking: {
          include: {
            user: true,
            provider: {
              include: { user: true },
            },
            service: true,
          },
        },
      },
    }),
    prisma.booking.update({
      where: { id: bookingId },
      data: { status: BookingStatus.DISPUTED },
    }),
  ]);

  // TODO: Send notification to the other party and admin
  // TODO: Send email notification

  return formatDisputeResponse(dispute);
};

/**
 * Get dispute by ID
 */
export const getDisputeById = async (disputeId: string, userId?: string, isAdmin?: boolean) => {
  const dispute = await prisma.dispute.findUnique({
    where: { id: disputeId },
    include: {
      booking: {
        include: {
          user: true,
          provider: {
            include: { user: true },
          },
          service: true,
        },
      },
    },
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
    
    if (!isUser && !isProvider) {
      throw new GraphQLError('You are not authorized to view this dispute', {
        extensions: { code: 'FORBIDDEN' },
      });
    }
  }

  return formatDisputeResponse(dispute);
};

/**
 * Get dispute for a booking
 */
export const getBookingDispute = async (bookingId: string, userId?: string, isAdmin?: boolean) => {
  const dispute = await prisma.dispute.findUnique({
    where: { bookingId },
    include: {
      booking: {
        include: {
          user: true,
          provider: {
            include: { user: true },
          },
          service: true,
        },
      },
    },
  });

  if (!dispute) {
    return null;
  }

  // If not admin, check authorization
  if (!isAdmin && userId) {
    const isUser = dispute.booking.userId === userId;
    const isProvider = dispute.booking.provider.userId === userId;
    
    if (!isUser && !isProvider) {
      throw new GraphQLError('You are not authorized to view this dispute', {
        extensions: { code: 'FORBIDDEN' },
      });
    }
  }

  return formatDisputeResponse(dispute);
};

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

  // Build where clause - disputes for user's bookings or provider's bookings
  const where: any = {
    OR: [
      { booking: { userId } },
      ...(provider ? [{ booking: { providerId: provider.id } }] : []),
    ],
  };

  if (filters.status) {
    where.status = filters.status;
  }

  const [disputes, total] = await Promise.all([
    prisma.dispute.findMany({
      where,
      include: {
        booking: {
          include: {
            user: true,
            provider: {
              include: { user: true },
            },
            service: true,
          },
        },
      },
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

  // Build where clause
  const where: any = {};

  if (filters.status) {
    where.status = filters.status;
  }

  if (filters.raisedByRole) {
    where.raisedByRole = filters.raisedByRole;
  }

  const [disputes, total] = await Promise.all([
    prisma.dispute.findMany({
      where,
      include: {
        booking: {
          include: {
            user: true,
            provider: {
              include: { user: true },
            },
            service: true,
          },
        },
      },
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
 * Admin takes dispute under review
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

  if (dispute.status !== DisputeStatus.OPEN) {
    throw new GraphQLError(
      `Cannot take dispute under review. Current status: ${dispute.status}`,
      { extensions: { code: 'INVALID_STATUS' } }
    );
  }

  const updatedDispute = await prisma.dispute.update({
    where: { id: disputeId },
    data: {
      status: DisputeStatus.UNDER_REVIEW,
    },
    include: {
      booking: {
        include: {
          user: true,
          provider: {
            include: { user: true },
          },
          service: true,
        },
      },
    },
  });

  // TODO: Send notification to both parties that dispute is under review

  return formatDisputeResponse(updatedDispute);
};

/**
 * Admin resolves a dispute
 */
export const resolveDispute = async (
  disputeId: string,
  adminId: string,
  input: ResolveDisputeInput
) => {
  const { resolution, resolutionNotes, refundAmount } = input;

  // Validate resolution type
  const validResolutions = Object.values(DisputeResolution);
  if (!validResolutions.includes(resolution as any)) {
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

  const dispute = await prisma.dispute.findUnique({
    where: { id: disputeId },
    include: {
      booking: true,
    },
  });

  if (!dispute) {
    throw new GraphQLError('Dispute not found', {
      extensions: { code: 'NOT_FOUND' },
    });
  }

  if (dispute.status === DisputeStatus.RESOLVED || dispute.status === DisputeStatus.CLOSED) {
    throw new GraphQLError('This dispute has already been resolved', {
      extensions: { code: 'ALREADY_RESOLVED' },
    });
  }

  // Validate refund amount if applicable
  if (
    (resolution === DisputeResolution.REFUND_FULL || 
     resolution === DisputeResolution.REFUND_PARTIAL) &&
    refundAmount === undefined
  ) {
    throw new GraphQLError('Refund amount is required for refund resolutions', {
      extensions: { code: 'REFUND_AMOUNT_REQUIRED' },
    });
  }

  if (refundAmount !== undefined) {
    if (refundAmount < 0) {
      throw new GraphQLError('Refund amount cannot be negative', {
        extensions: { code: 'INVALID_REFUND_AMOUNT' },
      });
    }
    if (refundAmount > dispute.booking.totalAmount) {
      throw new GraphQLError('Refund amount cannot exceed the booking total', {
        extensions: { code: 'INVALID_REFUND_AMOUNT' },
      });
    }
  }

  // Determine new booking status based on resolution
  let newBookingStatus: string = BookingStatus.COMPLETED;
  if (resolution === DisputeResolution.REDO_SERVICE) {
    newBookingStatus = BookingStatus.PENDING;
  }

  // Update dispute and booking
  const [updatedDispute] = await prisma.$transaction([
    prisma.dispute.update({
      where: { id: disputeId },
      data: {
        status: DisputeStatus.RESOLVED,
        resolution: resolution as any,
        resolutionNotes: resolutionNotes.trim(),
        refundAmount,
        resolvedById: adminId,
        resolvedAt: new Date(),
      },
      include: {
        booking: {
          include: {
            user: true,
            provider: {
              include: { user: true },
            },
            service: true,
          },
        },
      },
    }),
    prisma.booking.update({
      where: { id: dispute.bookingId },
      data: { status: newBookingStatus as any },
    }),
  ]);

  // TODO: Send notifications to both parties about resolution
  // TODO: Process refund if applicable (integrate with payment service)

  return formatDisputeResponse(updatedDispute);
};

/**
 * Add evidence to a dispute (User or Provider who raised it)
 */
export const addDisputeEvidence = async (
  disputeId: string,
  userId: string,
  evidenceUrls: string[]
) => {
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
  const maxEvidence = 10;
  if (dispute.evidence.length + evidenceUrls.length > maxEvidence) {
    throw new GraphQLError(`Maximum ${maxEvidence} evidence files allowed`, {
      extensions: { code: 'MAX_EVIDENCE_EXCEEDED' },
    });
  }

  const updatedDispute = await prisma.dispute.update({
    where: { id: disputeId },
    data: {
      evidence: {
        push: evidenceUrls,
      },
    },
    include: {
      booking: {
        include: {
          user: true,
          provider: {
            include: { user: true },
          },
          service: true,
        },
      },
    },
  });

  return formatDisputeResponse(updatedDispute);
};

/**
 * Close a dispute without resolution (Admin only - for invalid disputes)
 */
export const closeDispute = async (disputeId: string, adminId: string, reason: string) => {
  if (!reason || reason.trim().length < 10) {
    throw new GraphQLError('Closure reason must be at least 10 characters', {
      extensions: { code: 'INVALID_INPUT' },
    });
  }

  const dispute = await prisma.dispute.findUnique({
    where: { id: disputeId },
    include: {
      booking: true,
    },
  });

  if (!dispute) {
    throw new GraphQLError('Dispute not found', {
      extensions: { code: 'NOT_FOUND' },
    });
  }

  if (dispute.status === DisputeStatus.RESOLVED || dispute.status === DisputeStatus.CLOSED) {
    throw new GraphQLError('This dispute has already been resolved or closed', {
      extensions: { code: 'ALREADY_CLOSED' },
    });
  }

  // Restore booking to previous status (usually COMPLETED)
  const [updatedDispute] = await prisma.$transaction([
    prisma.dispute.update({
      where: { id: disputeId },
      data: {
        status: DisputeStatus.CLOSED,
        resolution: DisputeResolution.DISMISSED,
        resolutionNotes: reason.trim(),
        resolvedById: adminId,
        resolvedAt: new Date(),
      },
      include: {
        booking: {
          include: {
            user: true,
            provider: {
              include: { user: true },
            },
            service: true,
          },
        },
      },
    }),
    prisma.booking.update({
      where: { id: dispute.bookingId },
      data: { status: BookingStatus.COMPLETED },
    }),
  ]);

  return formatDisputeResponse(updatedDispute);
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
