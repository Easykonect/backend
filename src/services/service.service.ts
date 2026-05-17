/**
 * Service Management Service
 * Handles service CRUD operations for providers
 */

import { GraphQLError } from 'graphql';
import prisma from '@/lib/prisma';
import { config } from '@/config';
import { UserRole, ServiceStatus, VerificationStatus, type ServiceStatusType } from '@/constants';
import { sanitizeStrict, sanitizeBasic, validateName, validateText, validateAmount, sanitizeSearchQuery, MAX_LENGTHS } from '@/utils/security';
import { haversineDistance } from '@/services/browse.service';

// ==================
// Types
// ==================

interface CreateServiceInput {
  categoryId: string;
  name: string;
  description: string;
  price: number;
  duration: number;
  images?: string[];
}

interface UpdateServiceInput {
  categoryId?: string;
  name?: string;
  description?: string;
  price?: number;
  duration?: number;
  images?: string[];
  status?: ServiceStatusType;
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
  // Not exposed in GraphQL — populated by the resolver from the auth context
  // so that a logged-in provider doesn't see their own services in the
  // customer-facing service list.
  excludeProviderUserId?: string;
}

// ==================
// Helper Functions
// ==================

/**
 * Generate slug from name
 */
const generateSlug = (name: string): string => {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
};

/**
 * Format service response
 */
const formatService = (service: any) => ({
  id: service.id,
  provider: service.provider ? {
    id: service.provider.id,
    businessName: service.provider.businessName,
    businessDescription: service.provider.businessDescription,
    verificationStatus: service.provider.verificationStatus,
    address: service.provider.address,
    city: service.provider.city,
    state: service.provider.state,
    country: service.provider.country,
    latitude: service.provider.latitude,
    longitude: service.provider.longitude,
    documents: service.provider.documents,
    createdAt: service.provider.createdAt.toISOString(),
    updatedAt: service.provider.updatedAt.toISOString(),
  } : null,
  category: service.category ? {
    id: service.category.id,
    name: service.category.name,
    slug: service.category.slug,
    description: service.category.description,
    icon: service.category.icon,
    isActive: service.category.isActive,
    createdAt: service.category.createdAt.toISOString(),
    updatedAt: service.category.updatedAt.toISOString(),
  } : null,
  name: service.name,
  slug: service.slug,
  description: service.description,
  price: service.price,
  duration: service.duration,
  status: service.status,
  images: service.images,
  createdAt: service.createdAt.toISOString(),
  updatedAt: service.updatedAt.toISOString(),
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
 */
export const getServices = async (
  filters: ServiceFiltersInput = {},
  pagination: { page: number; limit: number },
  includeNonActive = false
) => {
  const { page, limit } = pagination;
  const skip = (page - 1) * limit;

  // Build where clause
  const where: any = {};

  // Only show active services for public queries
  if (!includeNonActive) {
    where.status = ServiceStatus.ACTIVE;
  } else if (filters.status) {
    where.status = filters.status;
  }

  if (filters.categoryId) {
    where.categoryId = filters.categoryId;
  }

  if (filters.providerId) {
    where.providerId = filters.providerId;
  }

  if (filters.minPrice !== undefined || filters.maxPrice !== undefined) {
    where.price = {};
    if (filters.minPrice !== undefined) where.price.gte = filters.minPrice;
    if (filters.maxPrice !== undefined) where.price.lte = filters.maxPrice;
  }

  if (filters.search) {
    // Sanitize search query to prevent NoSQL injection
    const sanitizedSearch = sanitizeSearchQuery(filters.search);
    where.OR = [
      { name: { contains: sanitizedSearch, mode: 'insensitive' } },
      { description: { contains: sanitizedSearch, mode: 'insensitive' } },
    ];
  }

  // Provider-relation filters (city, state, geo radius, exclude-self)
  const providerWhere: any = {};
  if (filters.city) {
    providerWhere.city = { equals: sanitizeSearchQuery(filters.city), mode: 'insensitive' };
  }
  if (filters.state) {
    providerWhere.state = { equals: sanitizeSearchQuery(filters.state), mode: 'insensitive' };
  }
  if (filters.excludeProviderUserId) {
    providerWhere.userId = { not: filters.excludeProviderUserId };
  }

  // Geo radius requires lat + lon. radiusKm falls back to config default.
  const hasGeo =
    filters.latitude !== undefined && filters.longitude !== undefined;
  if (hasGeo) {
    const radius = Math.min(
      filters.radiusKm ?? config.geo.defaultRadiusKm,
      config.geo.maxRadiusKm
    );

    // Resolve qualifying provider IDs by haversine, then constrain the service query.
    const candidateProviders = await prisma.serviceProvider.findMany({
      where: {
        ...providerWhere,
        latitude: { not: null },
        longitude: { not: null },
      },
      select: { id: true, latitude: true, longitude: true },
    });

    const nearbyIds = candidateProviders
      .filter((p) =>
        haversineDistance(filters.latitude!, filters.longitude!, p.latitude!, p.longitude!) <= radius
      )
      .map((p) => p.id);

    if (nearbyIds.length === 0) {
      return {
        items: [],
        total: 0,
        page,
        limit,
        totalPages: 0,
        hasNextPage: false,
        hasPreviousPage: false,
      };
    }

    if (where.providerId) {
      // Intersect explicit providerId with the geo set
      where.providerId = nearbyIds.includes(where.providerId) ? where.providerId : '__no_match__';
    } else {
      where.providerId = { in: nearbyIds };
    }
  } else if (Object.keys(providerWhere).length > 0) {
    // city/state without geo: filter via provider relation
    where.provider = { is: providerWhere };
  }

  const [items, total] = await Promise.all([
    prisma.service.findMany({
      where,
      include: {
        provider: true,
        category: true,
      },
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
    }),
    prisma.service.count({ where }),
  ]);

  const totalPages = Math.ceil(total / limit);

  return {
    items: items.map(formatService),
    total,
    page,
    limit,
    totalPages,
    hasNextPage: page < totalPages,
    hasPreviousPage: page > 1,
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

  // Resolve providers within radius
  const candidateProviders = await prisma.serviceProvider.findMany({
    where: {
      verificationStatus: VerificationStatus.VERIFIED,
      latitude: { not: null },
      longitude: { not: null },
      ...(excludeProviderUserId ? { userId: { not: excludeProviderUserId } } : {}),
    },
    select: { id: true, latitude: true, longitude: true },
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
      items: [],
      total: 0,
      page,
      limit,
      totalPages: 0,
      hasNextPage: false,
      hasPreviousPage: false,
      radiusKm: radius,
      searchLocation: { latitude, longitude },
    };
  }

  const where: any = {
    status: ServiceStatus.ACTIVE,
    providerId: { in: Array.from(distanceById.keys()) },
  };

  if (categoryId) where.categoryId = categoryId;
  if (minPrice !== undefined || maxPrice !== undefined) {
    where.price = {};
    if (minPrice !== undefined) where.price.gte = minPrice;
    if (maxPrice !== undefined) where.price.lte = maxPrice;
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
  });

  const sorted = allMatches
    .map((s) => ({ service: s, distanceKm: distanceById.get(s.providerId)! }))
    .sort((a, b) => a.distanceKm - b.distanceKm);

  const total = sorted.length;
  const totalPages = Math.ceil(total / limit);
  const skip = (page - 1) * limit;
  const pageItems = sorted.slice(skip, skip + limit);

  return {
    items: pageItems.map(({ service, distanceKm }) => ({
      ...formatService(service),
      distanceKm,
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
 */
export const getServiceById = async (serviceId: string) => {
  const service = await prisma.service.findUnique({
    where: { id: serviceId },
    include: {
      provider: true,
      category: true,
    },
  });

  if (!service) {
    throw new GraphQLError('Service not found', {
      extensions: { code: 'NOT_FOUND' },
    });
  }

  return formatService(service);
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
    items: items.map(formatService),
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
  const sanitizedName = validateName(name, 'Service name');
  const sanitizedDescription = validateText(
    sanitizeBasic(description),
    'Description',
    10,
    MAX_LENGTHS.DESCRIPTION
  );
  const validatedPrice = validateAmount(price, 'Price');
  const validatedDuration = validateAmount(duration, 'Duration');

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

  // Generate slug
  const baseSlug = generateSlug(sanitizedName);
  
  // Check for duplicate slug for this provider
  const existingService = await prisma.service.findFirst({
    where: {
      providerId: provider.id,
      slug: baseSlug,
    },
  });

  const slug = existingService
    ? `${baseSlug}-${Date.now()}`
    : baseSlug;

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
      images: images || [],
      status: ServiceStatus.DRAFT,
    },
    include: {
      provider: true,
      category: true,
    },
  });

  return formatService(service);
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
    throw new GraphQLError('Service not found', {
      extensions: { code: 'NOT_FOUND' },
    });
  }

  // Check ownership
  if (service.providerId !== provider.id) {
    throw new GraphQLError('You can only update your own services', {
      extensions: { code: 'FORBIDDEN' },
    });
  }

  // Build update data
  const updateData: any = {};

  if (input.categoryId !== undefined) {
    // Validate category
    const category = await prisma.serviceCategory.findUnique({
      where: { id: input.categoryId },
    });

    if (!category) {
      throw new GraphQLError('Category not found', {
        extensions: { code: 'CATEGORY_NOT_FOUND' },
      });
    }

    updateData.categoryId = input.categoryId;
  }

  if (input.name !== undefined) {
    updateData.name = validateName(input.name, 'Service name');
    updateData.slug = generateSlug(updateData.name);
  }

  if (input.description !== undefined) {
    updateData.description = validateText(
      sanitizeBasic(input.description),
      'Description',
      10,
      MAX_LENGTHS.DESCRIPTION
    );
  }
  if (input.price !== undefined) updateData.price = validateAmount(input.price, 'Price');
  if (input.duration !== undefined) updateData.duration = validateAmount(input.duration, 'Duration');
  if (input.images !== undefined) updateData.images = input.images;
  
  // Status can only be changed to DRAFT or INACTIVE by provider
  if (input.status !== undefined) {
    if (input.status !== ServiceStatus.DRAFT && input.status !== ServiceStatus.INACTIVE) {
      throw new GraphQLError('Invalid status. You can only set status to DRAFT or INACTIVE', {
        extensions: { code: 'INVALID_STATUS' },
      });
    }
    updateData.status = input.status;
  }

  const updated = await prisma.service.update({
    where: { id: serviceId },
    data: updateData,
    include: {
      provider: true,
      category: true,
    },
  });

  return formatService(updated);
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
    throw new GraphQLError('Service not found', {
      extensions: { code: 'NOT_FOUND' },
    });
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
    throw new GraphQLError('Service not found', {
      extensions: { code: 'NOT_FOUND' },
    });
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

  return formatService(updated);
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
    items: items.map(formatService),
    total,
    page,
    limit,
    totalPages,
    hasNextPage: page < totalPages,
    hasPreviousPage: page > 1,
  };
};

/**
 * Approve Service (Admin)
 */
export const approveService = async (serviceId: string) => {
  const service = await prisma.service.findUnique({
    where: { id: serviceId },
  });

  if (!service) {
    throw new GraphQLError('Service not found', {
      extensions: { code: 'NOT_FOUND' },
    });
  }

  const updated = await prisma.service.update({
    where: { id: serviceId },
    data: {
      status: ServiceStatus.ACTIVE,
    },
    include: {
      provider: true,
      category: true,
    },
  });

  // TODO: Send approval notification to provider

  return formatService(updated);
};

/**
 * Reject Service (Admin)
 */
export const rejectService = async (serviceId: string, reason: string) => {
  const service = await prisma.service.findUnique({
    where: { id: serviceId },
  });

  if (!service) {
    throw new GraphQLError('Service not found', {
      extensions: { code: 'NOT_FOUND' },
    });
  }

  const updated = await prisma.service.update({
    where: { id: serviceId },
    data: {
      status: ServiceStatus.DRAFT,
    },
    include: {
      provider: true,
      category: true,
    },
  });

  // TODO: Send rejection notification with reason

  return formatService(updated);
};

/**
 * Suspend Service (Admin)
 */
export const suspendService = async (serviceId: string, reason: string) => {
  const service = await prisma.service.findUnique({
    where: { id: serviceId },
  });

  if (!service) {
    throw new GraphQLError('Service not found', {
      extensions: { code: 'NOT_FOUND' },
    });
  }

  const updated = await prisma.service.update({
    where: { id: serviceId },
    data: {
      status: ServiceStatus.SUSPENDED,
    },
    include: {
      provider: true,
      category: true,
    },
  });

  // TODO: Send suspension notification with reason

  return formatService(updated);
};
