/**
 * User Management Service
 * 
 * Admin functions for managing users and providers.
 * 
 * Features:
 * - List/search users and providers
 * - View detailed user/provider profiles
 * - Ban and restrict users
 * - Force session invalidation
 */

import { GraphQLError } from 'graphql';
import prisma from '@/lib/prisma';
import { UserRole, AccountStatus, AdminAction } from '@prisma/client';
import { createAuditLog } from './audit.service';
import { createNotification } from './notification.service';

// ==========================================
// Types
// ==========================================

interface UserFilters {
  role?: UserRole;
  status?: AccountStatus;
  search?: string;
  isBanned?: boolean;
  isRestricted?: boolean;
}

interface ProviderFilters {
  verificationStatus?: string;
  status?: AccountStatus;
  search?: string;
  city?: string;
  state?: string;
}

interface PaginationInput {
  page: number;
  limit: number;
}

interface BanUserInput {
  userId: string;
  reason: string;
  days?: number; // null = permanent
}

interface RestrictUserInput {
  userId: string;
  reason: string;
  days: number;
}

// ==========================================
// Constants
// ==========================================

const ADMIN_ROLES = [UserRole.ADMIN, UserRole.SUPER_ADMIN];
const MANAGEABLE_ROLES: string[] = [UserRole.SERVICE_USER, UserRole.SERVICE_PROVIDER];

// ==========================================
// Helper Functions
// ==========================================

/**
 * Check if admin can act on target user
 */
const canAdminActOn = (
  adminRole: string,
  targetRole: string,
  action: 'BAN' | 'RESTRICT' | 'SUSPEND'
): boolean => {
  // Super Admin can act on anyone except other Super Admins (for ban)
  if (adminRole === UserRole.SUPER_ADMIN) {
    if (action === 'BAN' && targetRole === UserRole.SUPER_ADMIN) {
      return false;
    }
    return true;
  }

  // Admin can only act on SERVICE_USER and SERVICE_PROVIDER
  if (adminRole === UserRole.ADMIN) {
    return MANAGEABLE_ROLES.includes(targetRole);
  }

  return false;
};

/**
 * Format user for management response
 */
const formatUserForManagement = (user: any) => ({
  id: user.id,
  email: user.email,
  firstName: user.firstName,
  lastName: user.lastName,
  phone: user.phone,
  profilePhoto: user.profilePhoto,
  role: user.role,
  status: user.status,
  isEmailVerified: user.isEmailVerified,
  bannedAt: user.bannedAt?.toISOString() || null,
  bannedUntil: user.bannedUntil?.toISOString() || null,
  banReason: user.banReason,
  restrictedAt: user.restrictedAt?.toISOString() || null,
  restrictedUntil: user.restrictedUntil?.toISOString() || null,
  restrictionReason: user.restrictionReason,
  lastLoginAt: user.lastLoginAt?.toISOString() || null,
  createdAt: user.createdAt.toISOString(),
  updatedAt: user.updatedAt.toISOString(),
});

/**
 * Format provider for management response
 */
const formatProviderForManagement = (provider: any) => ({
  id: provider.id,
  userId: provider.userId,
  businessName: provider.businessName,
  businessDescription: provider.businessDescription,
  verificationStatus: provider.verificationStatus,
  address: provider.address,
  city: provider.city,
  state: provider.state,
  country: provider.country,
  createdAt: provider.createdAt.toISOString(),
  updatedAt: provider.updatedAt.toISOString(),
  user: provider.user ? formatUserForManagement(provider.user) : null,
  servicesCount: provider._count?.services || 0,
  bookingsCount: provider._count?.bookings || 0,
  reviewsCount: provider._count?.reviews || 0,
  averageRating: provider.averageRating || null,
});

// ==========================================
// User Listing Functions
// ==========================================

/**
 * Get all users with filters (admin)
 */
export const getAllUsers = async (
  filters: UserFilters,
  pagination: PaginationInput
) => {
  const { page, limit } = pagination;
  const skip = (page - 1) * limit;

  const where: any = {};

  if (filters.role) {
    where.role = filters.role;
  }

  if (filters.status) {
    where.status = filters.status;
  }

  if (filters.search) {
    where.OR = [
      { email: { contains: filters.search, mode: 'insensitive' } },
      { firstName: { contains: filters.search, mode: 'insensitive' } },
      { lastName: { contains: filters.search, mode: 'insensitive' } },
      { phone: { contains: filters.search } },
    ];
  }

  if (filters.isBanned === true) {
    where.bannedAt = { not: null };
  } else if (filters.isBanned === false) {
    where.bannedAt = null;
  }

  if (filters.isRestricted === true) {
    where.restrictedAt = { not: null };
  } else if (filters.isRestricted === false) {
    where.restrictedAt = null;
  }

  const [users, total] = await Promise.all([
    prisma.user.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
      include: {
        _count: {
          select: {
            bookingsAsUser: true,
            reviews: true,
          },
        },
      },
    }),
    prisma.user.count({ where }),
  ]);

  return {
    users: users.map((u) => ({
      ...formatUserForManagement(u),
      bookingsCount: u._count?.bookingsAsUser || 0,
      reviewsCount: u._count?.reviews || 0,
    })),
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
      hasNext: page * limit < total,
      hasPrev: page > 1,
    },
  };
};

/**
 * Get user details with full history (admin)
 */
export const getUserDetails = async (userId: string) => {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      provider: true,
      bookingsAsUser: {
        take: 10,
        orderBy: { createdAt: 'desc' },
        include: {
          service: { select: { name: true, price: true } },
          provider: { select: { businessName: true } },
          payment: true,
        },
      },
      reviews: {
        take: 10,
        orderBy: { createdAt: 'desc' },
      },
      wallet: true,
      _count: {
        select: {
          bookingsAsUser: true,
          reviews: true,
          favourites: true,
        },
      },
    },
  });

  if (!user) {
    throw new GraphQLError('User not found', {
      extensions: { code: 'NOT_FOUND' },
    });
  }

  // Calculate total spent
  const totalSpent = await prisma.payment.aggregate({
    where: {
      booking: { userId },
      status: 'COMPLETED',
    },
    _sum: { amount: true },
  });

  return {
    ...formatUserForManagement(user),
    provider: user.provider ? {
      id: user.provider.id,
      businessName: user.provider.businessName,
      verificationStatus: user.provider.verificationStatus,
    } : null,
    wallet: user.wallet ? {
      id: user.wallet.id,
      balance: (user.wallet as any).balance / 100, // Convert kobo to naira
      pendingBalance: (user.wallet as any).pendingBalance / 100,
    } : null,
    recentBookings: user.bookingsAsUser.map((b) => ({
      id: b.id,
      status: b.status,
      serviceName: b.service.name,
      providerName: b.provider.businessName,
      amount: b.totalAmount,
      scheduledDate: b.scheduledDate,
      paymentStatus: b.payment?.status || null,
    })),
    stats: {
      totalBookings: user._count.bookingsAsUser,
      totalReviews: user._count.reviews,
      totalFavourites: user._count.favourites,
      totalSpent: totalSpent._sum.amount || 0,
    },
  };
};

/**
 * Get all providers with filters (admin)
 */
export const getAllProviders = async (
  filters: ProviderFilters,
  pagination: PaginationInput
) => {
  const { page, limit } = pagination;
  const skip = (page - 1) * limit;

  const where: any = {};

  if (filters.verificationStatus) {
    where.verificationStatus = filters.verificationStatus;
  }

  if (filters.city) {
    where.city = { contains: filters.city, mode: 'insensitive' };
  }

  if (filters.state) {
    where.state = { contains: filters.state, mode: 'insensitive' };
  }

  if (filters.status) {
    where.user = { status: filters.status };
  }

  if (filters.search) {
    where.OR = [
      { businessName: { contains: filters.search, mode: 'insensitive' } },
      { user: { email: { contains: filters.search, mode: 'insensitive' } } },
      { user: { firstName: { contains: filters.search, mode: 'insensitive' } } },
      { user: { lastName: { contains: filters.search, mode: 'insensitive' } } },
    ];
  }

  const [providers, total] = await Promise.all([
    prisma.serviceProvider.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
      include: {
        user: true,
        _count: {
          select: {
            services: true,
            bookings: true,
            reviews: true,
          },
        },
      },
    }),
    prisma.serviceProvider.count({ where }),
  ]);

  // Calculate average ratings
  const providersWithRatings = await Promise.all(
    providers.map(async (p) => {
      const avgRating = await prisma.review.aggregate({
        where: { providerId: p.id },
        _avg: { rating: true },
      });
      return {
        ...p,
        averageRating: avgRating._avg.rating,
      };
    })
  );

  return {
    providers: providersWithRatings.map(formatProviderForManagement),
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
      hasNext: page * limit < total,
      hasPrev: page > 1,
    },
  };
};

/**
 * Get provider details with earnings and history (admin)
 */
export const getProviderDetails = async (providerId: string) => {
  const provider = await prisma.serviceProvider.findUnique({
    where: { id: providerId },
    include: {
      user: {
        include: {
          wallet: true,
        },
      },
      services: {
        take: 10,
        orderBy: { createdAt: 'desc' },
      },
      bookings: {
        take: 10,
        orderBy: { createdAt: 'desc' },
        include: {
          user: { select: { firstName: true, lastName: true, email: true } },
          service: { select: { name: true } },
          payment: true,
        },
      },
      reviews: {
        take: 10,
        orderBy: { createdAt: 'desc' },
        include: {
          user: { select: { firstName: true, lastName: true } },
        },
      },
      bankAccounts: true,
      _count: {
        select: {
          services: true,
          bookings: true,
          reviews: true,
        },
      },
    },
  });

  if (!provider) {
    throw new GraphQLError('Provider not found', {
      extensions: { code: 'NOT_FOUND' },
    });
  }

  // Calculate earnings
  const earnings = await prisma.payment.aggregate({
    where: {
      booking: { providerId },
      status: 'COMPLETED',
    },
    _sum: { providerPayout: true },
  });

  // Calculate average rating
  const avgRating = await prisma.review.aggregate({
    where: { providerId },
    _avg: { rating: true },
  });

  // Get withdrawal stats
  const withdrawals = await prisma.withdrawal.aggregate({
    where: {
      providerId,
      status: 'COMPLETED',
    },
    _sum: { amount: true },
    _count: true,
  });

  return {
    ...formatProviderForManagement(provider),
    user: formatUserForManagement(provider.user),
    wallet: provider.user.wallet ? {
      id: provider.user.wallet.id,
      balance: (provider.user.wallet as any).balance / 100,
      pendingBalance: (provider.user.wallet as any).pendingBalance / 100,
      isLocked: (provider.user.wallet as any).isLocked,
    } : null,
    services: provider.services.map((s) => ({
      id: s.id,
      name: s.name,
      price: s.price,
      status: s.status,
    })),
    recentBookings: provider.bookings.map((b) => ({
      id: b.id,
      status: b.status,
      serviceName: b.service.name,
      customerName: `${b.user.firstName} ${b.user.lastName}`,
      amount: b.totalAmount,
      scheduledDate: b.scheduledDate,
      paymentStatus: b.payment?.status || null,
    })),
    recentReviews: provider.reviews.map((r) => ({
      id: r.id,
      rating: r.rating,
      comment: r.comment,
      userName: `${r.user.firstName} ${r.user.lastName}`,
      createdAt: r.createdAt.toISOString(),
    })),
    bankAccounts: provider.bankAccounts.map((ba) => ({
      id: ba.id,
      bankName: ba.bankName,
      accountNumber: ba.accountNumber,
      accountName: ba.accountName,
      isDefault: ba.isDefault,
    })),
    stats: {
      totalServices: provider._count.services,
      totalBookings: provider._count.bookings,
      totalReviews: provider._count.reviews,
      averageRating: avgRating._avg.rating || 0,
      totalEarnings: earnings._sum.providerPayout || 0,
      totalWithdrawn: (withdrawals._sum.amount || 0) / 100,
      withdrawalCount: withdrawals._count,
    },
  };
};

// ==========================================
// Ban/Restrict Functions
// ==========================================

/**
 * Ban a user (admin)
 */
export const banUser = async (
  input: BanUserInput,
  adminId: string,
  adminRole: string,
  ipAddress?: string
) => {
  const { userId, reason, days } = input;

  // Self-check
  if (userId === adminId) {
    throw new GraphQLError('You cannot ban yourself', {
      extensions: { code: 'SELF_ACTION_FORBIDDEN' },
    });
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
  });

  if (!user) {
    throw new GraphQLError('User not found', {
      extensions: { code: 'NOT_FOUND' },
    });
  }

  // Role hierarchy check
  if (!canAdminActOn(adminRole, user.role, 'BAN')) {
    throw new GraphQLError('You do not have permission to ban this user', {
      extensions: { code: 'FORBIDDEN' },
    });
  }

  // Calculate ban end date
  const bannedUntil = days
    ? new Date(Date.now() + days * 24 * 60 * 60 * 1000)
    : null; // null = permanent

  // Update user
  await prisma.user.update({
    where: { id: userId },
    data: {
      bannedAt: new Date(),
      bannedUntil,
      banReason: reason,
      bannedBy: adminId,
      tokenInvalidatedAt: new Date(), // Force re-login (which will fail)
    },
  });

  // Create audit log
  await createAuditLog({
    action: 'BAN_USER' as AdminAction,
    targetType: 'User',
    targetId: userId,
    performedBy: adminId,
    performedByRole: adminRole,
    previousValue: { bannedAt: null },
    newValue: { bannedAt: new Date(), bannedUntil, banReason: reason },
    reason,
    ipAddress,
  });

  // Notify user
  await createNotification({
    userId,
    type: 'ACCOUNT_SUSPENDED',
    title: 'Account Banned',
    message: days
      ? `Your account has been banned for ${days} days. Reason: ${reason}`
      : `Your account has been permanently banned. Reason: ${reason}`,
    metadata: { reason, bannedUntil },
  });

  return {
    success: true,
    message: days
      ? `User banned for ${days} days`
      : 'User permanently banned',
    bannedUntil,
  };
};

/**
 * Unban a user (admin)
 */
export const unbanUser = async (
  userId: string,
  adminId: string,
  adminRole: string,
  ipAddress?: string
) => {
  const user = await prisma.user.findUnique({
    where: { id: userId },
  });

  if (!user) {
    throw new GraphQLError('User not found', {
      extensions: { code: 'NOT_FOUND' },
    });
  }

  if (!user.bannedAt) {
    throw new GraphQLError('User is not banned', {
      extensions: { code: 'NOT_BANNED' },
    });
  }

  // Update user
  await prisma.user.update({
    where: { id: userId },
    data: {
      bannedAt: null,
      bannedUntil: null,
      banReason: null,
      bannedBy: null,
    },
  });

  // Create audit log
  await createAuditLog({
    action: 'UNBAN_USER' as AdminAction,
    targetType: 'User',
    targetId: userId,
    performedBy: adminId,
    performedByRole: adminRole,
    previousValue: { bannedAt: user.bannedAt, banReason: user.banReason },
    newValue: { bannedAt: null },
    ipAddress,
  });

  // Notify user
  await createNotification({
    userId,
    type: 'ACCOUNT_ACTIVATED',
    title: 'Account Unbanned',
    message: 'Your account ban has been lifted. You can now access your account.',
  });

  return {
    success: true,
    message: 'User unbanned successfully',
  };
};

/**
 * Restrict a user (admin)
 * User can login but cannot transact
 */
export const restrictUser = async (
  input: RestrictUserInput,
  adminId: string,
  adminRole: string,
  ipAddress?: string
) => {
  const { userId, reason, days } = input;

  // Self-check
  if (userId === adminId) {
    throw new GraphQLError('You cannot restrict yourself', {
      extensions: { code: 'SELF_ACTION_FORBIDDEN' },
    });
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      _count: {
        select: {
          bookingsAsUser: {
            where: {
              status: { in: ['PENDING', 'ACCEPTED', 'IN_PROGRESS'] },
            },
          },
        },
      },
    },
  });

  if (!user) {
    throw new GraphQLError('User not found', {
      extensions: { code: 'NOT_FOUND' },
    });
  }

  // Role hierarchy check
  if (!canAdminActOn(adminRole, user.role, 'RESTRICT')) {
    throw new GraphQLError('You do not have permission to restrict this user', {
      extensions: { code: 'FORBIDDEN' },
    });
  }

  const restrictedUntil = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  const pendingBookingsCount = user._count.bookingsAsUser;

  // Update user
  await prisma.user.update({
    where: { id: userId },
    data: {
      restrictedAt: new Date(),
      restrictedUntil,
      restrictionReason: reason,
      restrictedBy: adminId,
    },
  });

  // Create audit log
  await createAuditLog({
    action: 'RESTRICT_USER' as AdminAction,
    targetType: 'User',
    targetId: userId,
    performedBy: adminId,
    performedByRole: adminRole,
    previousValue: { restrictedAt: null },
    newValue: { restrictedAt: new Date(), restrictedUntil, restrictionReason: reason },
    reason,
    ipAddress,
  });

  // Notify user
  await createNotification({
    userId,
    type: 'ACCOUNT_SUSPENDED',
    title: 'Account Restricted',
    message: `Your account has been restricted for ${days} days. You can still view your account but cannot make new transactions. Reason: ${reason}`,
    metadata: { reason, restrictedUntil },
  });

  return {
    success: true,
    message: `User restricted for ${days} days`,
    restrictedUntil,
    pendingBookingsCount,
    warning: pendingBookingsCount > 0
      ? `User has ${pendingBookingsCount} pending booking(s) that will continue`
      : null,
  };
};

/**
 * Remove restriction from user (admin)
 */
export const removeRestriction = async (
  userId: string,
  adminId: string,
  adminRole: string,
  ipAddress?: string
) => {
  const user = await prisma.user.findUnique({
    where: { id: userId },
  });

  if (!user) {
    throw new GraphQLError('User not found', {
      extensions: { code: 'NOT_FOUND' },
    });
  }

  if (!user.restrictedAt) {
    throw new GraphQLError('User is not restricted', {
      extensions: { code: 'NOT_RESTRICTED' },
    });
  }

  // Update user
  await prisma.user.update({
    where: { id: userId },
    data: {
      restrictedAt: null,
      restrictedUntil: null,
      restrictionReason: null,
      restrictedBy: null,
    },
  });

  // Create audit log
  await createAuditLog({
    action: 'UNRESTRICT_USER' as AdminAction,
    targetType: 'User',
    targetId: userId,
    performedBy: adminId,
    performedByRole: adminRole,
    previousValue: { restrictedAt: user.restrictedAt, restrictionReason: user.restrictionReason },
    newValue: { restrictedAt: null },
    ipAddress,
  });

  // Notify user
  await createNotification({
    userId,
    type: 'ACCOUNT_ACTIVATED',
    title: 'Restriction Removed',
    message: 'Your account restriction has been removed. You can now make transactions.',
  });

  return {
    success: true,
    message: 'User restriction removed successfully',
  };
};

/**
 * Force logout all sessions (admin)
 */
export const forceLogout = async (
  userId: string,
  adminId: string,
  adminRole: string,
  ipAddress?: string
) => {
  const user = await prisma.user.findUnique({
    where: { id: userId },
  });

  if (!user) {
    throw new GraphQLError('User not found', {
      extensions: { code: 'NOT_FOUND' },
    });
  }

  // Invalidate all tokens
  await prisma.user.update({
    where: { id: userId },
    data: {
      tokenInvalidatedAt: new Date(),
    },
  });

  // Create audit log
  await createAuditLog({
    action: 'SUSPEND_USER' as AdminAction, // Using SUSPEND for force logout
    targetType: 'User',
    targetId: userId,
    performedBy: adminId,
    performedByRole: adminRole,
    reason: 'Forced session invalidation',
    ipAddress,
  });

  return {
    success: true,
    message: 'User sessions invalidated. User will be logged out.',
  };
};

// ==========================================
// Statistics Functions
// ==========================================

/**
 * Get user statistics (admin dashboard)
 */
export const getUserStats = async () => {
  const [
    totalUsers,
    activeUsers,
    bannedUsers,
    restrictedUsers,
    totalProviders,
    verifiedProviders,
    pendingProviders,
  ] = await Promise.all([
    prisma.user.count({ where: { role: UserRole.SERVICE_USER } }),
    prisma.user.count({ where: { role: UserRole.SERVICE_USER, status: 'ACTIVE' } }),
    prisma.user.count({ where: { bannedAt: { not: null } } }),
    prisma.user.count({ where: { restrictedAt: { not: null } } }),
    prisma.serviceProvider.count(),
    prisma.serviceProvider.count({ where: { verificationStatus: 'VERIFIED' } }),
    prisma.serviceProvider.count({ where: { verificationStatus: 'PENDING' } }),
  ]);

  // New users this month
  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);

  const newUsersThisMonth = await prisma.user.count({
    where: {
      createdAt: { gte: startOfMonth },
      role: UserRole.SERVICE_USER,
    },
  });

  const newProvidersThisMonth = await prisma.serviceProvider.count({
    where: {
      createdAt: { gte: startOfMonth },
    },
  });

  return {
    users: {
      total: totalUsers,
      active: activeUsers,
      banned: bannedUsers,
      restricted: restrictedUsers,
      newThisMonth: newUsersThisMonth,
    },
    providers: {
      total: totalProviders,
      verified: verifiedProviders,
      pending: pendingProviders,
      newThisMonth: newProvidersThisMonth,
    },
  };
};
