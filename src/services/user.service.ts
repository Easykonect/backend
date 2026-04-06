/**
 * User Service
 * Handles user management business logic
 */

import { GraphQLError } from 'graphql';
import prisma from '@/lib/prisma';
import { ErrorCode, ErrorMessage } from '@/constants';
import type { PaginationInput } from '@/utils/validation';
import { generateOtp, hashOtp, verifyOtp, getOtpExpiry, isOtpExpired } from '@/lib/otp';
import { sendProfileUpdatedEmail, sendEmailChangeOtpEmail } from '@/lib/email';
import { sanitizeStrict, validateName, validatePhone, validateUrl, validateEmail } from '@/utils/security';

/**
 * Get user by ID
 */
export const getUserById = async (id: string) => {
  const user = await prisma.user.findUnique({
    where: { id },
    select: {
      id: true,
      email: true,
      firstName: true,
      lastName: true,
      role: true,
      activeRole: true,
      phone: true,
      profilePhoto: true,
      status: true,
      isEmailVerified: true,
      pushEnabled: true,
      lastLoginAt: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  if (!user) {
    throw new GraphQLError(ErrorMessage[ErrorCode.USER_NOT_FOUND], {
      extensions: { code: ErrorCode.USER_NOT_FOUND },
    });
  }

  return {
    ...user,
    activeRole: user.activeRole || user.role,
    pushEnabled: user.pushEnabled ?? true,
    lastLoginAt: user.lastLoginAt ? user.lastLoginAt.toISOString() : null,
  };
};

/**
 * Get all users with pagination (Admin only)
 */
export const getUsers = async (pagination: { page: number; limit: number }) => {
  const { page, limit } = pagination;
  const skip = (page - 1) * limit;

  const [users, total] = await Promise.all([
    prisma.user.findMany({
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        role: true,
        phone: true,
        profilePhoto: true,
        status: true,
        isEmailVerified: true,
        createdAt: true,
      },
    }),
    prisma.user.count(),
  ]);

  return {
    items: users,
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
    hasNextPage: page * limit < total,
    hasPreviousPage: page > 1,
  };
};

/**
 * Update user profile
 */
export const updateUserProfile = async (
  userId: string,
  data: {
    firstName?: string;
    lastName?: string;
    phone?: string;
    profilePhoto?: string;
  }
) => {
  const current = await prisma.user.findUnique({ where: { id: userId } });
  if (!current) {
    throw new GraphQLError(ErrorMessage[ErrorCode.USER_NOT_FOUND], {
      extensions: { code: ErrorCode.USER_NOT_FOUND },
    });
  }

  // Track changed fields for notification email
  const changedFields: string[] = [];
  
  // Sanitize and validate inputs
  let sanitizedFirstName: string | undefined;
  let sanitizedLastName: string | undefined;
  let sanitizedPhone: string | undefined;
  let sanitizedProfilePhoto: string | undefined;
  
  if (data.firstName) {
    sanitizedFirstName = validateName(data.firstName, 'First name');
    if (sanitizedFirstName !== current.firstName) changedFields.push('First Name');
  }
  if (data.lastName) {
    sanitizedLastName = validateName(data.lastName, 'Last name');
    if (sanitizedLastName !== current.lastName) changedFields.push('Last Name');
  }
  if (data.phone !== undefined) {
    sanitizedPhone = data.phone ? validatePhone(data.phone) : '';
    if (sanitizedPhone !== current.phone) changedFields.push('Phone Number');
  }
  if (data.profilePhoto !== undefined) {
    sanitizedProfilePhoto = data.profilePhoto ? validateUrl(data.profilePhoto) : '';
    if (sanitizedProfilePhoto !== current.profilePhoto) changedFields.push('Profile Photo');
  }

  if (changedFields.length === 0) {
    return current;
  }

  const user = await prisma.user.update({
    where: { id: userId },
    data: {
      ...(sanitizedFirstName && { firstName: sanitizedFirstName }),
      ...(sanitizedLastName && { lastName: sanitizedLastName }),
      ...(sanitizedPhone !== undefined && { phone: sanitizedPhone }),
      ...(sanitizedProfilePhoto !== undefined && { profilePhoto: sanitizedProfilePhoto }),
    },
    select: {
      id: true,
      email: true,
      firstName: true,
      lastName: true,
      phone: true,
      profilePhoto: true,
      role: true,
      status: true,
      isEmailVerified: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  // Non-blocking profile update notification
  sendProfileUpdatedEmail(current.email, current.firstName, changedFields).catch(() => {});

  return user;
};

/**
 * Request Email Change
 * Sends an OTP to the NEW email to confirm ownership
 */
export const requestEmailChange = async (userId: string, newEmail: string) => {
  // Validate and sanitize email
  const normalizedEmail = validateEmail(newEmail);

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    throw new GraphQLError(ErrorMessage[ErrorCode.USER_NOT_FOUND], {
      extensions: { code: ErrorCode.USER_NOT_FOUND },
    });
  }

  if (normalizedEmail === user.email) {
    throw new GraphQLError('New email must be different from your current email', {
      extensions: { code: 'VALIDATION_ERROR' },
    });
  }

  // Check new email is not already taken
  const existing = await prisma.user.findUnique({ where: { email: normalizedEmail } });
  if (existing) {
    throw new GraphQLError('This email address is already in use', {
      extensions: { code: 'USER_ALREADY_EXISTS' },
    });
  }

  // Generate OTP and stage the new email
  const otp = generateOtp();
  const hashedOtp = hashOtp(otp);
  const otpExpiry = getOtpExpiry();

  await prisma.user.update({
    where: { id: userId },
    data: {
      pendingEmail: normalizedEmail,
      emailVerifyToken: hashedOtp,
      emailVerifyExpiry: otpExpiry,
    },
  });

  // Send OTP to the new email
  await sendEmailChangeOtpEmail(normalizedEmail, user.firstName, otp);

  return {
    success: true,
    message: `A confirmation code has been sent to ${normalizedEmail}. It expires in 10 minutes.`,
  };
};

/**
 * Confirm Email Change
 * Verifies OTP and commits the new email
 */
export const confirmEmailChange = async (userId: string, otp: string) => {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    throw new GraphQLError(ErrorMessage[ErrorCode.USER_NOT_FOUND], {
      extensions: { code: ErrorCode.USER_NOT_FOUND },
    });
  }

  if (!user.pendingEmail || !user.emailVerifyToken) {
    throw new GraphQLError('No pending email change found. Please request a new one.', {
      extensions: { code: 'INVALID_REQUEST' },
    });
  }

  if (isOtpExpired(user.emailVerifyExpiry)) {
    throw new GraphQLError('Confirmation code has expired. Please request a new one.', {
      extensions: { code: 'OTP_EXPIRED' },
    });
  }

  if (!verifyOtp(otp, user.emailVerifyToken)) {
    throw new GraphQLError('Invalid confirmation code.', {
      extensions: { code: 'INVALID_OTP' },
    });
  }

  const oldEmail = user.email;
  const newEmail = user.pendingEmail;

  const updatedUser = await prisma.user.update({
    where: { id: userId },
    data: {
      email: newEmail,
      pendingEmail: null,
      emailVerifyToken: null,
      emailVerifyExpiry: null,
    },
    select: {
      id: true,
      email: true,
      firstName: true,
      lastName: true,
      phone: true,
      profilePhoto: true,
      role: true,
      status: true,
      isEmailVerified: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  // Notify old email of the change
  sendProfileUpdatedEmail(oldEmail, user.firstName, ['Email Address']).catch(() => {});

  return updatedUser;
};

/**
 * Delete user (Admin only)
 */
export const deleteUser = async (id: string) => {
  const user = await prisma.user.findUnique({
    where: { id },
  });

  if (!user) {
    throw new GraphQLError(ErrorMessage[ErrorCode.USER_NOT_FOUND], {
      extensions: { code: ErrorCode.USER_NOT_FOUND },
    });
  }

  // Check if user has provider profile
  const provider = await prisma.serviceProvider.findUnique({
    where: { userId: id },
  });

  // Delete in transaction
  await prisma.$transaction(async (tx) => {
    if (provider) {
      // Delete provider's services first
      await tx.service.deleteMany({
        where: { providerId: provider.id },
      });
      // Delete provider profile
      await tx.serviceProvider.delete({
        where: { id: provider.id },
      });
    }
    // Delete user
    await tx.user.delete({
      where: { id },
    });
  });

  return { success: true, message: 'User deleted successfully' };
};

/**
 * Delete own account
 */
export const deleteOwnAccount = async (userId: string) => {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      provider: {
        include: {
          _count: {
            select: {
              bookings: true,
            },
          },
        },
      },
    },
  });

  if (!user) {
    throw new GraphQLError(ErrorMessage[ErrorCode.USER_NOT_FOUND], {
      extensions: { code: ErrorCode.USER_NOT_FOUND },
    });
  }

  // Check for active bookings if provider
  if (user.provider && user.provider._count.bookings > 0) {
    throw new GraphQLError(
      'Cannot delete account with active bookings. Please complete or cancel pending bookings first.',
      { extensions: { code: 'HAS_ACTIVE_BOOKINGS' } }
    );
  }

  // Delete in transaction
  await prisma.$transaction(async (tx) => {
    if (user.provider) {
      // Delete provider's services
      await tx.service.deleteMany({
        where: { providerId: user.provider.id },
      });
      // Delete provider profile
      await tx.serviceProvider.delete({
        where: { id: user.provider.id },
      });
    }
    // Delete user
    await tx.user.delete({
      where: { id: userId },
    });
  });

  return {
    success: true,
    message: 'Your account has been deleted successfully.',
  };
};

// ==================
// Provider Like Functions
// ==================

/**
 * Like a service provider
 */
export const likeProvider = async (userId: string, providerId: string) => {
  // Check if provider exists
  const provider = await prisma.serviceProvider.findUnique({
    where: { id: providerId },
    select: { id: true, businessName: true },
  });

  if (!provider) {
    throw new GraphQLError('Service provider not found', {
      extensions: { code: 'NOT_FOUND' },
    });
  }

  // Check if already liked
  const existingLike = await prisma.providerLike.findUnique({
    where: {
      userId_providerId: {
        userId,
        providerId,
      },
    },
  });

  if (existingLike) {
    throw new GraphQLError('You have already liked this provider', {
      extensions: { code: 'ALREADY_LIKED' },
    });
  }

  // Create like
  await prisma.providerLike.create({
    data: {
      userId,
      providerId,
    },
  });

  // Get updated like count
  const likeCount = await prisma.providerLike.count({
    where: { providerId },
  });

  return {
    success: true,
    message: `You liked ${provider.businessName}`,
    likeCount,
  };
};

/**
 * Unlike a service provider
 */
export const unlikeProvider = async (userId: string, providerId: string) => {
  // Check if provider exists
  const provider = await prisma.serviceProvider.findUnique({
    where: { id: providerId },
    select: { id: true, businessName: true },
  });

  if (!provider) {
    throw new GraphQLError('Service provider not found', {
      extensions: { code: 'NOT_FOUND' },
    });
  }

  // Check if liked
  const existingLike = await prisma.providerLike.findUnique({
    where: {
      userId_providerId: {
        userId,
        providerId,
      },
    },
  });

  if (!existingLike) {
    throw new GraphQLError('You have not liked this provider', {
      extensions: { code: 'NOT_LIKED' },
    });
  }

  // Delete like
  await prisma.providerLike.delete({
    where: {
      userId_providerId: {
        userId,
        providerId,
      },
    },
  });

  // Get updated like count
  const likeCount = await prisma.providerLike.count({
    where: { providerId },
  });

  return {
    success: true,
    message: `You unliked ${provider.businessName}`,
    likeCount,
  };
};

/**
 * Toggle like on a service provider
 */
export const toggleProviderLike = async (userId: string, providerId: string) => {
  // Check if provider exists
  const provider = await prisma.serviceProvider.findUnique({
    where: { id: providerId },
    select: { id: true, businessName: true },
  });

  if (!provider) {
    throw new GraphQLError('Service provider not found', {
      extensions: { code: 'NOT_FOUND' },
    });
  }

  // Check if already liked
  const existingLike = await prisma.providerLike.findUnique({
    where: {
      userId_providerId: {
        userId,
        providerId,
      },
    },
  });

  if (existingLike) {
    // Unlike
    await prisma.providerLike.delete({
      where: {
        userId_providerId: {
          userId,
          providerId,
        },
      },
    });

    const likeCount = await prisma.providerLike.count({
      where: { providerId },
    });

    return {
      success: true,
      message: `You unliked ${provider.businessName}`,
      isLiked: false,
      likeCount,
    };
  } else {
    // Like
    await prisma.providerLike.create({
      data: {
        userId,
        providerId,
      },
    });

    const likeCount = await prisma.providerLike.count({
      where: { providerId },
    });

    return {
      success: true,
      message: `You liked ${provider.businessName}`,
      isLiked: true,
      likeCount,
    };
  }
};

/**
 * Check if user has liked a provider
 */
export const isProviderLiked = async (userId: string, providerId: string) => {
  const like = await prisma.providerLike.findUnique({
    where: {
      userId_providerId: {
        userId,
        providerId,
      },
    },
  });

  return !!like;
};

/**
 * Get provider like count
 */
export const getProviderLikeCount = async (providerId: string) => {
  return prisma.providerLike.count({
    where: { providerId },
  });
};

/**
 * Get user's liked providers
 */
export const getMyLikedProviders = async (
  userId: string,
  pagination: { page: number; limit: number } = { page: 1, limit: 10 }
) => {
  const { page, limit } = pagination;
  const skip = (page - 1) * limit;

  const [likes, total] = await Promise.all([
    prisma.providerLike.findMany({
      where: { userId },
      include: {
        provider: {
          include: {
            user: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                profilePhoto: true,
              },
            },
            _count: {
              select: {
                reviews: true,
                likes: true,
              },
            },
          },
        },
      },
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
    }),
    prisma.providerLike.count({ where: { userId } }),
  ]);

  const totalPages = Math.ceil(total / limit);

  return {
    items: likes.map((like) => ({
      id: like.id,
      likedAt: like.createdAt.toISOString(),
      provider: {
        id: like.provider.id,
        businessName: like.provider.businessName,
        businessDescription: like.provider.businessDescription,
        verificationStatus: like.provider.verificationStatus,
        city: like.provider.city,
        state: like.provider.state,
        images: like.provider.images,
        user: like.provider.user,
        reviewCount: like.provider._count.reviews,
        likeCount: like.provider._count.likes,
      },
    })),
    pagination: {
      page,
      limit,
      total,
      totalPages,
      hasNext: page < totalPages,
      hasPrev: page > 1,
    },
  };
};
