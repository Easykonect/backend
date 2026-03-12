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

  const updatedProvider = await prisma.serviceProvider.update({
    where: { id: providerId },
    data: {
      verificationStatus: VerificationStatus.VERIFIED,
    },
    include: { user: true },
  });

  // TODO: Send approval notification email

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

  const updatedProvider = await prisma.serviceProvider.update({
    where: { id: providerId },
    data: {
      verificationStatus: VerificationStatus.REJECTED,
    },
    include: { user: true },
  });

  // TODO: Send rejection notification email with reason

  return formatUserWithProvider(updatedProvider.user, updatedProvider);
};
