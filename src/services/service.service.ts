/**
 * Service Management Service
 * Handles service CRUD operations for providers
 */

import { GraphQLError } from 'graphql';
import type { Prisma } from '@prisma/client';
import prisma from '@/lib/prisma';
import { config } from '@/config';
import { UserRole, ServiceStatus, VerificationStatus, NotificationType, type ServiceStatusType } from '@/constants';
import {
  sanitizeBasic,
  validateBusinessName,
  validateText,
  validateAmount,
  sanitizeSearchQuery,
  MAX_LENGTHS,
} from '@/utils/security';
import { slugify, slugSuffix } from '@/utils/slug';
import { aliasesFor } from '@/constants/search-aliases';
import { haversineDistance, boundingBox, MAX_NEARBY_CANDIDATES } from '@/services/browse.service';
import { assertAcceptableText } from '@/lib/content-filter';
import { getBlockedUserIds, isBlockedBetween } from '@/services/block.service';
import { flagContent } from '@/services/report.service';
import { assertTermsAccepted } from '@/services/terms.service';
import {
  createNotification,
  notifyServiceApproved,
  notifyServiceRejected,
} from '@/services/notification.service';
import { sendPushToUser } from '@/services/push.service';
import {
  formatProviderProfile,
  isAdminRole,
  loadProviderStats,
  notifySafely,
  recordModeration,
  validateModerationReason,
  type ModerationActor,
  type ProviderStats,
} from '@/services/provider-profile.service';

// ==================
// Types
// ==================

interface CreateServiceInput {
  categoryId: string;
  name: string;
  description: string;
  price: number;
  duration: number;
  images?: string[] | null;
}

interface UpdateServiceInput {
  categoryId?: string | null;
  name?: string;
  description?: string;
  price?: number;
  duration?: number;
  images?: string[] | null;
  status?: ServiceStatusType | null;
}

interface ServiceFiltersInput {
  categoryId?: string;
  providerId?: string;
  status?: ServiceStatusType;
  minPrice?: number;
  maxPrice?: number;
  search?: string;
  city?: string;
  state?: string;
  latitude?: number;
  longitude?: number;
  radiusKm?: number;
  // Not exposed in GraphQL — the signed-in viewer's user ID, populated by the
  // resolver from the auth context. The viewer's own services, and those of
  // providers they blocked, are left out of the customer-facing list.
  excludeProviderUserId?: string;
}

/**
 * The signed-in user asking for a service
 */
export interface ServiceViewer {
  userId: string;
  role: string;
}

type ServiceWithRelations = Prisma.ServiceGetPayload<{ include: { provider: true; category: true } }>;

type ServiceDecision = 'approved' | 'reinstated' | 'rejected' | 'suspended';

// ==================
// Helper Functions
// ==================

// Most images a service can have, the same limit as uploadServiceImages
const MAX_SERVICE_IMAGES = 10;

const serviceNotFound = () =>
  new GraphQLError('Service not found', {
    extensions: { code: 'NOT_FOUND' },
  });

const emptyPage = (page: number, limit: number) => ({
  items: [],
  total: 0,
  page,
  limit,
  totalPages: 0,
  hasNextPage: false,
  hasPreviousPage: false,
});

/**
 * Whether a page of results answers what was typed (EXACT) or what the search
 * was broadened to when that found nothing (RELATED)
 */
type SearchMatchType = 'EXACT' | 'RELATED';

/**
 * Where a free-text search term is looked for: the listing itself, the
 * category it sits in, and the provider's business name. Callers pass an
 * already-sanitised term.
 */
const searchConditions = (term: string): Prisma.ServiceWhereInput[] => [
  { name: { contains: term, mode: 'insensitive' } },
  { description: { contains: term, mode: 'insensitive' } },
  { category: { is: { name: { contains: term, mode: 'insensitive' } } } },
  { category: { is: { slug: { contains: term, mode: 'insensitive' } } } },
  { provider: { is: { businessName: { contains: term, mode: 'insensitive' } } } },
];

/**
 * The URL, if it's an https image in the platform's Cloudinary account
 */
const parseOwnImageUrl = (value: unknown): URL | null => {
  const { cloudName } = config.cloudinary;
  if (!cloudName || typeof value !== 'string' || value.length > MAX_LENGTHS.URL) return null;

  try {
    const url = new URL(value);
    const isOwnImage =
      url.protocol === 'https:' &&
      url.hostname === 'res.cloudinary.com' &&
      !url.port &&
      !url.username &&
      !url.password &&
      url.pathname.startsWith(`/${cloudName}/image/upload/`);
    return isOwnImage ? url : null;
  } catch {
    return null;
  }
};

/**
 * Service images: at most 10, each an https image URL in the platform's
 * Cloudinary account, which is what uploadServiceImages produces
 */
const validateServiceImages = (images: string[] | null | undefined): string[] => {
  const list = images ?? [];

  if (list.length > MAX_SERVICE_IMAGES) {
    throw new GraphQLError(`A service can have at most ${MAX_SERVICE_IMAGES} images`, {
      extensions: { code: 'MAX_IMAGES_EXCEEDED' },
    });
  }

  return list.map((image) => {
    const url = parseOwnImageUrl(image);
    if (!url) {
      throw new GraphQLError('Each image must be a photo uploaded to Easykonnet', {
        extensions: { code: 'INVALID_IMAGE_URL' },
      });
    }
    return url.href;
  });
};

/**
 * A slug for the service name that none of the provider's other services use.
 * A slug that's taken, or a name with no letters or digits to build one from,
 * gets a random suffix.
 */
const uniqueServiceSlug = async (providerId: string, name: string, serviceId?: string): Promise<string> => {
  const baseSlug = slugify(name);
  if (!baseSlug) return `service-${slugSuffix()}`;

  const taken = await prisma.service.findFirst({
    where: {
      providerId,
      slug: baseSlug,
      ...(serviceId ? { id: { not: serviceId } } : {}),
    },
    select: { id: true },
  });

  return taken ? `${baseSlug}-${slugSuffix()}` : baseSlug;
};

/**
 * Format service response
 */
const formatService = (service: ServiceWithRelations, stats: Map<string, ProviderStats>) => ({
  id: service.id,
  provider: formatProviderProfile(service.provider, stats.get(service.providerId)),
  category: {
    id: service.category.id,
    name: service.category.name,
    slug: service.category.slug,
    description: service.category.description,
    icon: service.category.icon,
    isActive: service.category.isActive,
    createdAt: service.category.createdAt.toISOString(),
    updatedAt: service.category.updatedAt.toISOString(),
  },
  name: service.name,
  slug: service.slug,
  description: service.description,
  price: service.price,
  duration: service.duration,
  status: service.status,
  // Only returned to the owning provider and admins (see the type resolvers)
  rejectionReason: service.rejectionReason ?? null,
  suspensionReason: service.suspensionReason ?? null,
  images: service.images,
  createdAt: service.createdAt.toISOString(),
  updatedAt: service.updatedAt.toISOString(),
});

/**
 * Format services, with each provider's rating and like counts
 */
const formatServices = async (services: ServiceWithRelations[]) => {
  const stats = await loadProviderStats(services.map((service) => service.providerId));
  return services.map((service) => formatService(service, stats));
};

const formatOneService = async (service: ServiceWithRelations) => {
  const [formatted] = await formatServices([service]);
  return formatted;
};

const findServiceWithRelations = (serviceId: string) =>
  prisma.service.findUnique({
    where: { id: serviceId },
    include: { provider: true, category: true },
  });

/**
 * Get provider for user
 */
const getProviderForUser = async (userId: string) => {
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
    throw new GraphQLError('You must be a service provider to manage services', {
      extensions: { code: 'NOT_PROVIDER' },
    });
  }

  return user.provider;
};

// ==================
// Service Functions
// ==================

/**
 * Get All Services (Public)
 *
 * Everyone sees ACTIVE services only. `filters.status` is honoured for admins,
 * and for a provider listing their own services (`filters.providerId` is their
 * profile), whose own services then aren't left out.
 */
export const getServices = async (
  filters: ServiceFiltersInput = {},
  pagination: { page: number; limit: number },
  viewerRole?: string | null
) => {
  const { page = 1, limit: rawLimit = 20 } = pagination;
  const limit = Math.min(rawLimit, config.pagination.maxLimit);
  const skip = (page - 1) * limit;

  const viewerId = filters.excludeProviderUserId;
  const isAdmin = isAdminRole(viewerRole);

  let isOwnList = false;
  if (viewerId && filters.providerId && !isAdmin) {
    const listedProvider = await prisma.serviceProvider.findUnique({
      where: { id: filters.providerId },
      select: { userId: true },
    });
    isOwnList = listedProvider?.userId === viewerId;
  }

  const where: Prisma.ServiceWhereInput = {
    status: (isAdmin || isOwnList) && filters.status ? filters.status : ServiceStatus.ACTIVE,
  };

  if (filters.categoryId) {
    where.categoryId = filters.categoryId;
  }

  if (filters.providerId) {
    where.providerId = filters.providerId;
  }

  if (filters.minPrice != null || filters.maxPrice != null) {
    where.price = {
      ...(filters.minPrice != null ? { gte: filters.minPrice } : {}),
      ...(filters.maxPrice != null ? { lte: filters.maxPrice } : {}),
    };
  }

  // Free-text search: what was typed, then (only if that finds nothing) the
  // known alternatives for it. `categoryId` above still narrows either way.
  let matchType: SearchMatchType = 'EXACT';
  let searchedFor: string | null = null;
  let aliasTerms: string[] = [];

  if (filters.search) {
    // Sanitize search query to prevent NoSQL injection
    const sanitizedSearch = sanitizeSearchQuery(filters.search);
    if (sanitizedSearch) {
      searchedFor = sanitizedSearch;
      where.OR = searchConditions(sanitizedSearch);
      aliasTerms = aliasesFor(filters.search)
        .map((alias) => sanitizeSearchQuery(alias))
        .filter(Boolean);
    }
  }

  // Provider-relation filters (city, state, geo radius, exclude-self)
  const providerWhere: Prisma.ServiceProviderWhereInput = {};
  if (filters.city) {
    providerWhere.city = { equals: sanitizeSearchQuery(filters.city), mode: 'insensitive' };
  }
  if (filters.state) {
    providerWhere.state = { equals: sanitizeSearchQuery(filters.state), mode: 'insensitive' };
  }
  if (viewerId && !isOwnList) {
    // The viewer's own listings, and providers they've blocked
    providerWhere.userId = {
      notIn: [viewerId, ...(await getBlockedUserIds(viewerId))],
    };
  }

  // Distance per provider, kept only when the caller sent coordinates
  let distanceByProvider: Map<string, number> | null = null;

  // Geo radius requires lat + lon. radiusKm falls back to config default.
  const { latitude, longitude } = filters;
  if (latitude != null && longitude != null) {
    const radius = Math.min(
      filters.radiusKm ?? config.geo.defaultRadiusKm,
      config.geo.maxRadiusKm
    );

    // Resolve qualifying provider IDs by haversine, then constrain the service query.
    const candidateProviders = await prisma.serviceProvider.findMany({
      where: {
        ...providerWhere,
        ...boundingBox(latitude, longitude, radius),
      },
      select: { id: true, latitude: true, longitude: true },
      take: MAX_NEARBY_CANDIDATES,
    });

    const nearbyIds: string[] = [];
    distanceByProvider = new Map<string, number>();
    for (const candidate of candidateProviders) {
      const distance = haversineDistance(
        latitude,
        longitude,
        candidate.latitude!,
        candidate.longitude!
      );
      if (distance <= radius) {
        nearbyIds.push(candidate.id);
        distanceByProvider.set(candidate.id, distance);
      }
    }

    // Nobody nearby, or the requested provider isn't
    if (nearbyIds.length === 0 || (filters.providerId && !nearbyIds.includes(filters.providerId))) {
      return { ...emptyPage(page, limit), matchType, searchedFor };
    }

    if (!filters.providerId) {
      where.providerId = { in: nearbyIds };
    }
  } else if (Object.keys(providerWhere).length > 0) {
    // city/state without geo: filter via provider relation
    where.provider = { is: providerWhere };
  }

  const runPage = (pageWhere: Prisma.ServiceWhereInput) =>
    Promise.all([
      prisma.service.findMany({
        where: pageWhere,
        include: {
          provider: true,
          category: true,
        },
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      prisma.service.count({ where: pageWhere }),
    ]);

  let [items, total] = await runPage(where);

  // Nothing matched what they typed ("painter"): try the known alternatives
  // ("painting", "paint") once, in one more query, and mark the page RELATED.
  if (total === 0 && aliasTerms.length > 0) {
    const [relatedItems, relatedTotal] = await runPage({
      ...where,
      OR: aliasTerms.flatMap((alias) => searchConditions(alias)),
    });

    if (relatedTotal > 0) {
      items = relatedItems;
      total = relatedTotal;
      matchType = 'RELATED';
      searchedFor = aliasTerms.join(', ');
    }
  }

  const totalPages = Math.ceil(total / limit);
  const formatted = await formatServices(items);
  const distances = distanceByProvider;

  return {
    items: distances
      ? formatted.map((service, index) => ({
          ...service,
          distanceKm: distances.get(items[index].providerId) ?? null,
        }))
      : formatted,
    total,
    page,
    limit,
    totalPages,
    hasNextPage: page < totalPages,
    hasPreviousPage: page > 1,
    matchType,
    searchedFor,
  };
};

/**
 * Get Nearby Services (Public)
 * Returns ACTIVE services from providers within radiusKm of (latitude, longitude),
 * with each service annotated with its provider's distance from the search point.
 * Sorted by distance ascending.
 */
export const getNearbyServices = async (input: {
  latitude: number;
  longitude: number;
  radiusKm?: number;
  categoryId?: string;
  minPrice?: number;
  maxPrice?: number;
  search?: string;
  pagination?: { page?: number; limit?: number };
  // Not exposed in GraphQL — populated by the resolver from auth context to
  // exclude the requesting provider's own services from the customer view.
  excludeProviderUserId?: string;
}) => {
  const { latitude, longitude, categoryId, minPrice, maxPrice, search, excludeProviderUserId } = input;
  const radius = Math.min(
    input.radiusKm ?? config.geo.defaultRadiusKm,
    config.geo.maxRadiusKm
  );
  const page = input.pagination?.page ?? 1;
  const rawLimit = input.pagination?.limit ?? 20;
  const limit = Math.min(rawLimit, config.pagination.maxLimit);

  // The viewer's own listings, and providers they've blocked
  const hiddenUserIds = excludeProviderUserId
    ? [excludeProviderUserId, ...(await getBlockedUserIds(excludeProviderUserId))]
    : [];

  // Resolve providers within radius
  const candidateProviders = await prisma.serviceProvider.findMany({
    where: {
      verificationStatus: VerificationStatus.VERIFIED,
      ...boundingBox(latitude, longitude, radius),
      ...(hiddenUserIds.length > 0 ? { userId: { notIn: hiddenUserIds } } : {}),
    },
    select: { id: true, latitude: true, longitude: true },
    take: MAX_NEARBY_CANDIDATES,
  });

  const distanceById = new Map<string, number>();
  for (const p of candidateProviders) {
    const d = haversineDistance(latitude, longitude, p.latitude!, p.longitude!);
    if (d <= radius) {
      distanceById.set(p.id, d);
    }
  }

  if (distanceById.size === 0) {
    return {
      ...emptyPage(page, limit),
      radiusKm: radius,
      searchLocation: { latitude, longitude },
    };
  }

  const where: Prisma.ServiceWhereInput = {
    status: ServiceStatus.ACTIVE,
    providerId: { in: Array.from(distanceById.keys()) },
  };

  if (categoryId) where.categoryId = categoryId;
  if (minPrice != null || maxPrice != null) {
    where.price = {
      ...(minPrice != null ? { gte: minPrice } : {}),
      ...(maxPrice != null ? { lte: maxPrice } : {}),
    };
  }
  if (search) {
    const sanitizedSearch = sanitizeSearchQuery(search);
    where.OR = [
      { name: { contains: sanitizedSearch, mode: 'insensitive' } },
      { description: { contains: sanitizedSearch, mode: 'insensitive' } },
    ];
  }

  // Fetch all matching, sort by distance, then paginate in-memory
  // (distance is computed per provider, can't be ordered by Prisma directly)
  const allMatches = await prisma.service.findMany({
    where,
    include: { provider: true, category: true },
    take: MAX_NEARBY_CANDIDATES,
  });

  const sorted = allMatches
    .map((s) => ({ service: s, distanceKm: distanceById.get(s.providerId)! }))
    .sort((a, b) => a.distanceKm - b.distanceKm);

  const total = sorted.length;
  const totalPages = Math.ceil(total / limit);
  const skip = (page - 1) * limit;
  const pageItems = sorted.slice(skip, skip + limit);
  const formatted = await formatServices(pageItems.map(({ service }) => service));

  return {
    items: formatted.map((service, index) => ({
      ...service,
      distanceKm: pageItems[index].distanceKm,
    })),
    total,
    page,
    limit,
    totalPages,
    hasNextPage: page < totalPages,
    hasPreviousPage: page > 1,
    radiusKm: radius,
    searchLocation: { latitude, longitude },
  };
};

/**
 * Get Service by ID
 *
 * An ACTIVE service is public, except between a viewer and a provider where
 * either has blocked the other. Services in any other status are only shown to
 * the owning provider and admins. Everyone else gets NOT_FOUND.
 */
export const getServiceById = async (serviceId: string, viewer?: ServiceViewer | null) => {
  const service = await findServiceWithRelations(serviceId);

  if (!service) {
    throw serviceNotFound();
  }

  const canSeeAnyStatus =
    isAdminRole(viewer?.role) || (viewer != null && service.provider.userId === viewer.userId);

  if (!canSeeAnyStatus) {
    if (service.status !== ServiceStatus.ACTIVE) {
      throw serviceNotFound();
    }

    if (viewer && (await isBlockedBetween(viewer.userId, service.provider.userId))) {
      throw serviceNotFound();
    }
  }

  return formatOneService(service);
};

/**
 * Get My Services (Provider)
 */
export const getMyServices = async (userId: string, pagination: { page: number; limit: number }) => {
  const provider = await getProviderForUser(userId);

  const { page, limit } = pagination;
  const skip = (page - 1) * limit;

  const [items, total] = await Promise.all([
    prisma.service.findMany({
      where: { providerId: provider.id },
      include: {
        provider: true,
        category: true,
      },
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
    }),
    prisma.service.count({
      where: { providerId: provider.id },
    }),
  ]);

  const totalPages = Math.ceil(total / limit);

  return {
    items: await formatServices(items),
    total,
    page,
    limit,
    totalPages,
    hasNextPage: page < totalPages,
    hasPreviousPage: page > 1,
  };
};

/**
 * Create Service (Provider)
 */
export const createService = async (userId: string, input: CreateServiceInput) => {
  const provider = await getProviderForUser(userId);

  // Check provider verification status
  if (provider.verificationStatus !== VerificationStatus.VERIFIED) {
    throw new GraphQLError('Your provider account must be verified to create services', {
      extensions: { code: 'PROVIDER_NOT_VERIFIED' },
    });
  }

  const { categoryId, name, description, price, duration, images } = input;

  // Sanitize and validate inputs
  const sanitizedName = validateBusinessName(name, 'Service name');
  const sanitizedDescription = validateText(
    sanitizeBasic(description),
    'Description',
    10,
    MAX_LENGTHS.DESCRIPTION
  );
  assertAcceptableText(sanitizedName, 'Service name');
  assertAcceptableText(sanitizedDescription, 'Description');
  const validatedPrice = validateAmount(price, 'Price');
  const validatedDuration = validateAmount(duration, 'Duration');
  const validatedImages = validateServiceImages(images);

  await assertTermsAccepted(userId);

  // Validate category exists
  const category = await prisma.serviceCategory.findUnique({
    where: { id: categoryId },
  });

  if (!category) {
    throw new GraphQLError('Category not found', {
      extensions: { code: 'CATEGORY_NOT_FOUND' },
    });
  }

  if (!category.isActive) {
    throw new GraphQLError('Cannot add services to an inactive category', {
      extensions: { code: 'CATEGORY_INACTIVE' },
    });
  }

  const slug = await uniqueServiceSlug(provider.id, sanitizedName);

  // Create service
  const service = await prisma.service.create({
    data: {
      providerId: provider.id,
      categoryId,
      name: sanitizedName,
      slug,
      description: sanitizedDescription,
      price: validatedPrice,
      duration: validatedDuration,
      images: validatedImages,
      status: ServiceStatus.DRAFT,
    },
    include: {
      provider: true,
      category: true,
    },
  });

  return formatOneService(service);
};

/**
 * Update Service (Provider)
 */
export const updateService = async (userId: string, serviceId: string, input: UpdateServiceInput) => {
  const provider = await getProviderForUser(userId);

  // Find service
  const service = await prisma.service.findUnique({
    where: { id: serviceId },
  });

  if (!service) {
    throw serviceNotFound();
  }

  // Check ownership
  if (service.providerId !== provider.id) {
    throw new GraphQLError('You can only update your own services', {
      extensions: { code: 'FORBIDDEN' },
    });
  }

  // Changing what customers see counts as posting
  if (input.name !== undefined || input.description !== undefined || input.images !== undefined) {
    await assertTermsAccepted(userId);
  }

  // Build update data
  const updateData: Prisma.ServiceUncheckedUpdateInput = {};

  // Moving to another category needs an active one; keeping the current one is fine
  if (input.categoryId != null && input.categoryId !== service.categoryId) {
    const category = await prisma.serviceCategory.findUnique({
      where: { id: input.categoryId },
    });

    if (!category) {
      throw new GraphQLError('Category not found', {
        extensions: { code: 'CATEGORY_NOT_FOUND' },
      });
    }

    if (!category.isActive) {
      throw new GraphQLError('Cannot add services to an inactive category', {
        extensions: { code: 'CATEGORY_INACTIVE' },
      });
    }

    updateData.categoryId = input.categoryId;
  }

  let newName: string | undefined;
  if (input.name !== undefined) {
    newName = validateBusinessName(input.name, 'Service name');
    assertAcceptableText(newName, 'Service name');
    updateData.name = newName;
  }

  if (input.description !== undefined) {
    const description = validateText(
      sanitizeBasic(input.description),
      'Description',
      10,
      MAX_LENGTHS.DESCRIPTION
    );
    assertAcceptableText(description, 'Description');
    updateData.description = description;
  }
  if (input.price !== undefined) updateData.price = validateAmount(input.price, 'Price');
  if (input.duration !== undefined) updateData.duration = validateAmount(input.duration, 'Duration');
  if (input.images !== undefined) updateData.images = validateServiceImages(input.images);

  // Status can only be changed to DRAFT or INACTIVE by provider
  if (input.status !== undefined) {
    // A suspension stays until an admin acts on it, so the provider can't
    // move the service out of it and resubmit
    if (service.status === ServiceStatus.SUSPENDED) {
      throw new GraphQLError("This service has been suspended by an admin, so its status can't be changed", {
        extensions: { code: 'SERVICE_SUSPENDED' },
      });
    }

    if (input.status !== ServiceStatus.DRAFT && input.status !== ServiceStatus.INACTIVE) {
      throw new GraphQLError('Invalid status. You can only set status to DRAFT or INACTIVE', {
        extensions: { code: 'INVALID_STATUS' },
      });
    }
    updateData.status = input.status;
  }

  // Once everything else is valid, give a renamed service a slug no other of
  // the provider's services uses
  if (newName !== undefined && newName !== service.name) {
    updateData.slug = await uniqueServiceSlug(provider.id, newName, service.id);
  }

  const updated = await prisma.service.update({
    where: { id: serviceId },
    data: updateData,
    include: {
      provider: true,
      category: true,
    },
  });

  // An approved listing stays live when edited, so admins get to check what
  // customers now see
  const listingChanged =
    updated.name !== service.name ||
    updated.description !== service.description ||
    JSON.stringify(updated.images) !== JSON.stringify(service.images);

  if (service.status === ServiceStatus.ACTIVE && listingChanged) {
    await flagContent({
      targetType: 'SERVICE',
      targetId: service.id,
      targetUserId: userId,
      reason: 'OTHER',
      details: 'Automatic: live listing edited after approval',
      snapshot: {
        before: { name: service.name, description: service.description, images: service.images },
        after: { name: updated.name, description: updated.description, images: updated.images },
      },
    });
  }

  return formatOneService(updated);
};

/**
 * Delete Service (Provider)
 */
export const deleteService = async (userId: string, serviceId: string) => {
  const provider = await getProviderForUser(userId);

  // Find service
  const service = await prisma.service.findUnique({
    where: { id: serviceId },
    include: {
      _count: { select: { bookings: true } },
    },
  });

  if (!service) {
    throw serviceNotFound();
  }

  // Check ownership
  if (service.providerId !== provider.id) {
    throw new GraphQLError('You can only delete your own services', {
      extensions: { code: 'FORBIDDEN' },
    });
  }

  // Check for active bookings
  if (service._count.bookings > 0) {
    throw new GraphQLError(
      `Cannot delete service with ${service._count.bookings} booking(s). Please set it to inactive instead.`,
      { extensions: { code: 'HAS_BOOKINGS' } }
    );
  }

  await prisma.service.delete({
    where: { id: serviceId },
  });

  return {
    success: true,
    message: `Service "${service.name}" has been deleted.`,
  };
};

/**
 * Submit Service for Approval (Provider)
 */
export const submitServiceForApproval = async (userId: string, serviceId: string) => {
  const provider = await getProviderForUser(userId);

  // Find service
  const service = await prisma.service.findUnique({
    where: { id: serviceId },
  });

  if (!service) {
    throw serviceNotFound();
  }

  // Check ownership
  if (service.providerId !== provider.id) {
    throw new GraphQLError('You can only submit your own services', {
      extensions: { code: 'FORBIDDEN' },
    });
  }

  // Check current status
  if (service.status !== ServiceStatus.DRAFT && service.status !== ServiceStatus.INACTIVE) {
    throw new GraphQLError('Only draft or inactive services can be submitted for approval', {
      extensions: { code: 'INVALID_STATUS' },
    });
  }

  const updated = await prisma.service.update({
    where: { id: serviceId },
    data: {
      status: ServiceStatus.PENDING_APPROVAL,
    },
    include: {
      provider: true,
      category: true,
    },
  });

  return formatOneService(updated);
};

// ==================
// Service Moderation (Admin)
// ==================

/**
 * Get Pending Services (Admin)
 */
export const getPendingServices = async (pagination: { page: number; limit: number }) => {
  const { page, limit } = pagination;
  const skip = (page - 1) * limit;

  const [items, total] = await Promise.all([
    prisma.service.findMany({
      where: {
        status: ServiceStatus.PENDING_APPROVAL,
      },
      include: {
        provider: true,
        category: true,
      },
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
    }),
    prisma.service.count({
      where: {
        status: ServiceStatus.PENDING_APPROVAL,
      },
    }),
  ]);

  const totalPages = Math.ceil(total / limit);

  return {
    items: await formatServices(items),
    total,
    page,
    limit,
    totalPages,
    hasNextPage: page < totalPages,
    hasPreviousPage: page > 1,
  };
};

const cannotApprove = () =>
  new GraphQLError('Only services that are pending approval or suspended can be approved', {
    extensions: { code: 'INVALID_STATUS' },
  });

const notPendingApproval = () =>
  new GraphQLError('Only services pending approval can be rejected', {
    extensions: { code: 'INVALID_STATUS' },
  });

const alreadySuspended = () =>
  new GraphQLError('Service is already suspended', {
    extensions: { code: 'ALREADY_SUSPENDED' },
  });

/**
 * Tell the provider about an admin's decision on their service, in the app and
 * by push
 */
const notifyServiceDecision = async (
  service: ServiceWithRelations,
  decision: ServiceDecision,
  reason = ''
) => {
  const userId = service.provider.userId;
  const { name } = service;

  const sendInApp: Record<ServiceDecision, () => Promise<unknown>> = {
    approved: () => notifyServiceApproved(userId, service.id, name),
    rejected: () => notifyServiceRejected(userId, service.id, name, reason),
    suspended: () =>
      createNotification({
        userId,
        type: NotificationType.SERVICE_SUSPENDED,
        title: 'Service Suspended',
        message: `Your service "${name}" has been suspended: ${reason}`,
        entityType: 'service',
        entityId: service.id,
      }),
    reinstated: () =>
      createNotification({
        userId,
        type: NotificationType.SERVICE_APPROVED,
        title: 'Service Reinstated',
        message: `Your service "${name}" has been reinstated and is live again`,
        entityType: 'service',
        entityId: service.id,
      }),
  };

  const push: Record<ServiceDecision, { title: string; message: string }> = {
    approved: { title: 'Service Approved', message: `Your service "${name}" has been approved and is now live` },
    rejected: { title: 'Service Rejected', message: `Your service "${name}" was rejected: ${reason}` },
    suspended: { title: 'Service Suspended', message: `Your service "${name}" has been suspended: ${reason}` },
    reinstated: { title: 'Service Reinstated', message: `Your service "${name}" has been reinstated and is live again` },
  };

  await notifySafely('service notification', sendInApp[decision]);
  await notifySafely('service push notification', () =>
    sendPushToUser(userId, {
      ...push[decision],
      data: { type: 'SERVICE', serviceId: service.id, action: decision },
    })
  );
};

/**
 * Approve Service (Admin). Makes a service pending approval live, or reinstates
 * a suspended one. Approval clears any rejection or suspension reason.
 */
export const approveService = async (serviceId: string, actor?: ModerationActor) => {
  const service = await prisma.service.findUnique({
    where: { id: serviceId },
  });

  if (!service) {
    throw serviceNotFound();
  }

  const isReinstatement = service.status === ServiceStatus.SUSPENDED;

  if (service.status !== ServiceStatus.PENDING_APPROVAL && !isReinstatement) {
    throw cannotApprove();
  }

  // Only while the status is still the one checked, in case another admin decided meanwhile
  const { count } = await prisma.service.updateMany({
    where: { id: serviceId, status: service.status },
    data: { status: ServiceStatus.ACTIVE, rejectionReason: null, suspensionReason: null },
  });

  if (count === 0) {
    throw cannotApprove();
  }

  const updated = await findServiceWithRelations(serviceId);
  if (!updated) {
    throw serviceNotFound();
  }

  await notifyServiceDecision(updated, isReinstatement ? 'reinstated' : 'approved');
  await recordModeration(actor, {
    action: 'APPROVE_SERVICE',
    targetType: 'Service',
    targetId: serviceId,
    previousValue: isReinstatement
      ? { status: service.status, suspensionReason: service.suspensionReason }
      : { status: service.status },
    newValue: { status: ServiceStatus.ACTIVE },
  });

  return formatOneService(updated);
};

/**
 * Reject Service (Admin). Sends a service pending approval back to DRAFT, with
 * the reason saved for the provider.
 */
export const rejectService = async (serviceId: string, reason: string, actor?: ModerationActor) => {
  const safeReason = validateModerationReason(reason);

  const service = await prisma.service.findUnique({
    where: { id: serviceId },
  });

  if (!service) {
    throw serviceNotFound();
  }

  if (service.status !== ServiceStatus.PENDING_APPROVAL) {
    throw notPendingApproval();
  }

  const { count } = await prisma.service.updateMany({
    where: { id: serviceId, status: ServiceStatus.PENDING_APPROVAL },
    data: { status: ServiceStatus.DRAFT, rejectionReason: safeReason },
  });

  if (count === 0) {
    throw notPendingApproval();
  }

  const updated = await findServiceWithRelations(serviceId);
  if (!updated) {
    throw serviceNotFound();
  }

  await notifyServiceDecision(updated, 'rejected', safeReason);
  await recordModeration(actor, {
    action: 'REJECT_SERVICE',
    targetType: 'Service',
    targetId: serviceId,
    previousValue: { status: service.status },
    newValue: { status: ServiceStatus.DRAFT },
    reason: safeReason,
  });

  return formatOneService(updated);
};

/**
 * Suspend Service (Admin, and report decisions). Takes down a service in any
 * status except SUSPENDED, with the reason saved for the provider. The audit
 * log is written when an actor is given.
 */
export const suspendService = async (serviceId: string, reason: string, actor?: ModerationActor) => {
  const safeReason = validateModerationReason(reason);

  const service = await prisma.service.findUnique({
    where: { id: serviceId },
  });

  if (!service) {
    throw serviceNotFound();
  }

  if (service.status === ServiceStatus.SUSPENDED) {
    throw alreadySuspended();
  }

  const { count } = await prisma.service.updateMany({
    where: { id: serviceId, status: { not: ServiceStatus.SUSPENDED } },
    data: { status: ServiceStatus.SUSPENDED, suspensionReason: safeReason },
  });

  if (count === 0) {
    throw alreadySuspended();
  }

  const updated = await findServiceWithRelations(serviceId);
  if (!updated) {
    throw serviceNotFound();
  }

  await notifyServiceDecision(updated, 'suspended', safeReason);
  await recordModeration(actor, {
    action: 'SUSPEND_SERVICE',
    targetType: 'Service',
    targetId: serviceId,
    previousValue: { status: service.status },
    newValue: { status: ServiceStatus.SUSPENDED },
    reason: safeReason,
  });

  return formatOneService(updated);
};
