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
import {
  UserRole,
  AccountStatus,
  AdminAction,
  BookingStatus,
  type Prisma,
  type VerificationStatus,
} from '@prisma/client';
import { createAuditLog } from './audit.service';
import { createNotification } from './notification.service';
import { sendPushToUser } from './push.service';
import { getEscrowedEarningsKobo } from './wallet.service';
import { isBanActive, isRestrictionActive } from '@/utils/security';
import { normalizeNigerianPhone } from '@/utils/validation';

/**
 * Write an in-app notification AND fire a push so the user is alerted to
 * moderation events immediately. Failures are swallowed — the moderation
 * action has already happened in the DB and we don't want to roll back
 * a ban/restriction because a downstream service is flaky.
 */
export const notifyAndPush = async (
  userId: string,
  type: string,
  title: string,
  message: string,
  metadata?: Record<string, any>
) => {
  try {
    await createNotification({ userId, type, title, message, metadata });
  } catch (err) {
    console.error('Failed to write moderation notification', err);
  }
  try {
    await sendPushToUser(userId, {
      title,
      message,
      data: { type, ...(metadata ?? {}) },
    });
  } catch (err) {
    console.error('Failed to send moderation push', err);
  }
};

// ==========================================
// Types
// ==========================================

// accountStatus / searchTerm / startDate / endDate are the names the GraphQL filters use
interface UserFilters {
  role?: UserRole | null;
  status?: AccountStatus | null;
  accountStatus?: AccountStatus | null;
  search?: string | null;
  searchTerm?: string | null;
  isBanned?: boolean | null;
  isRestricted?: boolean | null;
  startDate?: string | null;
  endDate?: string | null;
  // Provider profile filters
  verificationStatus?: VerificationStatus | null;
  city?: string | null;
  state?: string | null;
}

// managedProviders takes the same filters as managedUsers
type ProviderFilters = UserFilters;

interface PaginationInput {
  page: number;
  limit: number;
}

interface BanUserInput {
  userId: string;
  reason: string; // Saved on the account and in the audit log
  days?: number | null; // null = permanent
  // Shown to the user instead of `reason`, when the reason is written for admins
  userFacingReason?: string | null;
}

interface RestrictUserInput {
  userId: string;
  reason: string; // Saved on the account and in the audit log
  days: number;
  // Shown to the user instead of `reason`, when the reason is written for admins
  userFacingReason?: string | null;
}

// ==========================================
// Constants
// ==========================================

const MANAGEABLE_ROLES: string[] = [UserRole.SERVICE_USER, UserRole.SERVICE_PROVIDER];

const DAY_MS = 24 * 60 * 60 * 1000;

// Longest ban or restriction with an end date
const MAX_MODERATION_DAYS = 365;

// Bookings that are still going ahead
const OPEN_BOOKING_STATUSES: BookingStatus[] = [
  BookingStatus.PENDING,
  BookingStatus.ACCEPTED,
  BookingStatus.IN_PROGRESS,
];

// Reviews an admin removed don't appear in any list, count or rating. On MongoDB
// a field that was never written doesn't match `null`, so both are checked.
const NOT_REMOVED_REVIEW: Prisma.ReviewWhereInput = {
  OR: [{ deletedAt: null }, { deletedAt: { isSet: false } }],
};

// ==========================================
// Helper Functions
// ==========================================

type AccountAction = 'BAN' | 'UNBAN' | 'RESTRICT' | 'UNRESTRICT';

/**
 * Check if admin can act on target user. An ADMIN can act only on customers and
 * providers. A SUPER_ADMIN can act on anyone, except that Super Admins can't be
 * banned or restricted (lifting an older ban or restriction is allowed).
 */
const canAdminActOn = (
  adminRole: string,
  targetRole: string,
  action: AccountAction
): boolean => {
  if (adminRole === UserRole.SUPER_ADMIN) {
    return targetRole !== UserRole.SUPER_ADMIN || action === 'UNBAN' || action === 'UNRESTRICT';
  }

  if (adminRole === UserRole.ADMIN) {
    return MANAGEABLE_ROLES.includes(targetRole);
  }

  return false;
};

const forbidden = (message: string) =>
  new GraphQLError(message, { extensions: { code: 'FORBIDDEN' } });

const isValidDuration = (days: unknown): days is number =>
  typeof days === 'number' && Number.isInteger(days) && days >= 1 && days <= MAX_MODERATION_DAYS;

const invalidDuration = () =>
  new GraphQLError(`Duration must be a whole number of days between 1 and ${MAX_MODERATION_DAYS}`, {
    extensions: { code: 'INVALID_INPUT' },
  });

const dayCount = (days: number) => `${days} day${days === 1 ? '' : 's'}`;

// On MongoDB a field that was never written doesn't match `null`, so "no value"
// checks for both and "has a value" rules out both.

/** Accounts with a ban in force: banned, with no end date or one still to come */
const banInForce = (now: Date): Prisma.UserWhereInput => ({
  AND: [
    { bannedAt: { isSet: true } },
    { bannedAt: { not: null } },
    { OR: [{ bannedUntil: null }, { bannedUntil: { isSet: false } }, { bannedUntil: { gt: now } }] },
  ],
});

/** Accounts never banned, unbanned, or whose ban has ended */
const noBanInForce = (now: Date): Prisma.UserWhereInput => ({
  OR: [
    { bannedAt: null },
    { bannedAt: { isSet: false } },
    { AND: [{ bannedUntil: { isSet: true } }, { bannedUntil: { not: null } }, { bannedUntil: { lte: now } }] },
  ],
});

/** Accounts with a restriction in force */
const restrictionInForce = (now: Date): Prisma.UserWhereInput => ({
  AND: [
    { restrictedAt: { isSet: true } },
    { restrictedAt: { not: null } },
    { OR: [{ restrictedUntil: null }, { restrictedUntil: { isSet: false } }, { restrictedUntil: { gt: now } }] },
  ],
});

/** Accounts never restricted, unrestricted, or whose restriction has ended */
const noRestrictionInForce = (now: Date): Prisma.UserWhereInput => ({
  OR: [
    { restrictedAt: null },
    { restrictedAt: { isSet: false } },
    {
      AND: [
        { restrictedUntil: { isSet: true } },
        { restrictedUntil: { not: null } },
        { restrictedUntil: { lte: now } },
      ],
    },
  ],
});

/**
 * Account conditions for the isBanned / isRestricted filters, on the ban or
 * restriction being in force now
 */
const moderationConditions = (filters: UserFilters, now: Date): Prisma.UserWhereInput[] => {
  const conditions: Prisma.UserWhereInput[] = [];

  if (filters.isBanned === true) conditions.push(banInForce(now));
  if (filters.isBanned === false) conditions.push(noBanInForce(now));
  if (filters.isRestricted === true) conditions.push(restrictionInForce(now));
  if (filters.isRestricted === false) conditions.push(noRestrictionInForce(now));

  return conditions;
};

/**
 * Provider profile conditions for the verificationStatus / city / state filters,
 * or null when none is set
 */
const providerProfileConditions = (filters: UserFilters): Prisma.ServiceProviderWhereInput | null => {
  const where: Prisma.ServiceProviderWhereInput = {};

  if (filters.verificationStatus) {
    where.verificationStatus = filters.verificationStatus;
  }

  if (filters.city) {
    where.city = { contains: filters.city, mode: 'insensitive' };
  }

  if (filters.state) {
    where.state = { contains: filters.state, mode: 'insensitive' };
  }

  return Object.keys(where).length > 0 ? where : null;
};

/**
 * Creation date range for the startDate / endDate filters, or null when neither is set
 */
const createdBetween = (filters: UserFilters): Prisma.DateTimeFilter | null =>
  filters.startDate || filters.endDate
    ? {
        ...(filters.startDate && { gte: new Date(filters.startDate) }),
        ...(filters.endDate && { lte: new Date(filters.endDate) }),
      }
    : null;

/**
 * Phone conditions for a search term: the text as typed, and for a full Nigerian
 * mobile number every form it may be saved in (+234, 234 or 0 before the last
 * 10 digits; older accounts weren't normalised)
 */
const phoneSearchConditions = (search: string): Prisma.UserWhereInput[] => {
  const conditions: Prisma.UserWhereInput[] = [{ phone: { contains: search } }];
  const normalized = normalizeNigerianPhone(search);

  if (normalized) {
    const digits = normalized.slice('+234'.length);
    conditions.push({ phone: { in: [normalized, `0${digits}`, `234${digits}`] } });
  }

  return conditions;
};

/**
 * Earnings released to each provider's wallet, in naira, by user ID. Escrow
 * credits the wallet once for each released booking (source SERVICE_EARNING),
 * and a released payment can't be refunded, so the ledger total is what the
 * provider has been paid for their work. Money still held in escrow isn't included.
 */
const getReleasedEarnings = async (userIds: string[]): Promise<Map<string, number>> => {
  if (userIds.length === 0) return new Map();

  const wallets = await prisma.wallet.findMany({
    where: { userId: { in: userIds } },
    select: { id: true, userId: true },
  });

  if (wallets.length === 0) return new Map();

  const totals = await prisma.walletTransaction.groupBy({
    by: ['walletId'],
    where: {
      walletId: { in: wallets.map((wallet) => wallet.id) },
      type: 'CREDIT',
      source: 'SERVICE_EARNING',
    },
    _sum: { amount: true },
  });

  const koboByWallet = new Map(totals.map((total) => [total.walletId, total._sum.amount ?? 0]));

  return new Map(wallets.map((wallet) => [wallet.userId, (koboByWallet.get(wallet.id) ?? 0) / 100]));
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
  accountStatus: user.status,
  isEmailVerified: user.isEmailVerified,
  bannedAt: user.bannedAt?.toISOString() || null,
  bannedUntil: user.bannedUntil?.toISOString() || null,
  banReason: user.banReason,
  bannedReason: user.banReason,
  isBanned: isBanActive(user),
  restrictedAt: user.restrictedAt?.toISOString() || null,
  restrictedUntil: user.restrictedUntil?.toISOString() || null,
  restrictionReason: user.restrictionReason,
  isRestricted: isRestrictionActive(user),
  provider: user.provider
    ? {
        id: user.provider.id,
        businessName: user.provider.businessName,
        verificationStatus: user.provider.verificationStatus,
      }
    : null,
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

  const where: Prisma.UserWhereInput = {};

  if (filters.role) {
    where.role = filters.role;
  }

  const status = filters.accountStatus ?? filters.status;
  if (status) {
    where.status = status;
  }

  const createdAt = createdBetween(filters);
  if (createdAt) {
    where.createdAt = createdAt;
  }

  const search = filters.searchTerm ?? filters.search;
  if (search) {
    where.OR = [
      { email: { contains: search, mode: 'insensitive' } },
      { firstName: { contains: search, mode: 'insensitive' } },
      { lastName: { contains: search, mode: 'insensitive' } },
      ...phoneSearchConditions(search),
    ];
  }

  const profile = providerProfileConditions(filters);
  if (profile) {
    where.provider = { is: profile };
  }

  const conditions = moderationConditions(filters, new Date());
  if (conditions.length > 0) {
    where.AND = conditions;
  }

  const [users, total] = await Promise.all([
    prisma.user.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
      include: {
        provider: true,
        _count: {
          select: {
            bookingsAsUser: true,
            reviews: { where: NOT_REMOVED_REVIEW },
          },
        },
      },
    }),
    prisma.user.count({ where }),
  ]);

  const items = users.map((u) => ({
    ...formatUserForManagement(u),
    bookingsCount: u._count?.bookingsAsUser || 0,
    reviewsCount: u._count?.reviews || 0,
  }));

  return {
    items,
    total,
    page,
    totalPages: Math.ceil(total / limit),
    hasNextPage: page * limit < total,
    users: items,
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
        where: NOT_REMOVED_REVIEW,
        take: 10,
        orderBy: { createdAt: 'desc' },
      },
      wallet: true,
      _count: {
        select: {
          bookingsAsUser: true,
          reviews: { where: NOT_REMOVED_REVIEW },
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

  const [totalSpent, escrowedKobo] = await Promise.all([
    // Calculate total spent
    prisma.payment.aggregate({
      where: {
        booking: { userId },
        status: 'COMPLETED',
      },
      _sum: { amount: true },
    }),
    // A wallet's pending balance is the provider's share of paid bookings still in escrow
    user.wallet && user.provider ? getEscrowedEarningsKobo(userId) : 0,
  ]);

  return {
    ...formatUserForManagement(user),
    provider: user.provider ? {
      id: user.provider.id,
      businessName: user.provider.businessName,
      verificationStatus: user.provider.verificationStatus,
    } : null,
    wallet: user.wallet ? {
      id: user.wallet.id,
      balance: user.wallet.balance / 100, // Convert kobo to naira
      pendingBalance: escrowedKobo / 100,
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

  const where: Prisma.ServiceProviderWhereInput = { ...providerProfileConditions(filters) };

  // Filters on the provider's own account
  const accountConditions = moderationConditions(filters, new Date());

  if (filters.role) {
    accountConditions.push({ role: filters.role });
  }

  const status = filters.accountStatus ?? filters.status;
  if (status) {
    accountConditions.push({ status });
  }

  if (accountConditions.length > 0) {
    where.user = { is: { AND: accountConditions } };
  }

  // The dates apply to the provider profile, which is also what the list is sorted by
  const createdAt = createdBetween(filters);
  if (createdAt) {
    where.createdAt = createdAt;
  }

  const search = filters.searchTerm ?? filters.search;
  if (search) {
    where.OR = [
      { businessName: { contains: search, mode: 'insensitive' } },
      { user: { email: { contains: search, mode: 'insensitive' } } },
      { user: { firstName: { contains: search, mode: 'insensitive' } } },
      { user: { lastName: { contains: search, mode: 'insensitive' } } },
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
            reviews: { where: NOT_REMOVED_REVIEW },
          },
        },
      },
    }),
    prisma.serviceProvider.count({ where }),
  ]);

  // Average ratings, and earnings released to each provider's wallet
  const [providersWithRatings, earnings] = await Promise.all([
    Promise.all(
      providers.map(async (p) => {
        const avgRating = await prisma.review.aggregate({
          where: { providerId: p.id, ...NOT_REMOVED_REVIEW },
          _avg: { rating: true },
        });
        return {
          ...p,
          averageRating: avgRating._avg.rating,
        };
      })
    ),
    getReleasedEarnings(providers.map((p) => p.userId)),
  ]);

  // managedProviders returns ManagedUser items with the provider attached
  const items = providersWithRatings.map((p) => ({
    ...formatUserForManagement(p.user),
    provider: {
      id: p.id,
      businessName: p.businessName,
      verificationStatus: p.verificationStatus,
      averageRating: p.averageRating,
      totalReviews: p._count.reviews,
      totalServices: p._count.services,
      totalBookings: p._count.bookings,
      totalEarnings: earnings.get(p.userId) ?? 0,
    },
  }));

  return {
    items,
    total,
    page,
    totalPages: Math.ceil(total / limit),
    hasNextPage: page * limit < total,
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
        where: NOT_REMOVED_REVIEW,
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
          reviews: { where: NOT_REMOVED_REVIEW },
        },
      },
    },
  });

  if (!provider) {
    throw new GraphQLError('Provider not found', {
      extensions: { code: 'NOT_FOUND' },
    });
  }

  const [avgRating, withdrawals, releasedEarnings, escrowedKobo] = await Promise.all([
    // Calculate average rating
    prisma.review.aggregate({
      where: { providerId, ...NOT_REMOVED_REVIEW },
      _avg: { rating: true },
    }),
    // Get withdrawal stats
    prisma.withdrawal.aggregate({
      where: {
        providerId,
        status: 'COMPLETED',
      },
      _sum: { amount: true },
      _count: true,
    }),
    // Earnings released to the wallet, the same figure as managedProviders shows
    getReleasedEarnings([provider.userId]),
    // The provider's share of paid bookings still held in escrow
    getEscrowedEarningsKobo(provider.userId),
  ]);

  return {
    ...formatProviderForManagement(provider),
    user: formatUserForManagement(provider.user),
    wallet: provider.user.wallet ? {
      id: provider.user.wallet.id,
      balance: provider.user.wallet.balance / 100,
      pendingBalance: escrowedKobo / 100,
      isLocked: provider.user.wallet.isLocked,
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
      totalEarnings: releasedEarnings.get(provider.userId) ?? 0,
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
  const { userId, reason, days, userFacingReason } = input;

  if (days != null && !isValidDuration(days)) {
    throw invalidDuration();
  }

  // Self-check
  if (userId === adminId) {
    throw new GraphQLError('You cannot ban yourself', {
      extensions: { code: 'SELF_ACTION_FORBIDDEN' },
    });
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
  });

  // A deleted account has nothing left to ban
  if (!user || user.deletedAt) {
    throw new GraphQLError('User not found', {
      extensions: { code: 'NOT_FOUND' },
    });
  }

  // Role hierarchy check
  if (!canAdminActOn(adminRole, user.role, 'BAN')) {
    throw forbidden('You do not have permission to ban this user');
  }

  const now = new Date();
  const bannedUntil = days ? new Date(now.getTime() + days * DAY_MS) : null; // null = permanent

  const updatedUser = await prisma.user.update({
    where: { id: userId },
    data: {
      bannedAt: now,
      bannedUntil,
      banReason: reason,
      bannedBy: adminId,
      tokenInvalidatedAt: now, // Ends every session the user has
    },
    include: { provider: true },
  });

  await createAuditLog({
    action: AdminAction.BAN_USER,
    targetType: 'User',
    targetId: userId,
    performedBy: adminId,
    performedByRole: adminRole,
    previousValue: { bannedAt: user.bannedAt, bannedUntil: user.bannedUntil, banReason: user.banReason },
    newValue: { bannedAt: now, bannedUntil, banReason: reason },
    reason,
    ipAddress,
  });

  const shownReason = userFacingReason?.trim() || reason;

  await notifyAndPush(
    userId,
    'ACCOUNT_SUSPENDED',
    'Account Banned',
    days
      ? `Your account has been banned for ${dayCount(days)}. Reason: ${shownReason}`
      : `Your account has been permanently banned. Reason: ${shownReason}`,
    { reason: shownReason, bannedUntil },
  );

  return {
    success: true,
    message: days
      ? `User banned for ${dayCount(days)}`
      : 'User permanently banned',
    bannedUntil,
    user: formatUserForManagement(updatedUser),
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

  // Same role rules as banning, so an ADMIN can't lift a ban on an admin account
  if (!canAdminActOn(adminRole, user.role, 'UNBAN')) {
    throw forbidden('You do not have permission to unban this user');
  }

  if (!user.bannedAt) {
    throw new GraphQLError('User is not banned', {
      extensions: { code: 'NOT_BANNED' },
    });
  }

  const updatedUser = await prisma.user.update({
    where: { id: userId },
    data: {
      bannedAt: null,
      bannedUntil: null,
      banReason: null,
      bannedBy: null,
    },
    include: { provider: true },
  });

  await createAuditLog({
    action: AdminAction.UNBAN_USER,
    targetType: 'User',
    targetId: userId,
    performedBy: adminId,
    performedByRole: adminRole,
    previousValue: { bannedAt: user.bannedAt, bannedUntil: user.bannedUntil, banReason: user.banReason },
    newValue: { bannedAt: null },
    ipAddress,
  });

  await notifyAndPush(
    userId,
    'ACCOUNT_ACTIVATED',
    'Account Unbanned',
    'Your account ban has been lifted. You can now access your account.',
  );

  return {
    success: true,
    message: 'User unbanned successfully',
    user: formatUserForManagement(updatedUser),
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
  const { userId, reason, days, userFacingReason } = input;

  if (!isValidDuration(days)) {
    throw invalidDuration();
  }

  // Self-check
  if (userId === adminId) {
    throw new GraphQLError('You cannot restrict yourself', {
      extensions: { code: 'SELF_ACTION_FORBIDDEN' },
    });
  }

  const openBookings = { where: { status: { in: OPEN_BOOKING_STATUSES } } };

  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      _count: { select: { bookingsAsUser: openBookings } },
      provider: { select: { _count: { select: { bookings: openBookings } } } },
    },
  });

  // A deleted account has nothing left to restrict
  if (!user || user.deletedAt) {
    throw new GraphQLError('User not found', {
      extensions: { code: 'NOT_FOUND' },
    });
  }

  // Role hierarchy check
  if (!canAdminActOn(adminRole, user.role, 'RESTRICT')) {
    throw forbidden('You do not have permission to restrict this user');
  }

  const now = new Date();
  const restrictedUntil = new Date(now.getTime() + days * DAY_MS);
  // Open bookings the account has as a customer and as a provider
  const pendingBookingsCount = user._count.bookingsAsUser + (user.provider?._count.bookings ?? 0);

  const updatedUser = await prisma.user.update({
    where: { id: userId },
    data: {
      restrictedAt: now,
      restrictedUntil,
      restrictionReason: reason,
      restrictedBy: adminId,
    },
    include: { provider: true },
  });

  await createAuditLog({
    action: AdminAction.RESTRICT_USER,
    targetType: 'User',
    targetId: userId,
    performedBy: adminId,
    performedByRole: adminRole,
    previousValue: {
      restrictedAt: user.restrictedAt,
      restrictedUntil: user.restrictedUntil,
      restrictionReason: user.restrictionReason,
    },
    newValue: { restrictedAt: now, restrictedUntil, restrictionReason: reason },
    reason,
    ipAddress,
  });

  const shownReason = userFacingReason?.trim() || reason;

  await notifyAndPush(
    userId,
    'ACCOUNT_SUSPENDED',
    'Account Restricted',
    `Your account has been restricted for ${dayCount(days)}. You can still view your account but cannot make new transactions. Reason: ${shownReason}`,
    { reason: shownReason, restrictedUntil },
  );

  return {
    success: true,
    message: `User restricted for ${dayCount(days)}`,
    restrictedUntil,
    pendingBookingsCount,
    warning: pendingBookingsCount > 0
      ? `User has ${pendingBookingsCount} pending booking(s) that will continue`
      : null,
    user: formatUserForManagement(updatedUser),
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

  // Same role rules as restricting, so an ADMIN can't lift a restriction on an admin account
  if (!canAdminActOn(adminRole, user.role, 'UNRESTRICT')) {
    throw forbidden('You do not have permission to remove this restriction');
  }

  if (!user.restrictedAt) {
    throw new GraphQLError('User is not restricted', {
      extensions: { code: 'NOT_RESTRICTED' },
    });
  }

  const updatedUser = await prisma.user.update({
    where: { id: userId },
    data: {
      restrictedAt: null,
      restrictedUntil: null,
      restrictionReason: null,
      restrictedBy: null,
    },
    include: { provider: true },
  });

  await createAuditLog({
    action: AdminAction.UNRESTRICT_USER,
    targetType: 'User',
    targetId: userId,
    performedBy: adminId,
    performedByRole: adminRole,
    previousValue: {
      restrictedAt: user.restrictedAt,
      restrictedUntil: user.restrictedUntil,
      restrictionReason: user.restrictionReason,
    },
    newValue: { restrictedAt: null },
    ipAddress,
  });

  await notifyAndPush(
    userId,
    'ACCOUNT_ACTIVATED',
    'Restriction Removed',
    'Your account restriction has been removed. You can now make transactions.',
  );

  return {
    success: true,
    message: 'User restriction removed successfully',
    user: formatUserForManagement(updatedUser),
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
