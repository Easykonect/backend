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
import prisma from '@/lib/prisma';
import { UserRole, AccountStatus, VerificationStatus } from '@/constants';
import { 
  sendProviderApprovedEmail, 
  sendProviderRejectedEmail,
  sendProviderSubmissionEmail 
} from '@/lib/email';

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
  latitude?: number;
  longitude?: number;
}

// ==================
// Helper Functions
// ==================

/**
 * Format user with provider profile
 */
const formatUserWithProvider = (user: any, provider: any = null) => ({
  id: user.id,
  email: user.email,
  firstName: user.firstName,
  lastName: user.lastName,
  phone: user.phone,
  role: user.role,
  activeRole: user.activeRole || user.role, // Default to role if not set
  status: user.status,
  isEmailVerified: user.isEmailVerified,
  providerProfile: provider ? {
    id: provider.id,
    businessName: provider.businessName,
    businessDescription: provider.businessDescription,
    verificationStatus: provider.verificationStatus,
    address: provider.address,
    city: provider.city,
    state: provider.state,
    country: provider.country,
    latitude: provider.latitude,
    longitude: provider.longitude,
    documents: provider.documents,
    createdAt: provider.createdAt.toISOString(),
    updatedAt: provider.updatedAt.toISOString(),
  } : null,
  createdAt: user.createdAt.toISOString(),
  updatedAt: user.updatedAt.toISOString(),
});

// ==================
// Provider Functions
// ==================

/**
 * Upgrade SERVICE_USER to SERVICE_PROVIDER
 */
export const becomeProvider = async (userId: string, input: BecomeProviderInput) => {
  const { businessName, businessDescription, address, city, state, country, latitude, longitude } = input;

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

  // Generate slug from business name
  const slug = businessName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');

  // Create provider profile and update user role in a transaction
  const [updatedUser, provider] = await prisma.$transaction(async (tx) => {
    // Create provider profile
    const newProvider = await tx.serviceProvider.create({
      data: {
        userId: user.id,
        businessName,
        businessDescription,
        address,
        city,
        state,
        country,
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

    return [updated, newProvider];
  });

  return formatUserWithProvider(updatedUser, provider);
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

  // Build update data
  const updateData: any = {};
  
  if (input.businessName !== undefined) updateData.businessName = input.businessName;
  if (input.businessDescription !== undefined) updateData.businessDescription = input.businessDescription;
  if (input.address !== undefined) updateData.address = input.address;
  if (input.city !== undefined) updateData.city = input.city;
  if (input.state !== undefined) updateData.state = input.state;
  if (input.country !== undefined) updateData.country = input.country;
  if (input.latitude !== undefined) updateData.latitude = input.latitude;
  if (input.longitude !== undefined) updateData.longitude = input.longitude;

  // Update provider
  const updatedProvider = await prisma.serviceProvider.update({
    where: { id: user.provider.id },
    data: updateData,
  });

  return formatUserWithProvider(user, updatedProvider);
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

  return formatUserWithProvider(user, user.provider);
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

  return {
    items: providers.map((p) => formatUserWithProvider(p.user, p)),
    total,
    page,
    limit,
    totalPages,
    hasNextPage: page < totalPages,
    hasPreviousPage: page > 1,
  };
};

/**
 * Approve Provider
 */
export const approveProvider = async (providerId: string) => {
  const provider = await prisma.serviceProvider.findUnique({
    where: { id: providerId },
    include: { user: true },
  });

  if (!provider) {
    throw new GraphQLError('Provider not found', {
      extensions: { code: 'NOT_FOUND' },
    });
  }

  if (provider.verificationStatus === VerificationStatus.VERIFIED) {
    throw new GraphQLError('Provider is already verified', {
      extensions: { code: 'ALREADY_VERIFIED' },
    });
  }

  const updatedProvider = await prisma.serviceProvider.update({
    where: { id: providerId },
    data: {
      verificationStatus: VerificationStatus.VERIFIED,
    },
    include: { user: true },
  });

  // Send approval notification email
  try {
    await sendProviderApprovedEmail(
      updatedProvider.user.email,
      updatedProvider.user.firstName,
      updatedProvider.businessName
    );
  } catch (error) {
    console.error('Failed to send provider approval email:', error);
    // Don't throw - the provider is still approved
  }

  return formatUserWithProvider(updatedProvider.user, updatedProvider);
};

/**
 * Reject Provider
 */
export const rejectProvider = async (providerId: string, reason: string) => {
  const provider = await prisma.serviceProvider.findUnique({
    where: { id: providerId },
    include: { user: true },
  });

  if (!provider) {
    throw new GraphQLError('Provider not found', {
      extensions: { code: 'NOT_FOUND' },
    });
  }

  if (provider.verificationStatus === VerificationStatus.VERIFIED) {
    throw new GraphQLError('Cannot reject an already verified provider', {
      extensions: { code: 'ALREADY_VERIFIED' },
    });
  }

  const updatedProvider = await prisma.serviceProvider.update({
    where: { id: providerId },
    data: {
      verificationStatus: VerificationStatus.REJECTED,
    },
    include: { user: true },
  });

  // Send rejection notification email with reason
  try {
    await sendProviderRejectedEmail(
      updatedProvider.user.email,
      updatedProvider.user.firstName,
      updatedProvider.businessName,
      reason
    );
  } catch (error) {
    console.error('Failed to send provider rejection email:', error);
    // Don't throw - the provider is still rejected
  }

  return formatUserWithProvider(updatedProvider.user, updatedProvider);
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

  // Validate required fields before submission
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

  return formatUserWithProvider(updatedProvider.user, updatedProvider);
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
 * Only available for users who have a provider profile
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

  // Check if user has provider profile (required to switch roles)
  if (!user.provider) {
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
    data: { activeRole: targetRole as any },
  });

  // Fetch with provider for response
  const userWithProvider = await prisma.user.findUnique({
    where: { id: userId },
    include: { provider: true },
  });

  return formatUserWithProvider(userWithProvider, userWithProvider?.provider);
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
