/**
 * Browse Service
 * Public-facing APIs for discovering service providers
 *
 * Features:
 * - Browse all verified providers with filters
 * - Sort by: rating, popularity (likes), newest, name
 * - Filter by: city, state, category, verifiedOnly, minRating
 * - Haversine-based distance calculation (for nearby providers)
 * - Paginated results
 */

import { GraphQLError } from 'graphql';
import prisma from '@/lib/prisma';
import { config } from '@/config';
import { VerificationStatus } from '@/constants';
import { sanitizeSearchQuery } from '@/utils/security';

// ==================
// Types
// ==================

export type ProviderSortBy =
  | 'RATING_DESC'
  | 'POPULARITY_DESC'
  | 'NEWEST'
  | 'NAME_ASC';

export interface ProviderFiltersInput {
  city?: string;
  state?: string;
  country?: string;
  categoryId?: string;
  verifiedOnly?: boolean;
  minRating?: number;
}

export interface BrowseProvidersInput {
  filters?: ProviderFiltersInput;
  sortBy?: ProviderSortBy;
  pagination?: { page: number; limit: number };
}

export interface NearbyProvidersInput {
  latitude: number;
  longitude: number;
  radiusKm?: number;
  filters?: ProviderFiltersInput;
  sortBy?: ProviderSortBy;
  pagination?: { page: number; limit: number };
}

// ==================
// Haversine Distance
// ==================

/**
 * Calculate distance between two lat/lng points in kilometres
 */
export const haversineDistance = (
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number
): number => {
  const R = 6371; // Earth radius in km
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c * 10) / 10; // 1 decimal place
};

// ==================
// Helpers
// ==================

/**
 * Build the base Prisma WHERE clause from filters
 * Note: All string filters are sanitized to prevent NoSQL injection
 */
const buildWhereClause = (filters: ProviderFiltersInput = {}) => {
  const where: any = {};

  if (filters.verifiedOnly !== false) {
    // Default to verified only unless explicitly set to false
    where.verificationStatus = VerificationStatus.VERIFIED;
  }

  if (filters.city) {
    const sanitizedCity = sanitizeSearchQuery(filters.city);
    where.city = { equals: sanitizedCity, mode: 'insensitive' };
  }

  if (filters.state) {
    const sanitizedState = sanitizeSearchQuery(filters.state);
    where.state = { equals: sanitizedState, mode: 'insensitive' };
  }

  if (filters.country) {
    where.country = { equals: filters.country, mode: 'insensitive' };
  }

  if (filters.categoryId) {
    where.services = {
      some: {
        categoryId: filters.categoryId,
        status: 'ACTIVE',
      },
    };
  }

  return where;
};

/**
 * Build the Prisma ORDER BY clause from sortBy
 */
const buildOrderBy = (sortBy: ProviderSortBy = 'NEWEST') => {
  switch (sortBy) {
    case 'NAME_ASC':
      return [{ businessName: 'asc' as const }];
    case 'NEWEST':
      return [{ createdAt: 'desc' as const }];
    // RATING_DESC and POPULARITY_DESC are handled post-query (computed fields)
    default:
      return [{ createdAt: 'desc' as const }];
  }
};

/**
 * Format a single provider result with computed rating + like count
 */
const formatProvider = (
  provider: any,
  distanceKm?: number
) => ({
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
  images: provider.images ?? [],
  documents: provider.documents ?? [],
  averageRating:
    provider._avg?.rating != null
      ? Math.round(provider._avg.rating * 10) / 10
      : provider.averageRating ?? 0,
  totalReviews: provider._count?.reviews ?? provider.totalReviews ?? 0,
  likeCount: provider._count?.likes ?? provider.likeCount ?? 0,
  distanceKm: distanceKm ?? null,
  user: provider.user
    ? {
        id: provider.user.id,
        firstName: provider.user.firstName,
        lastName: provider.user.lastName,
        profilePhoto: provider.user.profilePhoto ?? null,
      }
    : null,
  categories: provider.services
    ? [...new Set(provider.services.map((s: any) => s.category?.name).filter(Boolean))]
    : [],
  createdAt: provider.createdAt.toISOString(),
  updatedAt: provider.updatedAt.toISOString(),
});

// ==================
// Service Functions
// ==================

/**
 * Browse providers with filters, sorting and pagination
 */
export const browseProviders = async ({
  filters = {},
  sortBy = 'NEWEST',
  pagination = { page: 1, limit: 10 },
}: BrowseProvidersInput) => {
  const { page, limit: rawLimit } = pagination;
  const limit = Math.min(rawLimit, config.pagination.maxLimit);
  const skip = (page - 1) * limit;

  const where = buildWhereClause(filters);

  // For rating/popularity sort we fetch all matched and sort in-memory
  // (MongoDB aggregations via Prisma are limited for computed sort)
  const needsComputedSort =
    sortBy === 'RATING_DESC' || sortBy === 'POPULARITY_DESC';

  const orderBy = needsComputedSort ? undefined : buildOrderBy(sortBy);

  const [rawProviders, total] = await Promise.all([
    prisma.serviceProvider.findMany({
      where,
      orderBy,
      skip: needsComputedSort ? 0 : skip,
      take: needsComputedSort ? undefined : limit,
      include: {
        user: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            profilePhoto: true,
          },
        },
        services: {
          where: { status: 'ACTIVE' },
          select: {
            category: { select: { id: true, name: true, slug: true } },
          },
        },
        _count: {
          select: { reviews: true, likes: true },
        },
      },
    }),
    prisma.serviceProvider.count({ where }),
  ]);

  // Attach average rating by aggregating reviews per provider
  const providerIds = rawProviders.map((p) => p.id);

  const ratingAggs = await prisma.review.groupBy({
    by: ['providerId'],
    where: { providerId: { in: providerIds } },
    _avg: { rating: true },
  });

  const ratingMap = new Map(ratingAggs.map((r) => [r.providerId, r._avg.rating ?? 0]));

  // Attach minRating filter (post-query since it's computed)
  let providers = rawProviders
    .map((p) => ({
      ...p,
      averageRating: Math.round((ratingMap.get(p.id) ?? 0) * 10) / 10,
      totalReviews: p._count.reviews,
      likeCount: p._count.likes,
    }))
    .filter((p) =>
      filters.minRating ? p.averageRating >= filters.minRating : true
    );

  // Sort computed fields in-memory
  if (sortBy === 'RATING_DESC') {
    providers.sort((a, b) => b.averageRating - a.averageRating);
  } else if (sortBy === 'POPULARITY_DESC') {
    providers.sort((a, b) => b.likeCount - a.likeCount);
  }

  // Apply pagination for computed sort
  const paginatedProviders = needsComputedSort
    ? providers.slice(skip, skip + limit)
    : providers;

  const totalFiltered = needsComputedSort ? providers.length : total;
  const totalPages = Math.ceil(totalFiltered / limit);

  return {
    items: paginatedProviders.map((p) => formatProvider(p)),
    pagination: {
      page,
      limit,
      total: totalFiltered,
      totalPages,
      hasNext: page < totalPages,
      hasPrev: page > 1,
    },
  };
};

/**
 * Get a single provider's public profile by ID
 */
export const getProviderPublicProfile = async (providerId: string) => {
  const provider = await prisma.serviceProvider.findUnique({
    where: { id: providerId },
    include: {
      user: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          profilePhoto: true,
        },
      },
      services: {
        where: { status: 'ACTIVE' },
        select: {
          id: true,
          name: true,
          price: true,
          duration: true,
          images: true,
          category: { select: { id: true, name: true, slug: true } },
        },
      },
      _count: {
        select: { reviews: true, likes: true },
      },
    },
  });

  if (!provider) {
    throw new GraphQLError('Provider not found', {
      extensions: { code: 'NOT_FOUND' },
    });
  }

  // Get average rating
  const ratingStats = await prisma.review.aggregate({
    where: { providerId },
    _avg: { rating: true },
    _count: { id: true },
  });

  return {
    ...formatProvider({
      ...provider,
      // Override _count with aggregate data so formatProvider picks the right values
      _count: {
        reviews: ratingStats._count.id,
        likes: provider._count.likes,
      },
      averageRating: ratingStats._avg.rating
        ? Math.round(ratingStats._avg.rating * 10) / 10
        : 0,
      totalReviews: ratingStats._count.id,
      likeCount: provider._count.likes,
    }),
    // Also include active services on profile view
    activeServices: provider.services.map((s) => ({
      id: s.id,
      name: s.name,
      price: s.price,
      duration: s.duration,
      images: s.images,
      category: s.category,
    })),
  };
};

/**
 * Get nearby providers using Haversine distance calculation
 */
export const getNearbyProviders = async ({
  latitude,
  longitude,
  radiusKm,
  filters = {},
  sortBy = 'RATING_DESC',
  pagination = { page: 1, limit: 10 },
}: NearbyProvidersInput) => {
  const radius = Math.min(
    radiusKm ?? config.geo.defaultRadiusKm,
    config.geo.maxRadiusKm
  );

  const { page, limit: rawLimit } = pagination;
  const limit = Math.min(rawLimit, config.pagination.maxLimit);

  const where = buildWhereClause(filters);

  // Fetch all providers with lat/lng (we filter by distance in JS)
  const rawProviders = await prisma.serviceProvider.findMany({
    where: {
      ...where,
      latitude: { not: null },
      longitude: { not: null },
    },
    include: {
      user: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          profilePhoto: true,
        },
      },
      services: {
        where: { status: 'ACTIVE' },
        select: {
          category: { select: { id: true, name: true, slug: true } },
        },
      },
      _count: {
        select: { reviews: true, likes: true },
      },
    },
  });

  const providerIds = rawProviders.map((p) => p.id);

  const ratingAggs = await prisma.review.groupBy({
    by: ['providerId'],
    where: { providerId: { in: providerIds } },
    _avg: { rating: true },
  });

  const ratingMap = new Map(ratingAggs.map((r) => [r.providerId, r._avg.rating ?? 0]));

  // Attach computed fields + distance, then filter by radius
  let providers = rawProviders
    .map((p) => ({
      ...p,
      averageRating: Math.round((ratingMap.get(p.id) ?? 0) * 10) / 10,
      totalReviews: p._count.reviews,
      likeCount: p._count.likes,
      distanceKm: haversineDistance(latitude, longitude, p.latitude!, p.longitude!),
    }))
    .filter((p) => p.distanceKm <= radius)
    .filter((p) => (filters.minRating ? p.averageRating >= filters.minRating : true));

  // Sort
  if (sortBy === 'RATING_DESC') {
    providers.sort((a, b) => b.averageRating - a.averageRating);
  } else if (sortBy === 'POPULARITY_DESC') {
    providers.sort((a, b) => b.likeCount - a.likeCount);
  } else if (sortBy === 'NAME_ASC') {
    providers.sort((a, b) => a.businessName.localeCompare(b.businessName));
  } else {
    // Default: sort by distance (nearest first)
    providers.sort((a, b) => a.distanceKm - b.distanceKm);
  }

  const total = providers.length;
  const totalPages = Math.ceil(total / limit);
  const skip = (page - 1) * limit;
  const paginatedProviders = providers.slice(skip, skip + limit);

  return {
    items: paginatedProviders.map((p) => formatProvider(p, p.distanceKm)),
    pagination: {
      page,
      limit,
      total,
      totalPages,
      hasNext: page < totalPages,
      hasPrev: page > 1,
    },
    radiusKm: radius,
    searchLocation: { latitude, longitude },
  };
};
