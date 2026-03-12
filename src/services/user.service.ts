/**
 * User Service
 * Handles user management business logic
 */

import { GraphQLError } from 'graphql';
import prisma from '@/lib/prisma';
import { ErrorCode, ErrorMessage } from '@/constants';
import type { PaginationInput } from '@/utils/validation';

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
      phone: true,
      status: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  if (!user) {
    throw new GraphQLError(ErrorMessage[ErrorCode.USER_NOT_FOUND], {
      extensions: { code: ErrorCode.USER_NOT_FOUND },
    });
  }

  return user;
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
        status: true,
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
  }
) => {
  const user = await prisma.user.update({
    where: { id: userId },
    data,
    select: {
      id: true,
      email: true,
      firstName: true,
      lastName: true,
      phone: true,
      role: true,
    },
  });

  return user;
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
