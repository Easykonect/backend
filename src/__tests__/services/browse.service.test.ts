/**
 * Browse Service Tests
 * Tests for browseProviders, getProviderPublicProfile, getNearbyProviders
 */

import { GraphQLError } from 'graphql';

// ==================
// Mocks
// ==================

jest.mock('@/lib/redis', () => ({
  __esModule: true,
  default: {
    getInstance: jest.fn().mockReturnValue({
      get: jest.fn(),
      set: jest.fn(),
      del: jest.fn(),
      incr: jest.fn(),
      expire: jest.fn(),
    }),
  },
}));

jest.mock('@/lib/prisma', () => ({
  __esModule: true,
  default: {
    serviceProvider: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      count: jest.fn(),
    },
    review: {
      groupBy: jest.fn(),
      aggregate: jest.fn(),
    },
  },
}));

jest.mock('@/config', () => ({
  config: {
    pagination: { defaultLimit: 10, maxLimit: 100 },
    geo: { defaultRadiusKm: 25, maxRadiusKm: 100 },
    redisUrl: 'redis://localhost:6379',
  },
}));

import prisma from '@/lib/prisma';
import {
  browseProviders,
  getProviderPublicProfile,
  getNearbyProviders,
  haversineDistance,
} from '@/services/browse.service';

// ==================
// Test Data
// ==================

const now = new Date('2025-01-15T10:00:00.000Z');

const makeProvider = (overrides: Partial<any> = {}) => ({
  id: '507f1f77bcf86cd799439011',
  businessName: 'Top Provider Ltd',
  businessDescription: 'A great provider',
  verificationStatus: 'VERIFIED',
  address: '1 Main St',
  city: 'Lagos',
  state: 'Lagos',
  country: 'Nigeria',
  latitude: 6.5244,
  longitude: 3.3792,
  images: ['https://res.cloudinary.com/test/image/upload/img1.jpg'],
  documents: [],
  services: [
    {
      category: { id: 'cat1', name: 'Cleaning', slug: 'cleaning' },
    },
  ],
  _count: { reviews: 5, likes: 12 },
  createdAt: now,
  updatedAt: now,
  user: {
    id: 'user1',
    firstName: 'John',
    lastName: 'Doe',
    profilePhoto: null,
  },
  ...overrides,
});

const makeRatingAgg = (providerId: string, avgRating: number) => ({
  providerId,
  _avg: { rating: avgRating },
});

// ==================
// haversineDistance
// ==================

describe('haversineDistance', () => {
  it('returns 0 for identical coordinates', () => {
    expect(haversineDistance(6.5244, 3.3792, 6.5244, 3.3792)).toBe(0);
  });

  it('returns the correct distance between two points', () => {
    // Lagos to Abuja is roughly 490–520 km
    const dist = haversineDistance(6.5244, 3.3792, 9.0765, 7.3986);
    expect(dist).toBeGreaterThan(450);
    expect(dist).toBeLessThan(560);
  });

  it('returns a value in km rounded to 1 decimal', () => {
    const dist = haversineDistance(6.5244, 3.3792, 6.5300, 3.3850);
    expect(dist.toString()).toMatch(/^\d+\.\d$/);
  });

  it('is symmetric — dist(A,B) == dist(B,A)', () => {
    const d1 = haversineDistance(6.5244, 3.3792, 9.0765, 7.3986);
    const d2 = haversineDistance(9.0765, 7.3986, 6.5244, 3.3792);
    expect(d1).toBe(d2);
  });
});

// ==================
// browseProviders
// ==================

describe('browseProviders', () => {
  const mockProvider = makeProvider();

  beforeEach(() => {
    jest.clearAllMocks();
    (prisma.serviceProvider.findMany as jest.Mock).mockResolvedValue([mockProvider]);
    (prisma.serviceProvider.count as jest.Mock).mockResolvedValue(1);
    (prisma.review.groupBy as jest.Mock).mockResolvedValue([
      makeRatingAgg(mockProvider.id, 4.5),
    ]);
  });

  it('returns paginated providers with default sort (NEWEST)', async () => {
    const result = await browseProviders({});
    expect(result.items).toHaveLength(1);
    expect(result.pagination.total).toBe(1);
    expect(result.pagination.page).toBe(1);
    expect(result.items[0].businessName).toBe('Top Provider Ltd');
  });

  it('attaches averageRating from review groupBy', async () => {
    const result = await browseProviders({});
    expect(result.items[0].averageRating).toBe(4.5);
  });

  it('attaches likeCount from _count.likes', async () => {
    const result = await browseProviders({});
    expect(result.items[0].likeCount).toBe(12);
  });

  it('attaches totalReviews from _count.reviews', async () => {
    const result = await browseProviders({});
    expect(result.items[0].totalReviews).toBe(5);
  });

  it('includes user info on each item', async () => {
    const result = await browseProviders({});
    expect(result.items[0].user).toMatchObject({
      id: 'user1',
      firstName: 'John',
      lastName: 'Doe',
    });
  });

  it('extracts unique category names from services', async () => {
    const result = await browseProviders({});
    expect(result.items[0].categories).toContain('Cleaning');
  });

  it('sorts by RATING_DESC correctly — higher rating first', async () => {
    const providerA = makeProvider({ id: 'a', businessName: 'Provider A', _count: { reviews: 2, likes: 1 } });
    const providerB = makeProvider({ id: 'b', businessName: 'Provider B', _count: { reviews: 3, likes: 2 } });
    (prisma.serviceProvider.findMany as jest.Mock).mockResolvedValue([providerA, providerB]);
    (prisma.serviceProvider.count as jest.Mock).mockResolvedValue(2);
    (prisma.review.groupBy as jest.Mock).mockResolvedValue([
      makeRatingAgg('a', 3.0),
      makeRatingAgg('b', 4.8),
    ]);

    const result = await browseProviders({ sortBy: 'RATING_DESC' });
    expect(result.items[0].businessName).toBe('Provider B');
    expect(result.items[1].businessName).toBe('Provider A');
  });

  it('sorts by POPULARITY_DESC (likes) correctly — more likes first', async () => {
    const providerA = makeProvider({ id: 'a', businessName: 'Provider A', _count: { reviews: 1, likes: 5 } });
    const providerB = makeProvider({ id: 'b', businessName: 'Provider B', _count: { reviews: 1, likes: 50 } });
    (prisma.serviceProvider.findMany as jest.Mock).mockResolvedValue([providerA, providerB]);
    (prisma.serviceProvider.count as jest.Mock).mockResolvedValue(2);
    (prisma.review.groupBy as jest.Mock).mockResolvedValue([]);

    const result = await browseProviders({ sortBy: 'POPULARITY_DESC' });
    expect(result.items[0].businessName).toBe('Provider B');
    expect(result.items[1].businessName).toBe('Provider A');
  });

  it('filters by minRating post-query', async () => {
    const providerA = makeProvider({ id: 'a', businessName: 'Low Rated', _count: { reviews: 2, likes: 1 } });
    const providerB = makeProvider({ id: 'b', businessName: 'High Rated', _count: { reviews: 5, likes: 10 } });
    (prisma.serviceProvider.findMany as jest.Mock).mockResolvedValue([providerA, providerB]);
    (prisma.serviceProvider.count as jest.Mock).mockResolvedValue(2);
    (prisma.review.groupBy as jest.Mock).mockResolvedValue([
      makeRatingAgg('a', 2.5),
      makeRatingAgg('b', 4.8),
    ]);

    const result = await browseProviders({ filters: { minRating: 4.0 } });
    expect(result.items).toHaveLength(1);
    expect(result.items[0].businessName).toBe('High Rated');
  });

  it('respects pagination — page 2 with limit 1', async () => {
    const p1 = makeProvider({ id: 'a', businessName: 'P1' });
    const p2 = makeProvider({ id: 'b', businessName: 'P2' });
    // For NEWEST, DB handles skip/take
    (prisma.serviceProvider.findMany as jest.Mock).mockResolvedValue([p2]);
    (prisma.serviceProvider.count as jest.Mock).mockResolvedValue(2);
    (prisma.review.groupBy as jest.Mock).mockResolvedValue([]);

    const result = await browseProviders({ pagination: { page: 2, limit: 1 } });
    expect(result.pagination.page).toBe(2);
    expect(result.pagination.hasNext).toBe(false);
    expect(result.pagination.hasPrev).toBe(true);
  });

  it('caps limit at config.pagination.maxLimit (100)', async () => {
    (prisma.serviceProvider.findMany as jest.Mock).mockResolvedValue([mockProvider]);
    (prisma.serviceProvider.count as jest.Mock).mockResolvedValue(1);

    const result = await browseProviders({ pagination: { page: 1, limit: 500 } });
    // The query is called with take: 100 (or undefined for computed sort)
    expect(result.pagination.limit).toBe(100);
  });

  it('returns distanceKm as null for browse (non-nearby)', async () => {
    const result = await browseProviders({});
    expect(result.items[0].distanceKm).toBeNull();
  });

  it('returns correct hasNext/hasPrev flags for single page', async () => {
    (prisma.serviceProvider.count as jest.Mock).mockResolvedValue(1);
    const result = await browseProviders({ pagination: { page: 1, limit: 10 } });
    expect(result.pagination.hasNext).toBe(false);
    expect(result.pagination.hasPrev).toBe(false);
  });

  it('returns empty items when no providers match', async () => {
    (prisma.serviceProvider.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.serviceProvider.count as jest.Mock).mockResolvedValue(0);
    (prisma.review.groupBy as jest.Mock).mockResolvedValue([]);

    const result = await browseProviders({});
    expect(result.items).toHaveLength(0);
    expect(result.pagination.total).toBe(0);
    expect(result.pagination.totalPages).toBe(0);
  });

  it('gives 0 rating to providers with no reviews', async () => {
    (prisma.review.groupBy as jest.Mock).mockResolvedValue([]);
    const result = await browseProviders({});
    expect(result.items[0].averageRating).toBe(0);
  });
});

// ==================
// getProviderPublicProfile
// ==================

describe('getProviderPublicProfile', () => {
  const mockProvider = makeProvider({
    services: [
      {
        id: 'svc1',
        name: 'Deep Cleaning',
        price: 5000,
        duration: 120,
        images: [],
        category: { id: 'cat1', name: 'Cleaning', slug: 'cleaning' },
      },
    ],
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns the provider profile with activeServices', async () => {
    (prisma.serviceProvider.findUnique as jest.Mock).mockResolvedValue(mockProvider);
    (prisma.review.aggregate as jest.Mock).mockResolvedValue({
      _avg: { rating: 4.2 },
      _count: { id: 3 },
    });

    const result = await getProviderPublicProfile(mockProvider.id);
    expect(result.id).toBe(mockProvider.id);
    expect(result.businessName).toBe('Top Provider Ltd');
    expect(result.averageRating).toBe(4.2);
    expect(result.totalReviews).toBe(3);
    expect(result.activeServices).toHaveLength(1);
    expect(result.activeServices[0].name).toBe('Deep Cleaning');
  });

  it('throws NOT_FOUND when provider does not exist', async () => {
    (prisma.serviceProvider.findUnique as jest.Mock).mockResolvedValue(null);

    await expect(getProviderPublicProfile('nonexistent')).rejects.toThrow(GraphQLError);
    await expect(getProviderPublicProfile('nonexistent')).rejects.toMatchObject({
      extensions: { code: 'NOT_FOUND' },
    });
  });

  it('returns 0 averageRating when no reviews exist', async () => {
    (prisma.serviceProvider.findUnique as jest.Mock).mockResolvedValue(mockProvider);
    (prisma.review.aggregate as jest.Mock).mockResolvedValue({
      _avg: { rating: null },
      _count: { id: 0 },
    });

    const result = await getProviderPublicProfile(mockProvider.id);
    expect(result.averageRating).toBe(0);
    expect(result.totalReviews).toBe(0);
  });

  it('rounds averageRating to 1 decimal place', async () => {
    (prisma.serviceProvider.findUnique as jest.Mock).mockResolvedValue(mockProvider);
    (prisma.review.aggregate as jest.Mock).mockResolvedValue({
      _avg: { rating: 4.666666 },
      _count: { id: 6 },
    });

    const result = await getProviderPublicProfile(mockProvider.id);
    expect(result.averageRating).toBe(4.7);
  });
});

// ==================
// getNearbyProviders
// ==================

describe('getNearbyProviders', () => {
  // Lagos coordinates
  const userLat = 6.5244;
  const userLng = 3.3792;

  // Provider very close to user (~2 km away)
  const nearbyProvider = makeProvider({
    id: 'near1',
    businessName: 'Nearby Provider',
    latitude: 6.5350,
    longitude: 3.3850,
    _count: { reviews: 4, likes: 8 },
  });

  // Provider far away (~500 km — Abuja)
  const farProvider = makeProvider({
    id: 'far1',
    businessName: 'Far Provider',
    latitude: 9.0765,
    longitude: 7.3986,
    _count: { reviews: 2, likes: 3 },
  });

  beforeEach(() => {
    jest.clearAllMocks();
    (prisma.serviceProvider.findMany as jest.Mock).mockResolvedValue([nearbyProvider, farProvider]);
    (prisma.review.groupBy as jest.Mock).mockResolvedValue([
      makeRatingAgg('near1', 4.0),
      makeRatingAgg('far1', 3.5),
    ]);
  });

  it('filters out providers outside the radius', async () => {
    const result = await getNearbyProviders({
      latitude: userLat,
      longitude: userLng,
      radiusKm: 25,
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0].businessName).toBe('Nearby Provider');
  });

  it('returns distanceKm for each provider', async () => {
    const result = await getNearbyProviders({
      latitude: userLat,
      longitude: userLng,
      radiusKm: 25,
    });
    expect(result.items[0].distanceKm).toBeGreaterThan(0);
    expect(result.items[0].distanceKm).toBeLessThan(25);
  });

  it('returns searchLocation and radiusKm in response', async () => {
    const result = await getNearbyProviders({
      latitude: userLat,
      longitude: userLng,
      radiusKm: 15,
    });
    expect(result.radiusKm).toBe(15);
    expect(result.searchLocation).toMatchObject({ latitude: userLat, longitude: userLng });
  });

  it('uses config.geo.defaultRadiusKm when no radiusKm provided', async () => {
    const result = await getNearbyProviders({
      latitude: userLat,
      longitude: userLng,
    });
    // defaultRadiusKm is 25, nearby provider is within 25 km
    expect(result.radiusKm).toBe(25);
    expect(result.items).toHaveLength(1);
  });

  it('caps radiusKm to config.geo.maxRadiusKm (100)', async () => {
    (prisma.serviceProvider.findMany as jest.Mock).mockResolvedValue([nearbyProvider, farProvider]);

    const result = await getNearbyProviders({
      latitude: userLat,
      longitude: userLng,
      radiusKm: 9999,
    });
    expect(result.radiusKm).toBe(100);
  });

  it('returns all providers within radius when radiusKm is large enough', async () => {
    const result = await getNearbyProviders({
      latitude: userLat,
      longitude: userLng,
      radiusKm: 100,
    });
    // far provider is ~500 km away, so still excluded at 100 km
    expect(result.items).toHaveLength(1);
  });

  it('sorts by RATING_DESC — higher rating first', async () => {
    const p1 = makeProvider({ id: 'p1', businessName: 'Low', latitude: 6.525, longitude: 3.380, _count: { reviews: 2, likes: 1 } });
    const p2 = makeProvider({ id: 'p2', businessName: 'High', latitude: 6.526, longitude: 3.381, _count: { reviews: 3, likes: 2 } });
    (prisma.serviceProvider.findMany as jest.Mock).mockResolvedValue([p1, p2]);
    (prisma.review.groupBy as jest.Mock).mockResolvedValue([
      makeRatingAgg('p1', 2.5),
      makeRatingAgg('p2', 4.9),
    ]);

    const result = await getNearbyProviders({
      latitude: userLat,
      longitude: userLng,
      radiusKm: 25,
      sortBy: 'RATING_DESC',
    });
    expect(result.items[0].businessName).toBe('High');
  });

  it('sorts by POPULARITY_DESC — more likes first', async () => {
    const p1 = makeProvider({ id: 'p1', businessName: 'Few Likes', latitude: 6.525, longitude: 3.380, _count: { reviews: 1, likes: 3 } });
    const p2 = makeProvider({ id: 'p2', businessName: 'Many Likes', latitude: 6.526, longitude: 3.381, _count: { reviews: 1, likes: 100 } });
    (prisma.serviceProvider.findMany as jest.Mock).mockResolvedValue([p1, p2]);
    (prisma.review.groupBy as jest.Mock).mockResolvedValue([]);

    const result = await getNearbyProviders({
      latitude: userLat,
      longitude: userLng,
      radiusKm: 25,
      sortBy: 'POPULARITY_DESC',
    });
    expect(result.items[0].businessName).toBe('Many Likes');
  });

  it('sorts by NAME_ASC alphabetically', async () => {
    const pZ = makeProvider({ id: 'pz', businessName: 'Zebra Services', latitude: 6.525, longitude: 3.380, _count: { reviews: 1, likes: 1 } });
    const pA = makeProvider({ id: 'pa', businessName: 'Ace Services', latitude: 6.526, longitude: 3.381, _count: { reviews: 1, likes: 1 } });
    (prisma.serviceProvider.findMany as jest.Mock).mockResolvedValue([pZ, pA]);
    (prisma.review.groupBy as jest.Mock).mockResolvedValue([]);

    const result = await getNearbyProviders({
      latitude: userLat,
      longitude: userLng,
      radiusKm: 25,
      sortBy: 'NAME_ASC',
    });
    expect(result.items[0].businessName).toBe('Ace Services');
  });

  it('sorts by distance (nearest first) when no sortBy given', async () => {
    const closer = makeProvider({ id: 'c', businessName: 'Closer', latitude: 6.525, longitude: 3.380, _count: { reviews: 1, likes: 1 } });
    const further = makeProvider({ id: 'f', businessName: 'Further', latitude: 6.560, longitude: 3.420, _count: { reviews: 1, likes: 1 } });
    (prisma.serviceProvider.findMany as jest.Mock).mockResolvedValue([further, closer]);
    (prisma.review.groupBy as jest.Mock).mockResolvedValue([]);

    const result = await getNearbyProviders({
      latitude: userLat,
      longitude: userLng,
      radiusKm: 25,
      sortBy: 'NEWEST',
    });
    // NEWEST for nearby defaults to distance sort
    expect(result.items[0].businessName).toBe('Closer');
  });

  it('returns empty when no providers are within radius', async () => {
    (prisma.serviceProvider.findMany as jest.Mock).mockResolvedValue([farProvider]);
    (prisma.review.groupBy as jest.Mock).mockResolvedValue([]);

    const result = await getNearbyProviders({
      latitude: userLat,
      longitude: userLng,
      radiusKm: 25,
    });
    expect(result.items).toHaveLength(0);
    expect(result.pagination.total).toBe(0);
  });

  it('paginates nearby results', async () => {
    const p1 = makeProvider({ id: 'p1', businessName: 'P1', latitude: 6.525, longitude: 3.380, _count: { reviews: 1, likes: 1 } });
    const p2 = makeProvider({ id: 'p2', businessName: 'P2', latitude: 6.526, longitude: 3.381, _count: { reviews: 1, likes: 1 } });
    const p3 = makeProvider({ id: 'p3', businessName: 'P3', latitude: 6.527, longitude: 3.382, _count: { reviews: 1, likes: 1 } });
    (prisma.serviceProvider.findMany as jest.Mock).mockResolvedValue([p1, p2, p3]);
    (prisma.review.groupBy as jest.Mock).mockResolvedValue([]);

    const result = await getNearbyProviders({
      latitude: userLat,
      longitude: userLng,
      radiusKm: 25,
      pagination: { page: 1, limit: 2 },
    });
    expect(result.items).toHaveLength(2);
    expect(result.pagination.total).toBe(3);
    expect(result.pagination.totalPages).toBe(2);
    expect(result.pagination.hasNext).toBe(true);
  });

  it('filters by minRating post-distance filter', async () => {
    const p1 = makeProvider({ id: 'p1', businessName: 'Low', latitude: 6.525, longitude: 3.380, _count: { reviews: 2, likes: 1 } });
    const p2 = makeProvider({ id: 'p2', businessName: 'High', latitude: 6.526, longitude: 3.381, _count: { reviews: 3, likes: 2 } });
    (prisma.serviceProvider.findMany as jest.Mock).mockResolvedValue([p1, p2]);
    (prisma.review.groupBy as jest.Mock).mockResolvedValue([
      makeRatingAgg('p1', 2.0),
      makeRatingAgg('p2', 4.5),
    ]);

    const result = await getNearbyProviders({
      latitude: userLat,
      longitude: userLng,
      radiusKm: 25,
      filters: { minRating: 4.0 },
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0].businessName).toBe('High');
  });
});
