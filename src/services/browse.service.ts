/**
 * Browse Service
 * Public-facing APIs for discovering service providers
 *
 * Features:
 * - Browse all verified providers with filters
 * - Sort by: rating, popularity (likes), newest, name, distance (nearby only)
 * - Filter by: city, state, category, verifiedOnly, minRating
 * - Haversine-based distance calculation (for nearby providers)
 * - Paginated results
 */

import { GraphQLError } from 'graphql';
import type { Prisma } from '@prisma/client';
import prisma from '@/lib/prisma';
import { config } from '@/config';
import { UserRole, VerificationStatus } from '@/constants';
import { sanitizeSearchQuery } from '@/utils/security';
import { getBlockedUserIds, isBlockedBetween } from '@/services/block.service';

// ==================
// Types
// ==================

export type ProviderSortBy =
  | 'RATING_DESC'
  | 'POPULARITY_DESC'
  | 'NEWEST'
  | 'NAME_ASC'
  | 'NEAREST';

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
  // Not exposed in GraphQL — populated by the resolver from auth context to
  // exclude the requesting user's own provider profile from public listings.
  excludeUserId?: string;
}

export interface NearbyProvidersInput {
  latitude: number;
  longitude: number;
  radiusKm?: number;
  filters?: ProviderFiltersInput;
  sortBy?: ProviderSortBy;
  pagination?: { page: number; limit: number };
  excludeUserId?: string;
}

// The signed-in user opening a provider profile
export interface ProfileViewer {
  userId: string;
  role: string;
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

// Upper bound on providers loaded for one nearby search
export const MAX_NEARBY_CANDIDATES = 1000;

// A dense area's search radius is never narrowed below this
export const MIN_NEARBY_RADIUS_KM = 1;

// Reviews an admin removed (soft-deleted) don't count towards ratings or review
// totals. Reviews written before soft deletion have no deletedAt field at all.
const COUNTED_REVIEWS: Prisma.ReviewWhereInput = {
  OR: [{ deletedAt: null }, { deletedAt: { isSet: false } }],
};

/**
 * Latitude/longitude ranges enclosing a circle of radiusKm around a point, so a
 * nearby search only loads providers inside the box (the exact distance is
 * checked afterwards). Range filters also skip providers with no coordinates.
 */
export const boundingBox = (latitude: number, longitude: number, radiusKm: number) => {
  const KM_PER_DEGREE = 111.32;
  const latDelta = radiusKm / KM_PER_DEGREE;
  // Degrees of longitude shrink towards the poles; avoid dividing by ~0
  const lngDelta = radiusKm / (KM_PER_DEGREE * Math.max(Math.cos((latitude * Math.PI) / 180), 0.01));

  return {
    latitude: { gte: latitude - latDelta, lte: latitude + latDelta },
    longitude: { gte: longitude - lngDelta, lte: longitude + lngDelta },
  };
};

/**
 * Lowest average rating that still shows as at least minRating once rounded to
 * 1 decimal place, the way averageRating is returned
 */
export const minimumAverageFor = (minRating: number): number =>
  (Math.ceil(Number((minRating * 10).toFixed(6))) - 0.5) / 10;

// ==================
// Helpers
// ==================

/**
 * Build the base Prisma WHERE clause from filters
 * Note: All string filters are sanitized to prevent NoSQL injection
 */
const buildWhereClause = (filters: ProviderFiltersInput = {}): Prisma.ServiceProviderWhereInput => {
  const where: Prisma.ServiceProviderWhereInput = {};

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
 * Restrict a query to providers whose rounded average rating is at least
 * minRating. Done in the query so paging and totals account for it.
 */
const applyMinRating = async (
  where: Prisma.ServiceProviderWhereInput,
  minRating?: number | null
): Promise<void> => {
  if (!minRating || minRating <= 0) return;

  const rated = await prisma.review.groupBy({
    by: ['providerId'],
    where: COUNTED_REVIEWS,
    having: { rating: { _avg: { gte: minimumAverageFor(minRating) } } },
  });

  where.id = { in: rated.map((group) => group.providerId) };
};

/**
 * Build the Prisma ORDER BY clause from sortBy. The ID breaks ties so pages
 * don't overlap.
 */
const buildOrderBy = (sortBy: ProviderSortBy = 'NEWEST'): Prisma.ServiceProviderOrderByWithRelationInput[] => {
  switch (sortBy) {
    case 'NAME_ASC':
      return [{ businessName: 'asc' }, { id: 'asc' }];
    // RATING_DESC and POPULARITY_DESC are sorted after the query (computed
    // fields), starting from newest first
    default:
      return [{ createdAt: 'desc' }, { id: 'desc' }];
  }
};

const compareIds = (a: { id: string }, b: { id: string }): number =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

const notFound = () =>
  new GraphQLError('Provider not found', {
    extensions: { code: 'NOT_FOUND' },
  });

/**
 * Radius to load providers from. Without a geo index providers can't be loaded
 * nearest first, so when the square around the search circle holds more than
 * MAX_NEARBY_CANDIDATES providers the radius is halved until it doesn't (but
 * not below MIN_NEARBY_RADIUS_KM). Every provider within the returned radius is
 * then loaded, so the results are complete up to that distance.
 */
const narrowSearchRadius = async (
  where: Prisma.ServiceProviderWhereInput,
  latitude: number,
  longitude: number,
  radius: number
): Promise<number> => {
  let searchRadius = radius;

  while (searchRadius / 2 >= MIN_NEARBY_RADIUS_KM) {
    const candidates = await prisma.serviceProvider.count({
      where: { ...where, ...boundingBox(latitude, longitude, searchRadius) },
    });
    if (!(candidates > MAX_NEARBY_CANDIDATES)) break;
    searchRadius = Math.round((searchRadius / 2) * 10) / 10;
  }

  return searchRadius;
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
  excludeUserId,
}: BrowseProvidersInput) => {
  // Either field may be omitted by the client
  const { page = 1, limit: rawLimit = 10 } = pagination;
  const limit = Math.min(rawLimit, config.pagination.maxLimit);
  const skip = (page - 1) * limit;

  const where = buildWhereClause(filters);
  if (excludeUserId) {
    // The viewer's own profile, and providers they've blocked
    where.userId = { notIn: [excludeUserId, ...(await getBlockedUserIds(excludeUserId))] };
  }
  await applyMinRating(where, filters.minRating);

  // For rating/popularity sort we fetch all matched and sort in-memory
  // (MongoDB aggregations via Prisma are limited for computed sort)
  const needsComputedSort =
    sortBy === 'RATING_DESC' || sortBy === 'POPULARITY_DESC';

  const [rawProviders, total] = await Promise.all([
    prisma.serviceProvider.findMany({
      where,
      orderBy: buildOrderBy(sortBy),
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
          select: { reviews: { where: COUNTED_REVIEWS }, likes: true },
        },
      },
    }),
    prisma.serviceProvider.count({ where }),
  ]);

  // Attach average rating by aggregating reviews per provider
  const providerIds = rawProviders.map((p) => p.id);

  const ratingAggs = await prisma.review.groupBy({
    by: ['providerId'],
    where: { providerId: { in: providerIds }, ...COUNTED_REVIEWS },
    _avg: { rating: true },
  });

  const ratingMap = new Map(ratingAggs.map((r) => [r.providerId, r._avg.rating ?? 0]));

  const providers = rawProviders.map((p) => ({
    ...p,
    averageRating: Math.round((ratingMap.get(p.id) ?? 0) * 10) / 10,
    totalReviews: p._count.reviews,
    likeCount: p._count.likes,
  }));

  // Sort computed fields in-memory (the sort is stable, so ties stay newest first)
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
    total: totalFiltered,
    page,
    limit,
    totalPages,
    hasNextPage: page < totalPages,
    hasPreviousPage: page > 1,
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
 * Get a single provider's public profile by ID.
 * Only VERIFIED providers are public; the provider themself and admins can open
 * a profile in any status. A provider and a user who has blocked the other (in
 * either direction) can't see each other.
 */
export const getProviderPublicProfile = async (
  providerId: string,
  viewer?: ProfileViewer | null
) => {
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
          category: true,
        },
      },
      _count: {
        select: { reviews: { where: COUNTED_REVIEWS }, likes: true },
      },
    },
  });

  if (!provider) {
    throw notFound();
  }

  const isAdmin = viewer?.role === UserRole.ADMIN || viewer?.role === UserRole.SUPER_ADMIN;
  const isOwner = Boolean(viewer) && viewer?.userId === provider.userId;

  if (!isAdmin && !isOwner) {
    if (provider.verificationStatus !== VerificationStatus.VERIFIED) {
      throw notFound();
    }
    if (viewer && (await isBlockedBetween(viewer.userId, provider.userId))) {
      throw notFound();
    }
  }

  // Get average rating
  const ratingStats = await prisma.review.aggregate({
    where: { providerId, ...COUNTED_REVIEWS },
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
  excludeUserId,
}: NearbyProvidersInput) => {
  const radius = Math.min(
    radiusKm ?? config.geo.defaultRadiusKm,
    config.geo.maxRadiusKm
  );

  // Either field may be omitted by the client
  const { page = 1, limit: rawLimit = 10 } = pagination;
  const limit = Math.min(rawLimit, config.pagination.maxLimit);

  const where = buildWhereClause(filters);
  if (excludeUserId) {
    // The viewer's own profile, and providers they've blocked
    where.userId = { notIn: [excludeUserId, ...(await getBlockedUserIds(excludeUserId))] };
  }
  await applyMinRating(where, filters.minRating);

  const searchRadius = await narrowSearchRadius(where, latitude, longitude, radius);

  // Load only providers inside the bounding box (latitude/longitude index);
  // the exact distance is checked below
  const rawProviders = await prisma.serviceProvider.findMany({
    where: {
      ...where,
      ...boundingBox(latitude, longitude, searchRadius),
    },
    orderBy: [{ id: 'asc' }],
    take: MAX_NEARBY_CANDIDATES,
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
        select: { reviews: { where: COUNTED_REVIEWS }, likes: true },
      },
    },
  });

  const providerIds = rawProviders.map((p) => p.id);

  const ratingAggs = await prisma.review.groupBy({
    by: ['providerId'],
    where: { providerId: { in: providerIds }, ...COUNTED_REVIEWS },
    _avg: { rating: true },
  });

  const ratingMap = new Map(ratingAggs.map((r) => [r.providerId, r._avg.rating ?? 0]));

  // Attach computed fields + distance, then filter by radius
  const providers = rawProviders
    .map((p) => ({
      ...p,
      averageRating: Math.round((ratingMap.get(p.id) ?? 0) * 10) / 10,
      totalReviews: p._count.reviews,
      likeCount: p._count.likes,
      distanceKm: haversineDistance(latitude, longitude, p.latitude!, p.longitude!),
    }))
    .filter((p) => p.distanceKm <= searchRadius);

  type NearbyProvider = (typeof providers)[number];
  const nearestFirst = (a: NearbyProvider, b: NearbyProvider) =>
    a.distanceKm - b.distanceKm || compareIds(a, b);

  // Sort; ties go to the nearer provider, then by ID
  switch (sortBy) {
    case 'RATING_DESC':
      providers.sort((a, b) => b.averageRating - a.averageRating || nearestFirst(a, b));
      break;
    case 'POPULARITY_DESC':
      providers.sort((a, b) => b.likeCount - a.likeCount || nearestFirst(a, b));
      break;
    case 'NAME_ASC':
      providers.sort((a, b) => a.businessName.localeCompare(b.businessName) || compareIds(a, b));
      break;
    case 'NEWEST':
      providers.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || compareIds(a, b));
      break;
    default:
      // NEAREST
      providers.sort(nearestFirst);
  }

  const total = providers.length;
  const totalPages = Math.ceil(total / limit);
  const skip = (page - 1) * limit;
  const paginatedProviders = providers.slice(skip, skip + limit);

  return {
    items: paginatedProviders.map((p) => formatProvider(p, p.distanceKm)),
    total,
    page,
    limit,
    totalPages,
    hasNextPage: page < totalPages,
    hasPreviousPage: page > 1,
    pagination: {
      page,
      limit,
      total,
      totalPages,
      hasNext: page < totalPages,
      hasPrev: page > 1,
    },
    radiusKm: radius,
    // Every provider within this distance is included; smaller than radiusKm
    // only when the area holds too many providers to load at once
    coveredRadiusKm: searchRadius,
    searchLocation: { latitude, longitude },
  };
};
