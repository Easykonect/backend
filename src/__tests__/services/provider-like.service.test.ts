/**
 * Provider Like Service Tests
 * Tests for likeProvider, unlikeProvider, toggleProviderLike,
 * isProviderLiked, getProviderLikeCount, getMyLikedProviders
 */

import { GraphQLError } from 'graphql';

// Mock prisma before importing the service
jest.mock('@/lib/prisma', () => ({
  __esModule: true,
  default: {
    serviceProvider: {
      findUnique: jest.fn(),
    },
    providerLike: {
      findUnique: jest.fn(),
      create: jest.fn(),
      delete: jest.fn(),
      count: jest.fn(),
      findMany: jest.fn(),
    },
  },
}));

import prisma from '@/lib/prisma';
import {
  likeProvider,
  unlikeProvider,
  toggleProviderLike,
  isProviderLiked,
  getProviderLikeCount,
  getMyLikedProviders,
} from '@/services/user.service';

// ==================
// Test Data
// ==================

const mockUserId = '507f1f77bcf86cd799439011';
const mockProviderId = '507f1f77bcf86cd799439012';
const mockLikeId = '507f1f77bcf86cd799439013';

const mockProvider = {
  id: mockProviderId,
  businessName: 'Best Provider Co.',
};

const mockLike = {
  id: mockLikeId,
  userId: mockUserId,
  providerId: mockProviderId,
  createdAt: new Date('2026-01-01T10:00:00Z'),
};

const mockProviderFull = {
  id: mockProviderId,
  businessName: 'Best Provider Co.',
  businessDescription: 'We are the best',
  verificationStatus: 'VERIFIED',
  city: 'Lagos',
  state: 'Lagos',
  images: ['https://res.cloudinary.com/test/image/upload/v1/providers/img1.jpg'],
  user: {
    id: mockUserId,
    firstName: 'John',
    lastName: 'Doe',
    profilePhoto: null,
  },
  _count: {
    reviews: 5,
    likes: 3,
  },
};

const mockPrisma = prisma as jest.Mocked<typeof prisma>;

// ==================
// likeProvider
// ==================

describe('likeProvider', () => {
  beforeEach(() => jest.clearAllMocks());

  it('should like a provider successfully', async () => {
    (mockPrisma.serviceProvider.findUnique as jest.Mock).mockResolvedValue(mockProvider);
    (mockPrisma.providerLike.findUnique as jest.Mock).mockResolvedValue(null);
    (mockPrisma.providerLike.create as jest.Mock).mockResolvedValue(mockLike);
    (mockPrisma.providerLike.count as jest.Mock).mockResolvedValue(4);

    const result = await likeProvider(mockUserId, mockProviderId);

    expect(result.success).toBe(true);
    expect(result.message).toContain('Best Provider Co.');
    expect(result.likeCount).toBe(4);
    expect(mockPrisma.providerLike.create).toHaveBeenCalledWith({
      data: { userId: mockUserId, providerId: mockProviderId },
    });
  });

  it('should throw NOT_FOUND if provider does not exist', async () => {
    (mockPrisma.serviceProvider.findUnique as jest.Mock).mockResolvedValue(null);

    await expect(likeProvider(mockUserId, mockProviderId)).rejects.toThrow(GraphQLError);
    await expect(likeProvider(mockUserId, mockProviderId)).rejects.toMatchObject({
      extensions: { code: 'NOT_FOUND' },
    });
  });

  it('should throw ALREADY_LIKED if provider is already liked', async () => {
    (mockPrisma.serviceProvider.findUnique as jest.Mock).mockResolvedValue(mockProvider);
    (mockPrisma.providerLike.findUnique as jest.Mock).mockResolvedValue(mockLike);

    await expect(likeProvider(mockUserId, mockProviderId)).rejects.toThrow(GraphQLError);
    await expect(likeProvider(mockUserId, mockProviderId)).rejects.toMatchObject({
      extensions: { code: 'ALREADY_LIKED' },
    });
  });

  it('should not create like if provider does not exist', async () => {
    (mockPrisma.serviceProvider.findUnique as jest.Mock).mockResolvedValue(null);

    try {
      await likeProvider(mockUserId, mockProviderId);
    } catch {
      // expected
    }

    expect(mockPrisma.providerLike.create).not.toHaveBeenCalled();
  });
});

// ==================
// unlikeProvider
// ==================

describe('unlikeProvider', () => {
  beforeEach(() => jest.clearAllMocks());

  it('should unlike a provider successfully', async () => {
    (mockPrisma.serviceProvider.findUnique as jest.Mock).mockResolvedValue(mockProvider);
    (mockPrisma.providerLike.findUnique as jest.Mock).mockResolvedValue(mockLike);
    (mockPrisma.providerLike.delete as jest.Mock).mockResolvedValue(mockLike);
    (mockPrisma.providerLike.count as jest.Mock).mockResolvedValue(2);

    const result = await unlikeProvider(mockUserId, mockProviderId);

    expect(result.success).toBe(true);
    expect(result.message).toContain('Best Provider Co.');
    expect(result.likeCount).toBe(2);
    expect(mockPrisma.providerLike.delete).toHaveBeenCalledWith({
      where: {
        userId_providerId: { userId: mockUserId, providerId: mockProviderId },
      },
    });
  });

  it('should throw NOT_FOUND if provider does not exist', async () => {
    (mockPrisma.serviceProvider.findUnique as jest.Mock).mockResolvedValue(null);

    await expect(unlikeProvider(mockUserId, mockProviderId)).rejects.toMatchObject({
      extensions: { code: 'NOT_FOUND' },
    });
  });

  it('should throw NOT_LIKED if like does not exist', async () => {
    (mockPrisma.serviceProvider.findUnique as jest.Mock).mockResolvedValue(mockProvider);
    (mockPrisma.providerLike.findUnique as jest.Mock).mockResolvedValue(null);

    await expect(unlikeProvider(mockUserId, mockProviderId)).rejects.toMatchObject({
      extensions: { code: 'NOT_LIKED' },
    });
  });

  it('should not call delete if not liked', async () => {
    (mockPrisma.serviceProvider.findUnique as jest.Mock).mockResolvedValue(mockProvider);
    (mockPrisma.providerLike.findUnique as jest.Mock).mockResolvedValue(null);

    try {
      await unlikeProvider(mockUserId, mockProviderId);
    } catch {
      // expected
    }

    expect(mockPrisma.providerLike.delete).not.toHaveBeenCalled();
  });
});

// ==================
// toggleProviderLike
// ==================

describe('toggleProviderLike', () => {
  beforeEach(() => jest.clearAllMocks());

  it('should like a provider when not yet liked', async () => {
    (mockPrisma.serviceProvider.findUnique as jest.Mock).mockResolvedValue(mockProvider);
    (mockPrisma.providerLike.findUnique as jest.Mock).mockResolvedValue(null);
    (mockPrisma.providerLike.create as jest.Mock).mockResolvedValue(mockLike);
    (mockPrisma.providerLike.count as jest.Mock).mockResolvedValue(1);

    const result = await toggleProviderLike(mockUserId, mockProviderId);

    expect(result.isLiked).toBe(true);
    expect(result.likeCount).toBe(1);
    expect(result.message).toContain('liked');
    expect(mockPrisma.providerLike.create).toHaveBeenCalled();
    expect(mockPrisma.providerLike.delete).not.toHaveBeenCalled();
  });

  it('should unlike a provider when already liked', async () => {
    (mockPrisma.serviceProvider.findUnique as jest.Mock).mockResolvedValue(mockProvider);
    (mockPrisma.providerLike.findUnique as jest.Mock).mockResolvedValue(mockLike);
    (mockPrisma.providerLike.delete as jest.Mock).mockResolvedValue(mockLike);
    (mockPrisma.providerLike.count as jest.Mock).mockResolvedValue(0);

    const result = await toggleProviderLike(mockUserId, mockProviderId);

    expect(result.isLiked).toBe(false);
    expect(result.likeCount).toBe(0);
    expect(result.message).toContain('unliked');
    expect(mockPrisma.providerLike.delete).toHaveBeenCalled();
    expect(mockPrisma.providerLike.create).not.toHaveBeenCalled();
  });

  it('should throw NOT_FOUND if provider does not exist', async () => {
    (mockPrisma.serviceProvider.findUnique as jest.Mock).mockResolvedValue(null);

    await expect(toggleProviderLike(mockUserId, mockProviderId)).rejects.toMatchObject({
      extensions: { code: 'NOT_FOUND' },
    });
  });

  it('should return success:true on like toggle', async () => {
    (mockPrisma.serviceProvider.findUnique as jest.Mock).mockResolvedValue(mockProvider);
    (mockPrisma.providerLike.findUnique as jest.Mock).mockResolvedValue(null);
    (mockPrisma.providerLike.create as jest.Mock).mockResolvedValue(mockLike);
    (mockPrisma.providerLike.count as jest.Mock).mockResolvedValue(1);

    const result = await toggleProviderLike(mockUserId, mockProviderId);
    expect(result.success).toBe(true);
  });

  it('should return success:true on unlike toggle', async () => {
    (mockPrisma.serviceProvider.findUnique as jest.Mock).mockResolvedValue(mockProvider);
    (mockPrisma.providerLike.findUnique as jest.Mock).mockResolvedValue(mockLike);
    (mockPrisma.providerLike.delete as jest.Mock).mockResolvedValue(mockLike);
    (mockPrisma.providerLike.count as jest.Mock).mockResolvedValue(0);

    const result = await toggleProviderLike(mockUserId, mockProviderId);
    expect(result.success).toBe(true);
  });
});

// ==================
// isProviderLiked
// ==================

describe('isProviderLiked', () => {
  beforeEach(() => jest.clearAllMocks());

  it('should return true when provider is liked', async () => {
    (mockPrisma.providerLike.findUnique as jest.Mock).mockResolvedValue(mockLike);

    const result = await isProviderLiked(mockUserId, mockProviderId);

    expect(result).toBe(true);
    expect(mockPrisma.providerLike.findUnique).toHaveBeenCalledWith({
      where: {
        userId_providerId: { userId: mockUserId, providerId: mockProviderId },
      },
    });
  });

  it('should return false when provider is not liked', async () => {
    (mockPrisma.providerLike.findUnique as jest.Mock).mockResolvedValue(null);

    const result = await isProviderLiked(mockUserId, mockProviderId);

    expect(result).toBe(false);
  });
});

// ==================
// getProviderLikeCount
// ==================

describe('getProviderLikeCount', () => {
  beforeEach(() => jest.clearAllMocks());

  it('should return the like count for a provider', async () => {
    (mockPrisma.providerLike.count as jest.Mock).mockResolvedValue(7);

    const result = await getProviderLikeCount(mockProviderId);

    expect(result).toBe(7);
    expect(mockPrisma.providerLike.count).toHaveBeenCalledWith({
      where: { providerId: mockProviderId },
    });
  });

  it('should return 0 when no likes exist', async () => {
    (mockPrisma.providerLike.count as jest.Mock).mockResolvedValue(0);

    const result = await getProviderLikeCount(mockProviderId);

    expect(result).toBe(0);
  });
});

// ==================
// getMyLikedProviders
// ==================

describe('getMyLikedProviders', () => {
  beforeEach(() => jest.clearAllMocks());

  const mockLikeRecord = {
    id: mockLikeId,
    userId: mockUserId,
    providerId: mockProviderId,
    createdAt: new Date('2026-01-01T10:00:00Z'),
    provider: mockProviderFull,
  };

  it('should return paginated liked providers', async () => {
    (mockPrisma.providerLike.findMany as jest.Mock).mockResolvedValue([mockLikeRecord]);
    (mockPrisma.providerLike.count as jest.Mock).mockResolvedValue(1);

    const result = await getMyLikedProviders(mockUserId, { page: 1, limit: 10 });

    expect(result.items).toHaveLength(1);
    expect(result.items[0].provider.businessName).toBe('Best Provider Co.');
    expect(result.items[0].provider.likeCount).toBe(3);
    expect(result.items[0].provider.reviewCount).toBe(5);
    expect(result.pagination.total).toBe(1);
    expect(result.pagination.page).toBe(1);
    expect(result.pagination.totalPages).toBe(1);
    expect(result.pagination.hasNext).toBe(false);
    expect(result.pagination.hasPrev).toBe(false);
  });

  it('should use default pagination when not provided', async () => {
    (mockPrisma.providerLike.findMany as jest.Mock).mockResolvedValue([]);
    (mockPrisma.providerLike.count as jest.Mock).mockResolvedValue(0);

    const result = await getMyLikedProviders(mockUserId);

    expect(result.pagination.page).toBe(1);
    expect(result.pagination.limit).toBe(10);
    expect(result.items).toHaveLength(0);
  });

  it('should correctly calculate pagination for multiple pages', async () => {
    (mockPrisma.providerLike.findMany as jest.Mock).mockResolvedValue([mockLikeRecord]);
    (mockPrisma.providerLike.count as jest.Mock).mockResolvedValue(25);

    const result = await getMyLikedProviders(mockUserId, { page: 2, limit: 10 });

    expect(result.pagination.totalPages).toBe(3);
    expect(result.pagination.hasNext).toBe(true);
    expect(result.pagination.hasPrev).toBe(true);
  });

  it('should pass correct skip/take to prisma', async () => {
    (mockPrisma.providerLike.findMany as jest.Mock).mockResolvedValue([]);
    (mockPrisma.providerLike.count as jest.Mock).mockResolvedValue(0);

    await getMyLikedProviders(mockUserId, { page: 3, limit: 5 });

    expect(mockPrisma.providerLike.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 10, take: 5 })
    );
  });

  it('should query only the current user likes', async () => {
    (mockPrisma.providerLike.findMany as jest.Mock).mockResolvedValue([]);
    (mockPrisma.providerLike.count as jest.Mock).mockResolvedValue(0);

    await getMyLikedProviders(mockUserId, { page: 1, limit: 10 });

    expect(mockPrisma.providerLike.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: mockUserId } })
    );
  });

  it('should include provider with user and _count in results', async () => {
    (mockPrisma.providerLike.findMany as jest.Mock).mockResolvedValue([mockLikeRecord]);
    (mockPrisma.providerLike.count as jest.Mock).mockResolvedValue(1);

    const result = await getMyLikedProviders(mockUserId, { page: 1, limit: 10 });

    const item = result.items[0];
    expect(item.provider.user).toBeDefined();
    expect(item.provider.images).toBeDefined();
    expect(item.provider.city).toBe('Lagos');
    expect(item.likedAt).toBe('2026-01-01T10:00:00.000Z');
  });
});
