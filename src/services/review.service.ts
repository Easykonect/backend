/**
 * Review Service
 * Handles review and rating operations
 * 
 * Features:
 * - Create review after completed booking
 * - Provider response to reviews
 * - Get provider reviews with average rating
 * - User's reviews
 */

import { GraphQLError } from 'graphql';
import prisma from '@/lib/prisma';
import { BookingStatus } from '@/constants';

// ==================
// Types
// ==================

interface CreateReviewInput {
  bookingId: string;
  rating: number;
  comment?: string;
}

interface ReviewFiltersInput {
  providerId?: string;
  rating?: number;
  hasResponse?: boolean;
}

// ==================
// Helper Functions
// ==================

/**
 * Format review response
 */
const formatReviewResponse = (review: any) => ({
  id: review.id,
  rating: review.rating,
  comment: review.comment,
  response: review.response,
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
      title: review.booking.service.title,
    } : null,
  } : null,
});

// ==================
// Review Functions
// ==================

/**
 * Create a review for a completed booking
 */
export const createReview = async (userId: string, input: CreateReviewInput) => {
  const { bookingId, rating, comment } = input;

  // Validate rating
  if (rating < 1 || rating > 5) {
    throw new GraphQLError('Rating must be between 1 and 5', {
      extensions: { code: 'INVALID_RATING' },
    });
  }

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

  // Check if already reviewed
  if (booking.review) {
    throw new GraphQLError('You have already reviewed this booking', {
      extensions: { code: 'ALREADY_REVIEWED' },
    });
  }

  // Create review
  const review = await prisma.review.create({
    data: {
      bookingId,
      userId,
      providerId: booking.providerId,
      rating,
      comment,
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

  if (!review) {
    throw new GraphQLError('Review not found', {
      extensions: { code: 'NOT_FOUND' },
    });
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

  // Validate response
  if (!response || response.trim().length < 10) {
    throw new GraphQLError('Response must be at least 10 characters', {
      extensions: { code: 'INVALID_RESPONSE' },
    });
  }

  // Update review with response
  const updatedReview = await prisma.review.update({
    where: { id: reviewId },
    data: {
      response: response.trim(),
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

  if (!review) {
    throw new GraphQLError('Review not found', {
      extensions: { code: 'NOT_FOUND' },
    });
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

  // Build where clause
  const where: any = { providerId };

  if (filters.rating) {
    where.rating = filters.rating;
  }

  if (filters.hasResponse !== undefined) {
    where.response = filters.hasResponse ? { not: null } : null;
  }

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

  const [reviews, total] = await Promise.all([
    prisma.review.findMany({
      where: { userId },
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
    prisma.review.count({ where: { userId } }),
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
  const stats = await prisma.review.aggregate({
    where: { providerId },
    _avg: { rating: true },
    _count: { id: true },
  });

  // Get rating distribution
  const ratingDistribution = await prisma.review.groupBy({
    by: ['rating'],
    where: { providerId },
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

  const [reviews, total] = await Promise.all([
    prisma.review.findMany({
      where: {
        booking: {
          serviceId,
        },
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
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
    }),
    prisma.review.count({
      where: {
        booking: {
          serviceId,
        },
      },
    }),
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
 * Delete a review (admin only)
 */
export const deleteReview = async (reviewId: string) => {
  const review = await prisma.review.findUnique({
    where: { id: reviewId },
  });

  if (!review) {
    throw new GraphQLError('Review not found', {
      extensions: { code: 'NOT_FOUND' },
    });
  }

  await prisma.review.delete({
    where: { id: reviewId },
  });

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
  input: { rating?: number; comment?: string }
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

  if (!review) {
    throw new GraphQLError('Review not found', {
      extensions: { code: 'NOT_FOUND' },
    });
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

  // Validate rating if provided
  if (input.rating !== undefined && (input.rating < 1 || input.rating > 5)) {
    throw new GraphQLError('Rating must be between 1 and 5', {
      extensions: { code: 'INVALID_RATING' },
    });
  }

  // Build update data
  const updateData: any = {};
  if (input.rating !== undefined) updateData.rating = input.rating;
  if (input.comment !== undefined) updateData.comment = input.comment;

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
      reason: 'You have already reviewed this booking',
    };
  }

  return {
    canReview: true,
    reason: null,
  };
};
