/**
 * Provider Service
 * Handles SERVICE_PROVIDER specific operations
 *
 * Features:
 * - Upgrade from SERVICE_USER to SERVICE_PROVIDER
 * - Provider profile management
 * - Provider verification workflow
 */

import { GraphQLError } from 'graphql';
import type { Prisma, User } from '@prisma/client';
import prisma from '@/lib/prisma';
import { UserRole, AccountStatus, VerificationStatus } from '@/constants';
import { generateToken, generateRefreshToken } from '@/lib/auth';
import { storeRefreshToken } from './token.service';
import {
  sendProviderApprovedEmail,
  sendProviderRejectedEmail,
  sendProviderSubmissionEmail
} from '@/lib/email';
import {
  sanitizeStrict,
  sanitizeBasic,
  validateBusinessName,
  validateText,
  validateUrl,
  MAX_LENGTHS,
} from '@/utils/security';
import { assertAcceptableText } from '@/lib/content-filter';
import { flagContent } from './report.service';
import { notifyVerificationApproved, notifyVerificationRejected } from './notification.service';
import { sendVerificationPush } from './push.service';
import {
  formatProviderProfile,
  loadProviderStats,
  notifySafely,
  recordModeration,
  validateModerationReason,
  type ModerationActor,
  type ProviderRecord,
  type ProviderStats,
} from './provider-profile.service';

// ==================
// Types
// ==================

interface BecomeProviderInput {
  businessName: string;
  businessDescription?: string;
  address: string;
  city: string;
  state: string;
  country: string;
  latitude?: number;
  longitude?: number;
}

interface UpdateProviderProfileInput {
  businessName?: string;
  businessDescription?: string;
  address?: string;
  city?: string;
  state?: string;
  country?: string;
  latitude?: number | null;
  longitude?: number | null;
  profilePhoto?: string | null;
}

// ==================
// Helper Functions
// ==================

/**
 * Format user with provider profile
 */
const formatUserWithProvider = (
  user: User,
  provider: ProviderRecord | null = null,
  stats?: ProviderStats
) => ({
  id: user.id,
  email: user.email,
  firstName: user.firstName,
  lastName: user.lastName,
  phone: user.phone,
  profilePhoto: user.profilePhoto || null,
  role: user.role,
  activeRole: user.activeRole || user.role, // Default to role if not set
  status: user.status,
  isEmailVerified: user.isEmailVerified,
  pushEnabled: user.pushEnabled ?? true,
  lastLoginAt: user.lastLoginAt ? user.lastLoginAt.toISOString() : null,
  providerProfile: provider ? formatProviderProfile(provider, stats) : null,
  createdAt: user.createdAt.toISOString(),
  updatedAt: user.updatedAt.toISOString(),
});

/**
 * Format a user with their provider profile's rating and like counts
 */
const formatWithStats = async (user: User, provider: ProviderRecord | null) => {
  if (!provider) return formatUserWithProvider(user);

  const stats = await loadProviderStats([provider.id]);
  return formatUserWithProvider(user, provider, stats.get(provider.id));
};

/**
 * A business address: required, plain text, at most 255 characters
 */
const validateAddress = (address: string | null | undefined): string => {
  const sanitized = sanitizeStrict(address ?? '');

  if (!sanitized) {
    throw new GraphQLError('Address is required', {
      extensions: { code: 'INVALID_INPUT' },
    });
  }

  return validateText(sanitized, 'Address', 1, MAX_LENGTHS.SHORT_TEXT);
};

const providerNotFound = () =>
  new GraphQLError('Provider not found', {
    extensions: { code: 'NOT_FOUND' },
  });

// ==================
// Provider Functions
// ==================

/**
 * Upgrade SERVICE_USER to SERVICE_PROVIDER
 */
export const becomeProvider = async (userId: string, input: BecomeProviderInput) => {
  const { businessName, businessDescription, address, city, state, country, latitude, longitude } = input;

  // Sanitize and validate inputs
  const sanitizedBusinessName = validateBusinessName(businessName, 'Business name');
  const sanitizedDescription = businessDescription
    ? validateText(sanitizeBasic(businessDescription), 'Business description', 10, 250)
    : undefined;
  assertAcceptableText(sanitizedBusinessName, 'Business name');
  assertAcceptableText(sanitizedDescription, 'Business description');
  const sanitizedAddress = validateAddress(address);
  const sanitizedCity = validateBusinessName(city, 'City');
  const sanitizedState = validateBusinessName(state, 'State');
  const sanitizedCountry = validateBusinessName(country, 'Country');

  // Find user
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { provider: true },
  });

  if (!user) {
    throw new GraphQLError('User not found', {
      extensions: { code: 'NOT_FOUND' },
    });
  }

  // Check if already a provider
  if (user.role === UserRole.SERVICE_PROVIDER) {
    throw new GraphQLError('You are already registered as a service provider', {
      extensions: { code: 'ALREADY_PROVIDER' },
    });
  }

  // Check if user role allows upgrade
  if (user.role !== UserRole.SERVICE_USER) {
    throw new GraphQLError('Only service users can become providers', {
      extensions: { code: 'INVALID_ROLE' },
    });
  }

  // Check account status
  if (user.status !== AccountStatus.ACTIVE) {
    throw new GraphQLError('Your account must be active to become a provider', {
      extensions: { code: 'ACCOUNT_NOT_ACTIVE' },
    });
  }

  // Check email verification
  if (!user.isEmailVerified) {
    throw new GraphQLError('Please verify your email before becoming a provider', {
      extensions: { code: 'EMAIL_NOT_VERIFIED' },
    });
  }

  // Create provider profile and update user role in a transaction
  const [updatedUser, provider] = await prisma.$transaction(async (tx) => {
    // Create provider profile
    const newProvider = await tx.serviceProvider.create({
      data: {
        userId: user.id,
        businessName: sanitizedBusinessName,
        businessDescription: sanitizedDescription,
        address: sanitizedAddress,
        city: sanitizedCity,
        state: sanitizedState,
        country: sanitizedCountry,
        latitude,
        longitude,
        verificationStatus: VerificationStatus.UNVERIFIED,
        documents: [],
      },
    });

    // Update user role
    const updated = await tx.user.update({
      where: { id: userId },
      data: {
        role: UserRole.SERVICE_PROVIDER,
      },
    });

    return [updated, newProvider] as const;
  });

  const tokenPayload = {
    userId: updatedUser.id,
    email: updatedUser.email,
    role: updatedUser.role,
  };

  const accessToken = generateToken(tokenPayload);
  const refreshToken = generateRefreshToken(tokenPayload);

  await storeRefreshToken(updatedUser.id, refreshToken, { deviceInfo: 'web' });

  return {
    user: await formatWithStats(updatedUser, provider),
    accessToken,
    refreshToken,
  };
};

/**
 * Update Provider Profile
 */
export const updateProviderProfile = async (userId: string, input: UpdateProviderProfileInput) => {
  // Find user with provider
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { provider: true },
  });

  if (!user) {
    throw new GraphQLError('User not found', {
      extensions: { code: 'NOT_FOUND' },
    });
  }

  // Check if user is a provider
  if (user.role !== UserRole.SERVICE_PROVIDER || !user.provider) {
    throw new GraphQLError('You must be a service provider to update provider profile', {
      extensions: { code: 'NOT_PROVIDER' },
    });
  }

  const currentProvider = user.provider;

  // Build update data with sanitization
  const updateData: Prisma.ServiceProviderUpdateInput = {};

  if (input.businessName !== undefined) {
    const businessName = validateBusinessName(input.businessName, 'Business name');
    assertAcceptableText(businessName, 'Business name');
    updateData.businessName = businessName;
  }
  if (input.businessDescription !== undefined) {
    const businessDescription = validateText(
      sanitizeBasic(input.businessDescription),
      'Business description',
      10,
      250
    );
    assertAcceptableText(businessDescription, 'Business description');
    updateData.businessDescription = businessDescription;
  }
  if (input.address !== undefined) {
    updateData.address = validateAddress(input.address);
  }
  if (input.city !== undefined) {
    updateData.city = validateBusinessName(input.city, 'City');
  }
  if (input.state !== undefined) {
    updateData.state = validateBusinessName(input.state, 'State');
  }
  if (input.country !== undefined) {
    updateData.country = validateBusinessName(input.country, 'Country');
  }
  if (input.latitude !== undefined) updateData.latitude = input.latitude;
  if (input.longitude !== undefined) updateData.longitude = input.longitude;

  // The photo belongs to the account; an empty value removes it
  let profilePhoto: string | null | undefined;
  if (input.profilePhoto !== undefined) {
    profilePhoto = input.profilePhoto ? validateUrl(input.profilePhoto) : null;
  }

  const updatedUser =
    profilePhoto !== undefined && profilePhoto !== user.profilePhoto
      ? await prisma.user.update({
          where: { id: userId },
          data: { profilePhoto },
        })
      : user;

  // Update provider
  const updatedProvider =
    Object.keys(updateData).length > 0
      ? await prisma.serviceProvider.update({
          where: { id: currentProvider.id },
          data: updateData,
        })
      : currentProvider;

  // A verified profile stays public when edited, so admins get to check the
  // new name and description
  const profileChanged =
    updatedProvider.businessName !== currentProvider.businessName ||
    updatedProvider.businessDescription !== currentProvider.businessDescription;

  if (currentProvider.verificationStatus === VerificationStatus.VERIFIED && profileChanged) {
    await flagContent({
      targetType: 'PROVIDER',
      targetId: currentProvider.id,
      targetUserId: userId,
      reason: 'OTHER',
      details: 'Automatic: verified business profile edited',
      snapshot: {
        before: {
          businessName: currentProvider.businessName,
          businessDescription: currentProvider.businessDescription,
        },
        after: {
          businessName: updatedProvider.businessName,
          businessDescription: updatedProvider.businessDescription,
        },
      },
    });
  }

  return formatWithStats(updatedUser, updatedProvider);
};

/**
 * Get User with Provider Profile
 */
export const getUserWithProvider = async (userId: string) => {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { provider: true },
  });

  if (!user) {
    throw new GraphQLError('User not found', {
      extensions: { code: 'NOT_FOUND' },
    });
  }

  return formatWithStats(user, user.provider);
};

// ==================
// Provider Verification (Admin actions)
// ==================

/**
 * Get Pending Providers
 */
export const getPendingProviders = async (pagination: { page: number; limit: number }) => {
  const { page, limit } = pagination;
  const skip = (page - 1) * limit;

  const [providers, total] = await Promise.all([
    prisma.serviceProvider.findMany({
      where: {
        verificationStatus: VerificationStatus.PENDING,
      },
      include: {
        user: true,
      },
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
    }),
    prisma.serviceProvider.count({
      where: {
        verificationStatus: VerificationStatus.PENDING,
      },
    }),
  ]);

  const totalPages = Math.ceil(total / limit);
  const stats = await loadProviderStats(providers.map((p) => p.id));

  return {
    items: providers.map((p) => formatUserWithProvider(p.user, p, stats.get(p.id))),
    total,
    page,
    limit,
    totalPages,
    hasNextPage: page < totalPages,
    hasPreviousPage: page > 1,
  };
};

const notPendingVerification = () =>
  new GraphQLError('Only providers pending verification can be approved', {
    extensions: { code: 'NOT_PENDING' },
  });

/**
 * Approve Provider. Only a provider who submitted for verification (PENDING)
 * can be approved.
 */
export const approveProvider = async (providerId: string, actor?: ModerationActor) => {
  const provider = await prisma.serviceProvider.findUnique({
    where: { id: providerId },
  });

  if (!provider) {
    throw providerNotFound();
  }

  if (provider.verificationStatus === VerificationStatus.VERIFIED) {
    throw new GraphQLError('Provider is already verified', {
      extensions: { code: 'ALREADY_VERIFIED' },
    });
  }

  if (provider.verificationStatus !== VerificationStatus.PENDING) {
    throw notPendingVerification();
  }

  // Only while it's still pending, in case another admin decided meanwhile
  const { count } = await prisma.serviceProvider.updateMany({
    where: { id: providerId, verificationStatus: VerificationStatus.PENDING },
    data: {
      verificationStatus: VerificationStatus.VERIFIED,
      rejectionReason: null,
    },
  });

  if (count === 0) {
    throw notPendingVerification();
  }

  const updatedProvider = await prisma.serviceProvider.findUnique({
    where: { id: providerId },
    include: { user: true },
  });

  if (!updatedProvider) {
    throw providerNotFound();
  }

  const { user } = updatedProvider;

  // Send approval notification email
  try {
    await sendProviderApprovedEmail(
      user.email,
      user.firstName,
      updatedProvider.businessName
    );
  } catch (error) {
    console.error('Failed to send provider approval email:', error);
    // Don't throw - the provider is still approved
  }

  await notifySafely('verification approval notification', () => notifyVerificationApproved(user.id));
  await notifySafely('verification approval push notification', () => sendVerificationPush(user.id, 'approved'));
  await recordModeration(actor, {
    action: 'VERIFY_PROVIDER',
    targetType: 'Provider',
    targetId: providerId,
    previousValue: { verificationStatus: provider.verificationStatus },
    newValue: { verificationStatus: VerificationStatus.VERIFIED },
  });

  return formatWithStats(user, updatedProvider);
};

/**
 * Reject Provider. The reason is saved on the profile and sent to the provider.
 */
export const rejectProvider = async (providerId: string, reason: string, actor?: ModerationActor) => {
  const safeReason = validateModerationReason(reason);

  const provider = await prisma.serviceProvider.findUnique({
    where: { id: providerId },
  });

  if (!provider) {
    throw providerNotFound();
  }

  const alreadyVerified = () =>
    new GraphQLError('Cannot reject an already verified provider', {
      extensions: { code: 'ALREADY_VERIFIED' },
    });

  if (provider.verificationStatus === VerificationStatus.VERIFIED) {
    throw alreadyVerified();
  }

  const { count } = await prisma.serviceProvider.updateMany({
    where: { id: providerId, verificationStatus: { not: VerificationStatus.VERIFIED } },
    data: {
      verificationStatus: VerificationStatus.REJECTED,
      rejectionReason: safeReason,
    },
  });

  if (count === 0) {
    throw alreadyVerified();
  }

  const updatedProvider = await prisma.serviceProvider.findUnique({
    where: { id: providerId },
    include: { user: true },
  });

  if (!updatedProvider) {
    throw providerNotFound();
  }

  const { user } = updatedProvider;

  // Send rejection notification email with reason
  try {
    await sendProviderRejectedEmail(
      user.email,
      user.firstName,
      updatedProvider.businessName,
      safeReason
    );
  } catch (error) {
    console.error('Failed to send provider rejection email:', error);
    // Don't throw - the provider is still rejected
  }

  await notifySafely('verification rejection notification', () => notifyVerificationRejected(user.id, safeReason));
  await notifySafely('verification rejection push notification', () =>
    sendVerificationPush(user.id, 'rejected', safeReason)
  );
  await recordModeration(actor, {
    action: 'REJECT_PROVIDER',
    targetType: 'Provider',
    targetId: providerId,
    previousValue: { verificationStatus: provider.verificationStatus },
    newValue: { verificationStatus: VerificationStatus.REJECTED },
    reason: safeReason,
  });

  return formatWithStats(user, updatedProvider);
};

/**
 * Submit Provider for Verification
 * Allows providers to submit/re-submit their profile for admin review
 */
export const submitForVerification = async (userId: string) => {
  // Find user with provider
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { provider: true },
  });

  if (!user) {
    throw new GraphQLError('User not found', {
      extensions: { code: 'NOT_FOUND' },
    });
  }

  // Check if user is a provider
  if (user.role !== UserRole.SERVICE_PROVIDER || !user.provider) {
    throw new GraphQLError('You must be a service provider to submit for verification', {
      extensions: { code: 'NOT_PROVIDER' },
    });
  }

  // Check if already verified
  if (user.provider.verificationStatus === VerificationStatus.VERIFIED) {
    throw new GraphQLError('Your provider account is already verified', {
      extensions: { code: 'ALREADY_VERIFIED' },
    });
  }

  // Check if already pending
  if (user.provider.verificationStatus === VerificationStatus.PENDING) {
    throw new GraphQLError('Your verification is already pending review', {
      extensions: { code: 'ALREADY_PENDING' },
    });
  }

  // Validate required fields before submission (profiles saved before the
  // address became required can still have an empty one)
  if (!user.provider.businessName || !user.provider.address || !user.provider.city) {
    throw new GraphQLError('Please complete your business profile before submitting for verification. Required: businessName, address, city', {
      extensions: { code: 'INCOMPLETE_PROFILE' },
    });
  }

  // Update status to PENDING
  const updatedProvider = await prisma.serviceProvider.update({
    where: { id: user.provider.id },
    data: {
      verificationStatus: VerificationStatus.PENDING,
    },
    include: { user: true },
  });

  // Send submission confirmation email
  try {
    await sendProviderSubmissionEmail(
      user.email,
      user.firstName,
      updatedProvider.businessName
    );
  } catch (error) {
    console.error('Failed to send provider submission email:', error);
    // Don't throw - the submission is still recorded
  }

  return formatWithStats(updatedProvider.user, updatedProvider);
};

/**
 * Get Provider Verification Status
 */
export const getVerificationStatus = async (userId: string) => {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { provider: true },
  });

  if (!user) {
    throw new GraphQLError('User not found', {
      extensions: { code: 'NOT_FOUND' },
    });
  }

  if (!user.provider) {
    throw new GraphQLError('You are not a service provider', {
      extensions: { code: 'NOT_PROVIDER' },
    });
  }

  return {
    status: user.provider.verificationStatus,
    canSubmit: user.provider.verificationStatus === VerificationStatus.UNVERIFIED ||
               user.provider.verificationStatus === VerificationStatus.REJECTED,
    message: getVerificationStatusMessage(user.provider.verificationStatus),
  };
};

/**
 * Get verification status message
 */
const getVerificationStatusMessage = (status: string): string => {
  switch (status) {
    case VerificationStatus.UNVERIFIED:
      return 'Your provider account has not been submitted for verification. Complete your profile and submit for review.';
    case VerificationStatus.PENDING:
      return 'Your verification is under review. This typically takes 1-2 business days.';
    case VerificationStatus.VERIFIED:
      return 'Your provider account is verified! You can create and publish services.';
    case VerificationStatus.REJECTED:
      return 'Your verification was not approved. Please update your profile and re-submit.';
    default:
      return 'Unknown verification status.';
  }
};

// ==================
// Role Switching Functions
// ==================

/**
 * Switch active role between SERVICE_USER and SERVICE_PROVIDER
 * Only available for SERVICE_PROVIDER accounts with a provider profile, the
 * same rule as myActiveRole's canSwitch
 */
export const switchActiveRole = async (userId: string, targetRole: string) => {
  // Validate target role
  if (targetRole !== UserRole.SERVICE_USER && targetRole !== UserRole.SERVICE_PROVIDER) {
    throw new GraphQLError('Invalid target role. Must be SERVICE_USER or SERVICE_PROVIDER', {
      extensions: { code: 'INVALID_ROLE' },
    });
  }

  // Find user with provider
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { provider: true },
  });

  if (!user) {
    throw new GraphQLError('User not found', {
      extensions: { code: 'NOT_FOUND' },
    });
  }

  if (user.role !== UserRole.SERVICE_PROVIDER || !user.provider) {
    throw new GraphQLError('You must be a registered provider to switch roles. Use becomeProvider first.', {
      extensions: { code: 'NOT_PROVIDER' },
    });
  }

  // Check if already in the target role
  const currentActiveRole = user.activeRole || user.role;
  if (currentActiveRole === targetRole) {
    throw new GraphQLError(`You are already in ${targetRole} mode`, {
      extensions: { code: 'ALREADY_IN_ROLE' },
    });
  }

  // Update active role
  const updatedUser = await prisma.user.update({
    where: { id: userId },
    data: { activeRole: targetRole === UserRole.SERVICE_USER ? UserRole.SERVICE_USER : UserRole.SERVICE_PROVIDER },
  });

  return formatWithStats(updatedUser, user.provider);
};

/**
 * Get current active role
 */
export const getActiveRole = async (userId: string) => {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { provider: true },
  });

  if (!user) {
    throw new GraphQLError('User not found', {
      extensions: { code: 'NOT_FOUND' },
    });
  }

  const activeRole = user.activeRole || user.role;
  const canSwitch = user.role === UserRole.SERVICE_PROVIDER && user.provider !== null;

  return {
    currentRole: user.role,
    activeRole,
    canSwitch,
    hasProviderProfile: user.provider !== null,
    message: canSwitch
      ? `You are currently in ${activeRole} mode. You can switch to ${activeRole === UserRole.SERVICE_PROVIDER ? UserRole.SERVICE_USER : UserRole.SERVICE_PROVIDER} mode.`
      : 'You cannot switch roles. Only registered providers can switch between user and provider modes.',
  };
};
