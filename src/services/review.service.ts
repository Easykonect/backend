/**
 * Review Service
 * Handles review and rating operations
 *
 * Features:
 * - Create review after completed booking
 * - Provider response to reviews
 * - Get provider reviews with average rating
 * - User's reviews
 *
 * Reviews and responses are screened for blocked language and contact
 * details. A review hidden by moderation keeps its rating, so reporting a
 * review can't change a provider's score, but its text is not shown.
 *
 * An admin can remove a review (deleteReview). It stays stored with who
 * removed it and why, but is left out of every list, count and rating, and
 * its booking can't be reviewed again.
 */

import { AdminAction, type Prisma } from '@prisma/client';
import { GraphQLError } from 'graphql';
import prisma from '@/lib/prisma';
import { BookingStatus } from '@/constants';
import { assertAcceptableText } from '@/lib/content-filter';
import { logger } from '@/lib/logger';
import { sanitizeBasic, validateRating } from '@/utils/security';
import { createAuditLog } from '@/services/audit.service';
import { notifyReviewReceived, notifyReviewResponse } from '@/services/notification.service';
import { sendPushToUser, sendReviewPush } from '@/services/push.service';
import { assertTermsAccepted } from './terms.service';

// ==================
// Types
// ==================

interface CreateReviewInput {
  bookingId: string;
  rating: number;
  comment?: string | null;
}

interface ReviewFiltersInput {
  providerId?: string;
  rating?: number | null;
  hasResponse?: boolean | null;
}

// ==================
// Constants
// ==================

// Lengths are counted after the text is cleaned
const MAX_COMMENT_LENGTH = 1000;
const MIN_RESPONSE_LENGTH = 10;
const MAX_RESPONSE_LENGTH = 1000;
const MAX_DELETION_REASON_LENGTH = 500;

// Reviews an admin hasn't removed. Reviews saved before removal existed have no
// deletedAt at all, which matching null alone would miss.
const NOT_DELETED: Prisma.ReviewWhereInput = {
  OR: [{ deletedAt: null }, { deletedAt: { isSet: false } }],
};

// ==================
// Helper Functions
// ==================

/**
 * Format review response
 */
const formatReviewResponse = (review: any) => ({
  id: review.id,
  rating: review.rating,
  comment: review.isHidden ? null : review.comment,
  response: review.isHidden ? null : review.response,
  isHidden: Boolean(review.isHidden),
  respondedAt: review.respondedAt?.toISOString() || null,
  createdAt: review.createdAt.toISOString(),
  updatedAt: review.updatedAt.toISOString(),
  user: review.user ? {
    id: review.user.id,
    firstName: review.user.firstName,
    lastName: review.user.lastName,
    email: review.user.email,
  } : null,
  provider: review.provider ? {
    id: review.provider.id,
    businessName: review.provider.businessName,
    user: review.provider.user ? {
      id: review.provider.user.id,
      firstName: review.provider.user.firstName,
      lastName: review.provider.user.lastName,
    } : null,
  } : null,
  booking: review.booking ? {
    id: review.booking.id,
    scheduledDate: review.booking.scheduledDate.toISOString().split('T')[0],
    service: review.booking.service ? {
      id: review.booking.service.id,
      // Services are named; ReviewService calls it title
      title: review.booking.service.name,
    } : null,
  } : null,
});

const reviewNotFound = () =>
  new GraphQLError('Review not found', {
    extensions: { code: 'NOT_FOUND' },
  });

const assertCommentLength = (comment: string | undefined) => {
  if (comment && comment.length > MAX_COMMENT_LENGTH) {
    throw new GraphQLError(`Your review must be at most ${MAX_COMMENT_LENGTH} characters`, {
      extensions: { code: 'INVALID_INPUT' },
    });
  }
};

/**
 * Tell the provider about a new review. The review is already saved, so
 * failures are logged rather than returned.
 */
const announceNewReview = async (
  providerUserId: string,
  reviewId: string,
  rating: number,
  reviewerName: string,
  serviceName: string
) => {
  try {
    await notifyReviewReceived(providerUserId, reviewId, rating, reviewerName);
  } catch (err) {
    logger.error('Failed to write review notification', { reviewId, err });
  }

  try {
    await sendReviewPush(providerUserId, reviewerName, rating, serviceName, { reviewId });
  } catch (err) {
    logger.error('Failed to send review push', { reviewId, err });
  }
};

/**
 * Tell the reviewer the provider replied. Failures are logged: the reply is
 * already saved.
 */
const announceResponse = async (reviewerUserId: string, reviewId: string, providerName: string) => {
  try {
    await notifyReviewResponse(reviewerUserId, reviewId, providerName);
  } catch (err) {
    logger.error('Failed to write review response notification', { reviewId, err });
  }

  try {
    await sendPushToUser(reviewerUserId, {
      title: 'Provider Responded to Your Review',
      message: `${providerName} has responded to your review`,
      data: { type: 'REVIEW', reviewId },
    });
  } catch (err) {
    logger.error('Failed to send review response push', { reviewId, err });
  }
};

// ==================
// Review Functions
// ==================

/**
 * Create a review for a completed booking
 */
export const createReview = async (userId: string, input: CreateReviewInput) => {
  const { bookingId, rating, comment } = input;

  // Validate and sanitize rating
  const validatedRating = validateRating(rating);

  const sanitizedComment = comment ? sanitizeBasic(comment) : undefined;
  assertCommentLength(sanitizedComment);
  assertAcceptableText(sanitizedComment, 'Your review');

  // Get booking
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: {
      user: true,
      provider: true,
      service: true,
      review: true,
    },
  });

  if (!booking) {
    throw new GraphQLError('Booking not found', {
      extensions: { code: 'NOT_FOUND' },
    });
  }

  // Check if user owns the booking
  if (booking.userId !== userId) {
    throw new GraphQLError('You can only review your own bookings', {
      extensions: { code: 'FORBIDDEN' },
    });
  }

  // Check if booking is completed
  if (booking.status !== BookingStatus.COMPLETED) {
    throw new GraphQLError('You can only review completed bookings', {
      extensions: { code: 'BOOKING_NOT_COMPLETED' },
    });
  }

  // Check if already reviewed. A review an admin removed still counts.
  if (booking.review) {
    throw new GraphQLError(
      booking.review.deletedAt
        ? "This booking's review was removed by Easykonnet, so it can't be reviewed again"
        : 'You have already reviewed this booking',
      { extensions: { code: 'ALREADY_REVIEWED' } }
    );
  }

  await assertTermsAccepted(userId);

  // Create review
  const review = await prisma.review.create({
    data: {
      bookingId,
      userId,
      providerId: booking.providerId,
      rating: validatedRating,
      comment: sanitizedComment,
    },
    include: {
      user: true,
      provider: {
        include: { user: true },
      },
      booking: {
        include: { service: true },
      },
    },
  });

  await announceNewReview(
    booking.provider.userId,
    review.id,
    validatedRating,
    `${booking.user.firstName} ${booking.user.lastName}`.trim() || 'A customer',
    booking.service.name
  );

  return formatReviewResponse(review);
};

/**
 * Provider responds to a review
 */
export const respondToReview = async (providerId: string, reviewId: string, response: string) => {
  // Get review
  const review = await prisma.review.findUnique({
    where: { id: reviewId },
    include: {
      provider: true,
    },
  });

  if (!review || review.deletedAt) {
    throw reviewNotFound();
  }

  // Check if provider owns the review
  if (review.providerId !== providerId) {
    throw new GraphQLError('You can only respond to reviews for your services', {
      extensions: { code: 'FORBIDDEN' },
    });
  }

  // Check if already responded
  if (review.response) {
    throw new GraphQLError('You have already responded to this review', {
      extensions: { code: 'ALREADY_RESPONDED' },
    });
  }

  // Cleaned first, so markup and spaces don't count towards the length
  const sanitizedResponse = sanitizeBasic(response ?? '');

  if (sanitizedResponse.length < MIN_RESPONSE_LENGTH) {
    throw new GraphQLError(`Response must be at least ${MIN_RESPONSE_LENGTH} characters`, {
      extensions: { code: 'INVALID_RESPONSE' },
    });
  }

  if (sanitizedResponse.length > MAX_RESPONSE_LENGTH) {
    throw new GraphQLError(`Response must be at most ${MAX_RESPONSE_LENGTH} characters`, {
      extensions: { code: 'INVALID_RESPONSE' },
    });
  }

  assertAcceptableText(sanitizedResponse, 'Your response');

  await assertTermsAccepted(review.provider.userId);

  // Update review with response
  const updatedReview = await prisma.review.update({
    where: { id: reviewId },
    data: {
      response: sanitizedResponse,
      respondedAt: new Date(),
    },
    include: {
      user: true,
      provider: {
        include: { user: true },
      },
      booking: {
        include: { service: true },
      },
    },
  });

  // A hidden review's reply isn't shown, so there's nothing to tell the reviewer
  if (!updatedReview.isHidden) {
    await announceResponse(review.userId, reviewId, review.provider.businessName);
  }

  return formatReviewResponse(updatedReview);
};

/**
 * Get review by ID
 */
export const getReviewById = async (reviewId: string) => {
  const review = await prisma.review.findUnique({
    where: { id: reviewId },
    include: {
      user: true,
      provider: {
        include: { user: true },
      },
      booking: {
        include: { service: true },
      },
    },
  });

  if (!review || review.deletedAt) {
    throw reviewNotFound();
  }

  return formatReviewResponse(review);
};

/**
 * Get reviews for a provider
 */
export const getProviderReviews = async (
  providerId: string,
  filters: ReviewFiltersInput = {},
  pagination: { page: number; limit: number } = { page: 1, limit: 10 }
) => {
  const { page, limit } = pagination;
  const skip = (page - 1) * limit;

  const conditions: Prisma.ReviewWhereInput[] = [NOT_DELETED];

  if (filters.hasResponse === true) {
    conditions.push({ response: { isSet: true, not: null } });
  } else if (filters.hasResponse === false) {
    // No reply: a null reply, or no reply field saved at all
    conditions.push({ OR: [{ response: null }, { response: { isSet: false } }] });
  }

  const where: Prisma.ReviewWhereInput = {
    providerId,
    ...(filters.rating ? { rating: filters.rating } : {}),
    AND: conditions,
  };

  const [reviews, total] = await Promise.all([
    prisma.review.findMany({
      where,
      include: {
        user: true,
        provider: {
          include: { user: true },
        },
        booking: {
          include: { service: true },
        },
      },
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
    }),
    prisma.review.count({ where }),
  ]);

  const totalPages = Math.ceil(total / limit);

  return {
    reviews: reviews.map(formatReviewResponse),
    total,
    page,
    limit,
    totalPages,
    hasNextPage: page < totalPages,
    hasPreviousPage: page > 1,
  };
};

/**
 * Get user's reviews (reviews they've written)
 */
export const getUserReviews = async (
  userId: string,
  pagination: { page: number; limit: number } = { page: 1, limit: 10 }
) => {
  const { page, limit } = pagination;
  const skip = (page - 1) * limit;
  const where: Prisma.ReviewWhereInput = { userId, AND: [NOT_DELETED] };

  const [reviews, total] = await Promise.all([
    prisma.review.findMany({
      where,
      include: {
        user: true,
        provider: {
          include: { user: true },
        },
        booking: {
          include: { service: true },
        },
      },
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
    }),
    prisma.review.count({ where }),
  ]);

  const totalPages = Math.ceil(total / limit);

  return {
    reviews: reviews.map(formatReviewResponse),
    total,
    page,
    limit,
    totalPages,
    hasNextPage: page < totalPages,
    hasPreviousPage: page > 1,
  };
};

/**
 * Get provider's average rating and review stats
 */
export const getProviderRatingStats = async (providerId: string) => {
  const where: Prisma.ReviewWhereInput = { providerId, AND: [NOT_DELETED] };

  const stats = await prisma.review.aggregate({
    where,
    _avg: { rating: true },
    _count: { id: true },
  });

  // Get rating distribution
  const ratingDistribution = await prisma.review.groupBy({
    by: ['rating'],
    where,
    _count: { rating: true },
  });

  // Convert to object
  const distribution: { [key: number]: number } = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  ratingDistribution.forEach((r) => {
    distribution[r.rating] = r._count.rating;
  });

  return {
    averageRating: stats._avg.rating ? Math.round(stats._avg.rating * 10) / 10 : 0,
    totalReviews: stats._count.id,
    ratingDistribution: distribution,
    fiveStars: distribution[5],
    fourStars: distribution[4],
    threeStars: distribution[3],
    twoStars: distribution[2],
    oneStar: distribution[1],
  };
};

/**
 * Get reviews for a specific service
 */
export const getServiceReviews = async (
  serviceId: string,
  pagination: { page: number; limit: number } = { page: 1, limit: 10 }
) => {
  const { page, limit } = pagination;
  const skip = (page - 1) * limit;
  const where: Prisma.ReviewWhereInput = { booking: { serviceId }, AND: [NOT_DELETED] };

  const [reviews, total] = await Promise.all([
    prisma.review.findMany({
      where,
      include: {
        user: true,
        provider: {
          include: { user: true },
        },
        booking: {
          include: { service: true },
        },
      },
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
    }),
    prisma.review.count({ where }),
  ]);

  const totalPages = Math.ceil(total / limit);

  return {
    reviews: reviews.map(formatReviewResponse),
    total,
    page,
    limit,
    totalPages,
    hasNextPage: page < totalPages,
    hasPreviousPage: page > 1,
  };
};

/**
 * Remove a review (admin only). The review is kept, marked with when, by whom
 * and why it was removed, and an audit log entry records what it said.
 */
export const deleteReview = async (
  reviewId: string,
  admin?: { id: string; role: string },
  reason?: string | null
) => {
  const review = await prisma.review.findUnique({
    where: { id: reviewId },
  });

  if (!review || review.deletedAt) {
    throw reviewNotFound();
  }

  const deletionReason = reason ? sanitizeBasic(reason) : '';

  if (deletionReason.length > MAX_DELETION_REASON_LENGTH) {
    throw new GraphQLError(`The reason must be at most ${MAX_DELETION_REASON_LENGTH} characters`, {
      extensions: { code: 'INVALID_INPUT' },
    });
  }

  const deletedAt = new Date();

  // Conditional, so a review removed twice at the same moment is logged once
  const { count } = await prisma.review.updateMany({
    where: { id: reviewId, AND: [NOT_DELETED] },
    data: {
      deletedAt,
      deletedBy: admin?.id ?? null,
      deletionReason: deletionReason || null,
    },
  });

  if (count === 0) {
    throw reviewNotFound();
  }

  if (admin) {
    try {
      await createAuditLog({
        action: AdminAction.DELETE_REVIEW,
        targetType: 'Review',
        targetId: reviewId,
        performedBy: admin.id,
        performedByRole: admin.role,
        previousValue: {
          rating: review.rating,
          comment: review.comment,
          response: review.response,
          isHidden: Boolean(review.isHidden),
          userId: review.userId,
          providerId: review.providerId,
          bookingId: review.bookingId,
        },
        newValue: { deletedAt: deletedAt.toISOString() },
        reason: deletionReason || undefined,
      });
    } catch (err) {
      logger.error('Failed to write review deletion audit log', { reviewId, err });
    }
  }

  return {
    success: true,
    message: 'Review deleted successfully',
  };
};

/**
 * Update a review (user can update their own review within 24 hours)
 */
export const updateReview = async (
  userId: string,
  reviewId: string,
  input: { rating?: number | null; comment?: string | null }
) => {
  const review = await prisma.review.findUnique({
    where: { id: reviewId },
    include: {
      user: true,
      provider: {
        include: { user: true },
      },
      booking: {
        include: { service: true },
      },
    },
  });

  if (!review || review.deletedAt) {
    throw reviewNotFound();
  }

  // Check if user owns the review
  if (review.userId !== userId) {
    throw new GraphQLError('You can only update your own reviews', {
      extensions: { code: 'FORBIDDEN' },
    });
  }

  // Check if within 24 hours
  const hoursSinceCreation = (Date.now() - review.createdAt.getTime()) / (1000 * 60 * 60);
  if (hoursSinceCreation > 24) {
    throw new GraphQLError('Reviews can only be updated within 24 hours of creation', {
      extensions: { code: 'UPDATE_WINDOW_EXPIRED' },
    });
  }

  // Build update data
  const updateData: Prisma.ReviewUpdateInput = {};

  if (input.rating !== undefined) {
    // Same rule and error as createReview; null is refused like any other bad rating
    updateData.rating = validateRating(input.rating ?? Number.NaN);
  }

  if (input.comment !== undefined) {
    const sanitizedComment = sanitizeBasic(input.comment ?? '');
    assertCommentLength(sanitizedComment);
    assertAcceptableText(sanitizedComment, 'Your review');
    await assertTermsAccepted(userId);
    updateData.comment = sanitizedComment;
  }

  const updatedReview = await prisma.review.update({
    where: { id: reviewId },
    data: updateData,
    include: {
      user: true,
      provider: {
        include: { user: true },
      },
      booking: {
        include: { service: true },
      },
    },
  });

  return formatReviewResponse(updatedReview);
};

/**
 * Check if user can review a booking
 */
export const canReviewBooking = async (userId: string, bookingId: string) => {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: { review: true },
  });

  if (!booking) {
    return {
      canReview: false,
      reason: 'Booking not found',
    };
  }

  if (booking.userId !== userId) {
    return {
      canReview: false,
      reason: 'You do not own this booking',
    };
  }

  if (booking.status !== BookingStatus.COMPLETED) {
    return {
      canReview: false,
      reason: 'Booking must be completed before reviewing',
    };
  }

  if (booking.review) {
    return {
      canReview: false,
      reason: booking.review.deletedAt
        ? "This booking's review was removed by Easykonnet"
        : 'You have already reviewed this booking',
    };
  }

  return {
    canReview: true,
    reason: null,
  };
};
