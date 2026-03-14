/**
 * Favourite Service
 * Handles user favourite services operations
 * 
 * Features:
 * - Add service to favourites
 * - Remove service from favourites
 * - Get user's favourite services
 * - Check if service is favourited
 */

import { GraphQLError } from 'graphql';
import prisma from '@/lib/prisma';

// ==================
// Types
// ==================

interface FavouritePagination {
  page: number;
  limit: number;
}

// ==================
// Helper Functions
// ==================

/**
 * Format favourite response with service details
 */
const formatFavouriteResponse = (favourite: any) => ({
  id: favourite.id,
  createdAt: favourite.createdAt.toISOString(),
  service: favourite.service ? {
    id: favourite.service.id,
    name: favourite.service.name,
    slug: favourite.service.slug,
    description: favourite.service.description,
    price: favourite.service.price,
    duration: favourite.service.duration,
    status: favourite.service.status,
    images: favourite.service.images,
    createdAt: favourite.service.createdAt.toISOString(),
    updatedAt: favourite.service.updatedAt.toISOString(),
    category: favourite.service.category ? {
      id: favourite.service.category.id,
      name: favourite.service.category.name,
      slug: favourite.service.category.slug,
      icon: favourite.service.category.icon,
    } : null,
    provider: favourite.service.provider ? {
      id: favourite.service.provider.id,
      businessName: favourite.service.provider.businessName,
      verificationStatus: favourite.service.provider.verificationStatus,
      city: favourite.service.provider.city,
      state: favourite.service.provider.state,
      user: favourite.service.provider.user ? {
        id: favourite.service.provider.user.id,
        firstName: favourite.service.provider.user.firstName,
        lastName: favourite.service.provider.user.lastName,
      } : null,
    } : null,
  } : null,
});

// ==================
// Favourite Functions
// ==================

/**
 * Add a service to user's favourites
 */
export const addFavourite = async (userId: string, serviceId: string) => {
  // Check if service exists and is active
  const service = await prisma.service.findUnique({
    where: { id: serviceId },
    include: {
      category: true,
      provider: {
        include: { user: true },
      },
    },
  });

  if (!service) {
    throw new GraphQLError('Service not found', {
      extensions: { code: 'NOT_FOUND' },
    });
  }

  if (service.status !== 'ACTIVE') {
    throw new GraphQLError('Cannot favourite an inactive service', {
      extensions: { code: 'SERVICE_NOT_ACTIVE' },
    });
  }

  // Check if already favourited
  const existingFavourite = await prisma.favourite.findUnique({
    where: {
      userId_serviceId: {
        userId,
        serviceId,
      },
    },
  });

  if (existingFavourite) {
    throw new GraphQLError('Service is already in your favourites', {
      extensions: { code: 'ALREADY_FAVOURITED' },
    });
  }

  // Create favourite
  const favourite = await prisma.favourite.create({
    data: {
      userId,
      serviceId,
    },
    include: {
      service: {
        include: {
          category: true,
          provider: {
            include: { user: true },
          },
        },
      },
    },
  });

  return formatFavouriteResponse(favourite);
};

/**
 * Remove a service from user's favourites
 */
export const removeFavourite = async (userId: string, serviceId: string) => {
  // Check if favourite exists
  const favourite = await prisma.favourite.findUnique({
    where: {
      userId_serviceId: {
        userId,
        serviceId,
      },
    },
  });

  if (!favourite) {
    throw new GraphQLError('Service is not in your favourites', {
      extensions: { code: 'NOT_FAVOURITED' },
    });
  }

  // Delete favourite
  await prisma.favourite.delete({
    where: {
      userId_serviceId: {
        userId,
        serviceId,
      },
    },
  });

  return {
    success: true,
    message: 'Service removed from favourites successfully',
  };
};

/**
 * Get user's favourite services
 */
export const getUserFavourites = async (
  userId: string,
  pagination: FavouritePagination = { page: 1, limit: 10 }
) => {
  const { page, limit } = pagination;
  const skip = (page - 1) * limit;

  const [favourites, total] = await Promise.all([
    prisma.favourite.findMany({
      where: { userId },
      include: {
        service: {
          include: {
            category: true,
            provider: {
              include: { user: true },
            },
          },
        },
      },
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
    }),
    prisma.favourite.count({ where: { userId } }),
  ]);

  const totalPages = Math.ceil(total / limit);

  return {
    favourites: favourites.map(formatFavouriteResponse),
    total,
    page,
    limit,
    totalPages,
    hasNextPage: page < totalPages,
    hasPreviousPage: page > 1,
  };
};

/**
 * Check if a service is favourited by user
 */
export const isFavourited = async (userId: string, serviceId: string) => {
  const favourite = await prisma.favourite.findUnique({
    where: {
      userId_serviceId: {
        userId,
        serviceId,
      },
    },
  });

  return {
    isFavourited: !!favourite,
    favouriteId: favourite?.id || null,
  };
};

/**
 * Get favourite by ID
 */
export const getFavouriteById = async (userId: string, favouriteId: string) => {
  const favourite = await prisma.favourite.findUnique({
    where: { id: favouriteId },
    include: {
      service: {
        include: {
          category: true,
          provider: {
            include: { user: true },
          },
        },
      },
    },
  });

  if (!favourite) {
    throw new GraphQLError('Favourite not found', {
      extensions: { code: 'NOT_FOUND' },
    });
  }

  // Check if favourite belongs to user
  if (favourite.userId !== userId) {
    throw new GraphQLError('You can only view your own favourites', {
      extensions: { code: 'FORBIDDEN' },
    });
  }

  return formatFavouriteResponse(favourite);
};

/**
 * Toggle favourite status (add if not favourited, remove if favourited)
 */
export const toggleFavourite = async (userId: string, serviceId: string) => {
  // Check if service exists
  const service = await prisma.service.findUnique({
    where: { id: serviceId },
  });

  if (!service) {
    throw new GraphQLError('Service not found', {
      extensions: { code: 'NOT_FOUND' },
    });
  }

  // Check if already favourited
  const existingFavourite = await prisma.favourite.findUnique({
    where: {
      userId_serviceId: {
        userId,
        serviceId,
      },
    },
  });

  if (existingFavourite) {
    // Remove favourite
    await prisma.favourite.delete({
      where: {
        userId_serviceId: {
          userId,
          serviceId,
        },
      },
    });

    return {
      isFavourited: false,
      message: 'Service removed from favourites',
    };
  } else {
    // Check if service is active before adding
    if (service.status !== 'ACTIVE') {
      throw new GraphQLError('Cannot favourite an inactive service', {
        extensions: { code: 'SERVICE_NOT_ACTIVE' },
      });
    }

    // Add favourite
    await prisma.favourite.create({
      data: {
        userId,
        serviceId,
      },
    });

    return {
      isFavourited: true,
      message: 'Service added to favourites',
    };
  }
};

/**
 * Get count of favourites for a service (useful for popularity)
 */
export const getServiceFavouriteCount = async (serviceId: string) => {
  const count = await prisma.favourite.count({
    where: { serviceId },
  });

  return { count };
};
