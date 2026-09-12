/**
 * User Service
 * Handles user management business logic
 */

import { randomBytes } from 'crypto';
import { GraphQLError } from 'graphql';
import { AdminAction, Prisma } from '@prisma/client';
import prisma from '@/lib/prisma';
import { config } from '@/config';
import {
  ErrorCode,
  ErrorMessage,
  AccountStatus,
  BookingStatus,
  DisputeStatus,
  PaymentStatus,
  ServiceStatus,
} from '@/constants';
import { hashPassword } from '@/lib/auth';
import { withTransaction } from '@/lib/transaction';
import { generateOtp, hashOtp, verifyOtp, getOtpExpiry, isOtpExpired } from '@/lib/otp';
import { sendProfileUpdatedEmail, sendEmailChangeOtpEmail } from '@/lib/email';
import { validateName, validatePhone, validateUrl, validateEmail } from '@/utils/security';
import { assertAcceptableText } from '@/lib/content-filter';
import { createAuditLog } from './audit.service';
import { confirmAccountPassword } from './auth.service';
import { endAllSessions } from './token.service';
import { unregisterPushToken } from './push.service';
import { deleteUserFiles, getUserFileUrls } from './upload.service';

/**
 * User fields returned by operations that respond with a User
 */
const USER_SELECT = {
  id: true,
  email: true,
  firstName: true,
  lastName: true,
  phone: true,
  profilePhoto: true,
  role: true,
  activeRole: true,
  status: true,
  isEmailVerified: true,
  pushEnabled: true,
  lastLoginAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

/**
 * Get user by ID
 */
export const getUserById = async (id: string) => {
  const user = await prisma.user.findUnique({
    where: { id },
    select: USER_SELECT,
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
      select: USER_SELECT,
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
    phone?: string | null;
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
  let sanitizedPhone: string | null | undefined;
  let sanitizedProfilePhoto: string | undefined;

  if (data.firstName) {
    sanitizedFirstName = validateName(data.firstName, 'First name');
    assertAcceptableText(sanitizedFirstName, 'First name');
    if (sanitizedFirstName !== current.firstName) changedFields.push('First Name');
  }
  if (data.lastName) {
    sanitizedLastName = validateName(data.lastName, 'Last name');
    assertAcceptableText(sanitizedLastName, 'Last name');
    if (sanitizedLastName !== current.lastName) changedFields.push('Last Name');
  }
  if (data.phone !== undefined) {
    // Stored as +234 followed by 10 digits, like register; empty removes it
    sanitizedPhone = data.phone?.trim() ? validatePhone(data.phone) : null;
    if (sanitizedPhone !== (current.phone || null)) changedFields.push('Phone Number');
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
    select: USER_SELECT,
  });

  // Non-blocking profile update notification
  sendProfileUpdatedEmail(current.email, current.firstName, changedFields).catch(() => {});

  return user;
};

const emailInUseError = (message: string) =>
  new GraphQLError(message, {
    extensions: { code: 'USER_ALREADY_EXISTS' },
  });

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
    throw emailInUseError('This email address is already in use');
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

  const minutes = config.otp.expiryMinutes;

  return {
    success: true,
    message: `A confirmation code has been sent to ${normalizedEmail}. It expires in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
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

  // The address isn't held while the code is pending, so another account may
  // have taken it since. The pending change is then cancelled.
  const takenMessage =
    'This email address is now used by another account. Please request a change to a different address.';
  const cancelPendingChange = () =>
    prisma.user.update({
      where: { id: userId },
      data: { pendingEmail: null, emailVerifyToken: null, emailVerifyExpiry: null },
    });

  const taken = await prisma.user.findUnique({
    where: { email: newEmail },
    select: { id: true },
  });

  if (taken && taken.id !== userId) {
    await cancelPendingChange();
    throw emailInUseError(takenMessage);
  }

  let updatedUser;
  try {
    updatedUser = await prisma.user.update({
      where: { id: userId },
      data: {
        email: newEmail,
        pendingEmail: null,
        emailVerifyToken: null,
        emailVerifyExpiry: null,
      },
      select: USER_SELECT,
    });
  } catch (error) {
    // Taken between the check and the update
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      await cancelPendingChange();
      throw emailInUseError(takenMessage);
    }
    throw error;
  }

  // Notify old email of the change
  sendProfileUpdatedEmail(oldEmail, user.firstName, ['Email Address']).catch(() => {});

  return updatedUser;
};

// ==================
// Account Deletion
// ==================

const ACTIVE_BOOKING_STATUSES = [
  BookingStatus.PENDING,
  BookingStatus.ACCEPTED,
  BookingStatus.IN_PROGRESS,
];
const OPEN_DISPUTE_STATUSES = [DisputeStatus.OPEN, DisputeStatus.UNDER_REVIEW];
const PAYOUT_IN_PROGRESS_STATUSES: ('PENDING' | 'PROCESSING')[] = ['PENDING', 'PROCESSING'];

/**
 * A deleted account's email: unique, and unable to receive mail (.invalid is a
 * reserved domain), so the real address is free to register again
 */
export const deletedAccountEmail = (userId: string): string =>
  `deleted-${userId}@deleted.easykonnet.invalid`;

const formatNaira = (kobo: number): string =>
  `₦${(kobo / 100).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

type DeletionRequester = 'self' | 'admin';

const deletionBlocked = (
  requester: DeletionRequester,
  code: string,
  messages: { self: string; admin: string }
) => new GraphQLError(messages[requester], { extensions: { code } });

/**
 * Refuse to delete an account that still has business in progress, which would
 * otherwise be left with no one to act on it: active bookings, open disputes,
 * withdrawals or payouts being processed, earnings on hold, or wallet money
 */
const assertAccountCanBeDeleted = async (userId: string, requester: DeletionRequester) => {
  const provider = await prisma.serviceProvider.findUnique({
    where: { userId },
    select: { id: true },
  });

  const bookingParty: Prisma.BookingWhereInput[] = provider
    ? [{ userId }, { providerId: provider.id }]
    : [{ userId }];

  const [activeBookings, openDisputes, wallet, withdrawalsInProgress, payoutsInProgress, earningsOnHold] =
    await Promise.all([
      prisma.booking.count({
        where: { status: { in: ACTIVE_BOOKING_STATUSES }, OR: bookingParty },
      }),
      prisma.dispute.count({
        where: {
          status: { in: OPEN_DISPUTE_STATUSES },
          OR: [{ raisedById: userId }, { booking: { is: { OR: bookingParty } } }],
        },
      }),
      prisma.wallet.findUnique({
        where: { userId },
        select: { balance: true, pendingBalance: true },
      }),
      provider
        ? prisma.withdrawal.count({
            where: { providerId: provider.id, status: { in: PAYOUT_IN_PROGRESS_STATUSES } },
          })
        : 0,
      provider
        ? prisma.scheduledPayout.count({
            where: { providerId: provider.id, status: { in: PAYOUT_IN_PROGRESS_STATUSES } },
          })
        : 0,
      // Completed and paid, but not yet released to the provider's wallet
      provider
        ? prisma.booking.count({
            where: {
              providerId: provider.id,
              status: BookingStatus.COMPLETED,
              OR: [{ paymentReleasedAt: null }, { paymentReleasedAt: { isSet: false } }],
              payment: { is: { status: PaymentStatus.COMPLETED } },
            },
          })
        : 0,
    ]);

  if (activeBookings > 0) {
    throw deletionBlocked(requester, 'HAS_ACTIVE_BOOKINGS', {
      self: 'You have bookings that are pending, accepted or in progress. Complete or cancel them before deleting your account.',
      admin: 'This user has bookings that are pending, accepted or in progress. They must be completed or cancelled first.',
    });
  }

  if (openDisputes > 0) {
    throw deletionBlocked(requester, 'HAS_OPEN_DISPUTES', {
      self: 'You have a dispute that is still open. It must be resolved before you can delete your account.',
      admin: 'This user has a dispute that is still open. Resolve it first.',
    });
  }

  if (withdrawalsInProgress + payoutsInProgress > 0) {
    throw deletionBlocked(requester, 'HAS_PENDING_WITHDRAWALS', {
      self: 'You have a withdrawal or payout that is still being processed. Wait for it to finish before deleting your account.',
      admin: 'This user has a withdrawal or payout that is still being processed.',
    });
  }

  if (earningsOnHold > 0 || (wallet?.pendingBalance ?? 0) > 0) {
    throw deletionBlocked(requester, 'HAS_PENDING_EARNINGS', {
      self: 'Some of your earnings are still on hold. Wait until they reach your wallet and withdraw them before deleting your account.',
      admin: 'This user has earnings that are still on hold.',
    });
  }

  if ((wallet?.balance ?? 0) > 0) {
    const amount = formatNaira(wallet?.balance ?? 0);
    throw deletionBlocked(requester, 'WALLET_BALANCE_NOT_EMPTY', {
      self: `Your wallet still has ${amount}. Withdraw or use it before deleting your account, or contact support for help.`,
      admin: `This user's wallet still has ${amount}.`,
    });
  }
};

/**
 * Delete an account by removing its personal data and making it unusable. The
 * records other people and the books rely on stay (bookings, reviews, payments,
 * wallet history, messages), now showing "Deleted User". A provider's profile is
 * scrubbed and its services hidden, and every session ends.
 */
const anonymiseAccount = async (userId: string) => {
  const deletedAt = new Date();
  const unusablePassword = await hashPassword(randomBytes(32).toString('hex'));

  // Detach the device from OneSignal while its ID is still on the account
  try {
    await unregisterPushToken(userId);
  } catch (error) {
    console.error('Failed to remove push registration for a deleted account:', error);
  }

  // Note the account's files before the transaction clears their URLs
  const fileUrls = await getUserFileUrls(userId);

  await withTransaction(async (tx) => {
    const provider = await tx.serviceProvider.findUnique({
      where: { userId },
      select: { id: true },
    });

    if (provider) {
      // The image files are deleted below, so their URLs go too
      await tx.service.updateMany({
        where: { providerId: provider.id },
        data: { status: ServiceStatus.INACTIVE, images: [] },
      });
      await tx.providerBankAccount.deleteMany({ where: { providerId: provider.id } });
      await tx.payoutSchedule.updateMany({
        where: { providerId: provider.id },
        data: { isActive: false, bankAccountId: null },
      });
      await tx.serviceProvider.update({
        where: { id: provider.id },
        data: {
          businessName: 'Deleted provider',
          businessDescription: null,
          address: '',
          latitude: null,
          longitude: null,
          images: [],
          documents: [],
        },
      });
    }

    await tx.favourite.deleteMany({ where: { userId } });
    await tx.providerLike.deleteMany({ where: { userId } });
    await tx.userSettings.deleteMany({ where: { userId } });
    await tx.notification.deleteMany({ where: { userId } });

    await tx.user.update({
      where: { id: userId },
      data: {
        email: deletedAccountEmail(userId),
        firstName: 'Deleted',
        lastName: 'User',
        phone: null,
        profilePhoto: null,
        password: unusablePassword,
        status: AccountStatus.DEACTIVATED,
        activeRole: null,
        pendingEmail: null,
        emailVerifyToken: null,
        emailVerifyExpiry: null,
        passwordResetToken: null,
        passwordResetExpiry: null,
        oneSignalPlayerId: null,
        oneSignalPlayerIds: [],
        pushEnabled: false,
        failedLoginAttempts: 0,
        lockoutUntil: null,
        lastLoginIp: null,
        deactivatedAt: deletedAt,
        deactivationReason: null,
        deletedAt,
        tokenInvalidatedAt: deletedAt,
      },
    });
  });

  // Delete the account's files from Cloudinary (best effort, never throws)
  await deleteUserFiles(userId, fileUrls);

  // Revoke stored refresh tokens and reject earlier access tokens
  await endAllSessions(userId);
};

/**
 * Delete user (Admin only). Admin accounts can only be removed through
 * deleteAdmin, which protects Super Admins.
 */
export const deleteUser = async (
  id: string,
  adminId: string,
  adminRole: string,
  ipAddress?: string
) => {
  if (id === adminId) {
    throw new GraphQLError('You cannot delete your own account', {
      extensions: { code: 'FORBIDDEN' },
    });
  }

  const user = await prisma.user.findUnique({
    where: { id },
  });

  // Same code as the other admin user operations
  if (!user || user.deletedAt) {
    throw new GraphQLError('User not found', {
      extensions: { code: ErrorCode.NOT_FOUND },
    });
  }

  if (user.role === 'ADMIN' || user.role === 'SUPER_ADMIN') {
    throw new GraphQLError('Admin accounts can only be removed with deleteAdmin', {
      extensions: { code: 'FORBIDDEN' },
    });
  }

  await assertAccountCanBeDeleted(id, 'admin');
  await anonymiseAccount(id);

  await createAuditLog({
    action: 'DELETE_USER' as AdminAction,
    targetType: 'User',
    targetId: id,
    performedBy: adminId,
    performedByRole: adminRole,
    previousValue: { email: user.email, role: user.role, status: user.status },
    ipAddress,
  });

  return { success: true, message: 'User deleted successfully' };
};

/**
 * Delete own account. When the app sends the password it must be right, and
 * wrong passwords count toward the sign-in lockout.
 */
export const deleteOwnAccount = async (userId: string, password?: string | null) => {
  const user = await prisma.user.findUnique({
    where: { id: userId },
  });

  if (!user || user.deletedAt) {
    throw new GraphQLError(ErrorMessage[ErrorCode.USER_NOT_FOUND], {
      extensions: { code: ErrorCode.USER_NOT_FOUND },
    });
  }

  if (password !== undefined && password !== null) {
    await confirmAccountPassword(user, password, {
      code: 'INVALID_PASSWORD',
      message: 'Password is incorrect',
    });
  }

  await assertAccountCanBeDeleted(userId, 'self');
  await anonymiseAccount(userId);

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
  pagination: { page?: number; limit?: number } = {}
) => {
  const { page = 1, limit = 10 } = pagination;
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
                // Removed reviews don't count; older reviews have no deletedAt field
                reviews: { where: { OR: [{ deletedAt: null }, { deletedAt: { isSet: false } }] } },
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
    total,
    page,
    limit,
    totalPages,
    hasNextPage: page < totalPages,
    hasPreviousPage: page > 1,
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
