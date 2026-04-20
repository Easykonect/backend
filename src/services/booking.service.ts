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
 */

import prisma from '@/lib/prisma';
import { BookingStatus, UserRole, ServiceStatus } from '@/constants';
import { GraphQLError } from 'graphql';
import { config } from '@/config';

// ==================
// Types
// ==================

interface CreateBookingInput {
  serviceId: string;
  scheduledDate: string; // ISO date string
  scheduledTime: string; // e.g., "14:00"
  address: string;
  city: string;
  state: string;
  notes?: string;
}

interface UpdateBookingInput {
  scheduledDate?: string;
  scheduledTime?: string;
  address?: string;
  city?: string;
  state?: string;
  notes?: string;
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

// Platform commission rate from environment config
const COMMISSION_RATE = config.platform.commissionRate;

// ==================
// Helper Functions
// ==================

/**
 * Format booking response for GraphQL
 * Maps provider to ServiceProviderProfile type
 */
const formatBookingResponse = (booking: any) => {
  return {
    ...booking,
    // Include customer confirmation and payment release fields
    customerConfirmedAt: booking.customerConfirmedAt?.toISOString() || null,
    paymentReleaseAt: booking.paymentReleaseAt?.toISOString() || null,
    paymentReleasedAt: booking.paymentReleasedAt?.toISOString() || null,
    // Map provider (ServiceProvider) to the expected ServiceProviderProfile format
    provider: booking.provider ? {
      id: booking.provider.id,
      businessName: booking.provider.businessName,
      businessDescription: booking.provider.businessDescription,
      verificationStatus: booking.provider.verificationStatus,
      address: booking.provider.address,
      city: booking.provider.city,
      state: booking.provider.state,
      country: booking.provider.country,
      latitude: booking.provider.latitude,
      longitude: booking.provider.longitude,
      documents: booking.provider.documents,
      createdAt: booking.provider.createdAt,
      updatedAt: booking.provider.updatedAt,
    } : null,
    // Map service to include provider profile format
    service: booking.service ? {
      ...booking.service,
      provider: booking.service.provider ? {
        id: booking.service.provider.id,
        businessName: booking.service.provider.businessName,
        businessDescription: booking.service.provider.businessDescription,
        verificationStatus: booking.service.provider.verificationStatus,
        address: booking.service.provider.address,
        city: booking.service.provider.city,
        state: booking.service.provider.state,
        country: booking.service.provider.country,
        latitude: booking.service.provider.latitude,
        longitude: booking.service.provider.longitude,
        documents: booking.service.provider.documents,
        createdAt: booking.service.provider.createdAt,
        updatedAt: booking.service.provider.updatedAt,
      } : booking.provider ? {
        id: booking.provider.id,
        businessName: booking.provider.businessName,
        businessDescription: booking.provider.businessDescription,
        verificationStatus: booking.provider.verificationStatus,
        address: booking.provider.address,
        city: booking.provider.city,
        state: booking.provider.state,
        country: booking.provider.country,
        latitude: booking.provider.latitude,
        longitude: booking.provider.longitude,
        documents: booking.provider.documents,
        createdAt: booking.provider.createdAt,
        updatedAt: booking.provider.updatedAt,
      } : null,
    } : null,
  };
};

/**
 * Calculate booking pricing
 */
const calculateBookingPricing = (servicePrice: number) => {
  const commission = servicePrice * COMMISSION_RATE;
  const totalAmount = servicePrice; // Customer pays service price
  return { servicePrice, commission, totalAmount };
};

/**
 * Validate booking date and time
 */
const validateBookingDateTime = (scheduledDate: string, scheduledTime: string) => {
  const bookingDateTime = new Date(`${scheduledDate}T${scheduledTime}`);
  const now = new Date();
  
  // Booking must be at least 2 hours in the future
  const minimumBookingTime = new Date(now.getTime() + 2 * 60 * 60 * 1000);
  
  if (bookingDateTime < minimumBookingTime) {
    throw new GraphQLError('Booking must be scheduled at least 2 hours in advance', {
      extensions: { code: 'INVALID_BOOKING_TIME' }
    });
  }
  
  // Booking must be within 30 days
  const maxBookingTime = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  if (bookingDateTime > maxBookingTime) {
    throw new GraphQLError('Booking cannot be scheduled more than 30 days in advance', {
      extensions: { code: 'INVALID_BOOKING_TIME' }
    });
  }
  
  return bookingDateTime;
};

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

  // Calculate pricing
  const pricing = calculateBookingPricing(service.price);

  // Create the booking
  const booking = await prisma.booking.create({
    data: {
      userId,
      providerId: service.providerId,
      serviceId: service.id,
      status: BookingStatus.PENDING,
      scheduledDate: new Date(input.scheduledDate),
      scheduledTime: input.scheduledTime,
      address: input.address,
      city: input.city,
      state: input.state,
      notes: input.notes,
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

  return formatBookingResponse(booking);
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

  // If already accepted, check cancellation window (24 hours before scheduled time)
  if (booking.status === BookingStatus.ACCEPTED) {
    const scheduledDateTime = new Date(`${booking.scheduledDate.toISOString().split('T')[0]}T${booking.scheduledTime}`);
    const cancellationDeadline = new Date(scheduledDateTime.getTime() - 24 * 60 * 60 * 1000);
    
    if (new Date() > cancellationDeadline) {
      throw new GraphQLError('Cannot cancel booking within 24 hours of scheduled time. Please contact the provider.', {
        extensions: { code: 'CANCELLATION_WINDOW_PASSED' }
      });
    }
  }

  const cancelledBooking = await prisma.booking.update({
    where: { id: bookingId },
    data: {
      status: BookingStatus.CANCELLED,
      cancelledAt: new Date(),
      cancellationReason: reason
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

  return formatBookingResponse(cancelledBooking);
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

  // Validate new date/time if provided
  if (input.scheduledDate || input.scheduledTime) {
    const newDate = input.scheduledDate || booking.scheduledDate.toISOString().split('T')[0];
    const newTime = input.scheduledTime || booking.scheduledTime;
    validateBookingDateTime(newDate, newTime);
  }

  const updatedBooking = await prisma.booking.update({
    where: { id: bookingId },
    data: {
      ...(input.scheduledDate && { scheduledDate: new Date(input.scheduledDate) }),
      ...(input.scheduledTime && { scheduledTime: input.scheduledTime }),
      ...(input.address && { address: input.address }),
      ...(input.city && { city: input.city }),
      ...(input.state && { state: input.state }),
      ...(input.notes !== undefined && { notes: input.notes }),
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

  const acceptedBooking = await prisma.booking.update({
    where: { id: bookingId },
    data: { status: BookingStatus.ACCEPTED },
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

  return formatBookingResponse(acceptedBooking);
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

  const rejectedBooking = await prisma.booking.update({
    where: { id: bookingId },
    data: {
      status: BookingStatus.REJECTED,
      cancellationReason: reason
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

  return formatBookingResponse(rejectedBooking);
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
    where: { id: bookingId }
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
    throw new GraphQLError(`Cannot start a booking with status: ${booking.status}. Booking must be ACCEPTED first.`, {
      extensions: { code: 'INVALID_BOOKING_STATUS' }
    });
  }

  const inProgressBooking = await prisma.booking.update({
    where: { id: bookingId },
    data: { status: BookingStatus.IN_PROGRESS },
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

  return formatBookingResponse(inProgressBooking);
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

  const completedBooking = await prisma.booking.update({
    where: { id: bookingId },
    data: {
      status: BookingStatus.COMPLETED,
      completedAt: new Date()
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

  return formatBookingResponse(completedBooking);
};

// ==================
// Dispute Window Constants
// ==================

const DISPUTE_WINDOW_HOURS = 24;

/**
 * Confirm service delivery (USER only)
 * Starts the 24-hour dispute window before payment is released to provider
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

  // Calculate payment release time (24 hours from now)
  const now = new Date();
  const paymentReleaseAt = new Date(now.getTime() + DISPUTE_WINDOW_HOURS * 60 * 60 * 1000);

  // Update booking with confirmation
  const confirmedBooking = await prisma.booking.update({
    where: { id: bookingId },
    data: {
      customerConfirmedAt: now,
      paymentReleaseAt: paymentReleaseAt,
    },
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

  return formatBookingResponse(confirmedBooking);
};

/**
 * Get bookings ready for payment release
 * Returns bookings where:
 * - Customer has confirmed delivery
 * - 24-hour dispute window has passed
 * - Payment has not been released yet
 * - No active dispute
 */
export const getBookingsReadyForPaymentRelease = async () => {
  const now = new Date();

  const bookings = await prisma.booking.findMany({
    where: {
      status: BookingStatus.COMPLETED,
      customerConfirmedAt: { not: null },
      paymentReleaseAt: { lte: now },
      paymentReleasedAt: null,
      dispute: null, // No dispute
    },
    include: {
      payment: true,
      provider: {
        include: { user: true }
      },
      user: true,
      service: true,
    }
  });

  return bookings;
};

/**
 * Mark payment as released to provider
 */
export const markPaymentReleased = async (bookingId: string) => {
  const booking = await prisma.booking.update({
    where: { id: bookingId },
    data: {
      paymentReleasedAt: new Date(),
    },
    include: {
      payment: true,
      provider: true,
    }
  });

  // Update payment payoutAt
  if (booking.payment) {
    await prisma.payment.update({
      where: { id: booking.payment.id },
      data: {
        payoutAt: new Date(),
      }
    });
  }

  return booking;
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
 * Admin cancel booking
 */
export const adminCancelBooking = async (bookingId: string, reason: string) => {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId }
  });

  if (!booking) {
    throw new GraphQLError('Booking not found', {
      extensions: { code: 'BOOKING_NOT_FOUND' }
    });
  }

  // Admin can cancel any booking that's not already completed
  if (booking.status === BookingStatus.COMPLETED) {
    throw new GraphQLError('Cannot cancel a completed booking', {
      extensions: { code: 'INVALID_BOOKING_STATUS' }
    });
  }

  const cancelledBooking = await prisma.booking.update({
    where: { id: bookingId },
    data: {
      status: BookingStatus.CANCELLED,
      cancelledAt: new Date(),
      cancellationReason: `[Admin] ${reason}`
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

  return formatBookingResponse(cancelledBooking);
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
    totalRevenue
  ] = await Promise.all([
    prisma.booking.count({ where: { providerId: provider.id } }),
    prisma.booking.count({ where: { providerId: provider.id, status: BookingStatus.PENDING } }),
    prisma.booking.count({ where: { providerId: provider.id, status: BookingStatus.COMPLETED } }),
    prisma.booking.count({ where: { providerId: provider.id, status: BookingStatus.CANCELLED } }),
    prisma.booking.aggregate({
      where: { providerId: provider.id, status: BookingStatus.COMPLETED },
      _sum: { servicePrice: true }
    })
  ]);

  return {
    totalBookings,
    pendingBookings,
    completedBookings,
    cancelledBookings,
    totalRevenue: totalRevenue._sum.servicePrice || 0,
    completionRate: totalBookings > 0 ? (completedBookings / totalBookings) * 100 : 0
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
