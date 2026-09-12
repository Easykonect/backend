/**
 * Browse service: who can open a provider profile, full categories on it,
 * minRating applied in the query, and how nearby searches choose and sort
 * providers
 */

jest.mock('@/lib/redis', () => ({ __esModule: true, default: { getInstance: jest.fn() } }));

jest.mock('@/lib/prisma', () => ({
  __esModule: true,
  default: {
    serviceProvider: { findMany: jest.fn(), findUnique: jest.fn(), count: jest.fn() },
    review: { groupBy: jest.fn(), aggregate: jest.fn() },
    userBlock: { findMany: jest.fn(), findFirst: jest.fn() },
  },
}));

jest.mock('@/config', () => ({
  config: {
    pagination: { defaultLimit: 10, maxLimit: 100 },
    geo: { defaultRadiusKm: 25, maxRadiusKm: 100 },
  },
}));

import prisma from '@/lib/prisma';
import {
  boundingBox,
  browseProviders,
  getNearbyProviders,
  getProviderPublicProfile,
  minimumAverageFor,
  MAX_NEARBY_CANDIDATES,
} from '@/services/browse.service';

const db = prisma as unknown as {
  serviceProvider: Record<'findMany' | 'findUnique' | 'count', jest.Mock>;
  review: Record<'groupBy' | 'aggregate', jest.Mock>;
  userBlock: Record<'findMany' | 'findFirst', jest.Mock>;
};

const providerId = '650a3b7c9d2e1f4a5b6c7d80';
const ownerId = '64f1c2a9e4b0a1b2c3d4e5f6';
const viewerId = '64f1c2a9e4b0a1b2c3d4e5f7';
const createdAt = new Date('2026-01-01T00:00:00.000Z');

// Reviews that count: not removed by an admin
const notRemoved = { OR: [{ deletedAt: null }, { deletedAt: { isSet: false } }] };

const category = {
  id: '64e0b1a2c3d4e5f6a7b8c9d0',
  name: 'Plumbing',
  slug: 'plumbing',
  description: 'Pipes, taps and pumps',
  icon: 'wrench',
  isActive: true,
  createdAt,
  updatedAt: createdAt,
};

const providerRow = (overrides: Record<string, unknown> = {}) => ({
  id: providerId,
  userId: ownerId,
  businessName: 'Chidi Okeke Plumbing',
  businessDescription: null,
  verificationStatus: 'VERIFIED',
  address: '14 Admiralty Way',
  city: 'Lekki',
  state: 'Lagos',
  country: 'Nigeria',
  latitude: 6.4474,
  longitude: 3.4739,
  images: [],
  documents: [],
  createdAt,
  updatedAt: createdAt,
  user: { id: ownerId, firstName: 'Chidi', lastName: 'Okeke', profilePhoto: null },
  services: [
    { id: '651b4c8d0e3f2a5b6c7d8e91', name: 'Leaking Pipe Repair', price: 15000, duration: 90, images: [], category },
  ],
  _count: { reviews: 0, likes: 0 },
  ...overrides,
});

beforeEach(() => {
  jest.resetAllMocks();
  db.review.aggregate.mockResolvedValue({ _avg: { rating: null }, _count: { id: 0 } });
  db.review.groupBy.mockResolvedValue([]);
  db.userBlock.findMany.mockResolvedValue([]);
  db.userBlock.findFirst.mockResolvedValue(null);
});

// ==================
// providerProfile visibility
// ==================

describe('getProviderPublicProfile visibility', () => {
  it.each(['UNVERIFIED', 'PENDING', 'REJECTED'])(
    'hides a %s provider from signed-out visitors and other users',
    async (verificationStatus) => {
      db.serviceProvider.findUnique.mockResolvedValue(providerRow({ verificationStatus }));

      await expect(getProviderPublicProfile(providerId)).rejects.toMatchObject({
        message: 'Provider not found',
        extensions: { code: 'NOT_FOUND' },
      });
      await expect(
        getProviderPublicProfile(providerId, { userId: viewerId, role: 'SERVICE_PROVIDER' })
      ).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } });
      expect(db.review.aggregate).not.toHaveBeenCalled();
    }
  );

  it('shows an unverified profile to the provider who owns it', async () => {
    db.serviceProvider.findUnique.mockResolvedValue(providerRow({ verificationStatus: 'PENDING' }));

    await expect(
      getProviderPublicProfile(providerId, { userId: ownerId, role: 'SERVICE_PROVIDER' })
    ).resolves.toMatchObject({ id: providerId, verificationStatus: 'PENDING' });
  });

  it.each(['ADMIN', 'SUPER_ADMIN'])('shows any profile to %s, whatever the blocks', async (role) => {
    db.serviceProvider.findUnique.mockResolvedValue(providerRow({ verificationStatus: 'REJECTED' }));
    db.userBlock.findFirst.mockResolvedValue({ id: 'block' });

    await expect(getProviderPublicProfile(providerId, { userId: viewerId, role })).resolves.toMatchObject({
      verificationStatus: 'REJECTED',
    });
    expect(db.userBlock.findFirst).not.toHaveBeenCalled();
  });

  it('hides a verified provider when either of the two has blocked the other', async () => {
    db.serviceProvider.findUnique.mockResolvedValue(providerRow());
    db.userBlock.findFirst.mockResolvedValue({ id: 'block' });

    await expect(
      getProviderPublicProfile(providerId, { userId: viewerId, role: 'SERVICE_USER' })
    ).rejects.toMatchObject({ message: 'Provider not found', extensions: { code: 'NOT_FOUND' } });

    expect(db.userBlock.findFirst).toHaveBeenCalledWith({
      where: {
        OR: [
          { blockerId: viewerId, blockedId: ownerId },
          { blockerId: ownerId, blockedId: viewerId },
        ],
      },
      select: { id: true },
    });
  });

  it('shows a verified provider to a signed-in user with no block', async () => {
    db.serviceProvider.findUnique.mockResolvedValue(providerRow());

    await expect(
      getProviderPublicProfile(providerId, { userId: viewerId, role: 'SERVICE_USER' })
    ).resolves.toMatchObject({ id: providerId });
  });

  it('shows a verified provider to signed-out visitors without looking up blocks', async () => {
    db.serviceProvider.findUnique.mockResolvedValue(providerRow());

    await expect(getProviderPublicProfile(providerId, null)).resolves.toMatchObject({ id: providerId });
    expect(db.userBlock.findFirst).not.toHaveBeenCalled();
  });
});

describe('getProviderPublicProfile active service categories', () => {
  it('loads every category field', async () => {
    db.serviceProvider.findUnique.mockResolvedValue(providerRow());

    const profile = await getProviderPublicProfile(providerId);

    expect(db.serviceProvider.findUnique.mock.calls[0][0].include.services.select.category).toBe(true);
    expect(profile.activeServices[0].category).toEqual(category);
  });
});

// ==================
// minRating
// ==================

describe('minimumAverageFor', () => {
  it.each([
    [4, 3.95],
    [4.2, 4.15],
    [0.7, 0.65],
    [4.23, 4.25],
    [5, 4.95],
  ])('minRating %p matches averages from %p (shown rounded to 1 decimal place)', (minRating, expected) => {
    expect(minimumAverageFor(minRating)).toBeCloseTo(expected, 10);
  });
});

describe('browseProviders', () => {
  beforeEach(() => {
    db.serviceProvider.findMany.mockResolvedValue([]);
    db.serviceProvider.count.mockResolvedValue(0);
  });

  it('applies minRating in the query for every sort, so pages are full and totals are right', async () => {
    db.review.groupBy.mockResolvedValueOnce([{ providerId: 'rated-1' }, { providerId: 'rated-2' }]);
    db.serviceProvider.count.mockResolvedValue(2);

    const result = await browseProviders({
      filters: { minRating: 4 },
      sortBy: 'NAME_ASC',
      pagination: { page: 1, limit: 1 },
    });

    expect(db.review.groupBy).toHaveBeenNthCalledWith(1, {
      by: ['providerId'],
      where: notRemoved,
      having: { rating: { _avg: { gte: 3.95 } } },
    });
    const query = db.serviceProvider.findMany.mock.calls[0][0];
    expect(query.where.id).toEqual({ in: ['rated-1', 'rated-2'] });
    expect(query.take).toBe(1);
    expect(db.serviceProvider.count.mock.calls[0][0].where.id).toEqual({ in: ['rated-1', 'rated-2'] });
    expect(result).toMatchObject({ total: 2, totalPages: 2, hasNextPage: true });
  });

  it('does not filter by rating when minRating is 0', async () => {
    await browseProviders({ filters: { minRating: 0 } });

    expect(db.serviceProvider.findMany.mock.calls[0][0].where.id).toBeUndefined();
    expect(db.review.groupBy).toHaveBeenCalledTimes(1);
    expect(db.review.groupBy.mock.calls[0][0].having).toBeUndefined();
  });

  it('breaks ties by ID so pages never overlap', async () => {
    await browseProviders({ sortBy: 'NAME_ASC' });
    await browseProviders({ sortBy: 'NEWEST' });
    await browseProviders({ sortBy: 'RATING_DESC' });

    const orders = db.serviceProvider.findMany.mock.calls.map(([args]) => args.orderBy);
    expect(orders).toEqual([
      [{ businessName: 'asc' }, { id: 'asc' }],
      [{ createdAt: 'desc' }, { id: 'desc' }],
      [{ createdAt: 'desc' }, { id: 'desc' }],
    ]);
  });
});

// ==================
// nearbyProviders
// ==================

describe('getNearbyProviders', () => {
  const latitude = 6.4281;
  const longitude = 3.4219;

  const nearbyRow = (id: string, businessName: string, lat: number, lng: number, created: string) =>
    providerRow({
      id,
      businessName,
      latitude: lat,
      longitude: lng,
      createdAt: new Date(created),
      updatedAt: new Date(created),
      services: [],
    });

  // About 0.1 km and 6 km from the search point
  const nearOld = nearbyRow('a1', 'Near but older', 6.429, 3.4225, '2026-01-01T00:00:00.000Z');
  const farNew = nearbyRow('a2', 'Far but newer', 6.47, 3.46, '2026-06-01T00:00:00.000Z');

  it('sorts NEWEST by creation date, newest first', async () => {
    db.serviceProvider.findMany.mockResolvedValue([nearOld, farNew]);

    const result = await getNearbyProviders({ latitude, longitude, radiusKm: 25, sortBy: 'NEWEST' });

    expect(result.items.map((p) => p.businessName)).toEqual(['Far but newer', 'Near but older']);
  });

  it('sorts NEAREST by distance', async () => {
    db.serviceProvider.findMany.mockResolvedValue([farNew, nearOld]);

    const result = await getNearbyProviders({ latitude, longitude, radiusKm: 25, sortBy: 'NEAREST' });

    expect(result.items.map((p) => p.businessName)).toEqual(['Near but older', 'Far but newer']);
  });

  it('breaks rating ties by distance', async () => {
    db.serviceProvider.findMany.mockResolvedValue([farNew, nearOld]);
    db.review.groupBy.mockResolvedValue([
      { providerId: 'a1', _avg: { rating: 4.5 } },
      { providerId: 'a2', _avg: { rating: 4.5 } },
    ]);

    const result = await getNearbyProviders({ latitude, longitude, radiusKm: 25, sortBy: 'RATING_DESC' });

    expect(result.items.map((p) => p.businessName)).toEqual(['Near but older', 'Far but newer']);
  });

  it('loads candidates in a fixed order, and searches the whole radius when the area is not dense', async () => {
    db.serviceProvider.count.mockResolvedValue(40);
    db.serviceProvider.findMany.mockResolvedValue([nearOld]);

    const result = await getNearbyProviders({ latitude, longitude, radiusKm: 25 });

    const query = db.serviceProvider.findMany.mock.calls[0][0];
    expect(query.orderBy).toEqual([{ id: 'asc' }]);
    expect(query.take).toBe(MAX_NEARBY_CANDIDATES);
    expect(query.where.latitude).toEqual(boundingBox(latitude, longitude, 25).latitude);
    expect(db.serviceProvider.count).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ radiusKm: 25, coveredRadiusKm: 25, total: 1 });
  });

  it('narrows the radius in a dense area until every provider inside it can be loaded', async () => {
    db.serviceProvider.count
      .mockResolvedValueOnce(5000) // 25 km
      .mockResolvedValueOnce(1500) // 12.5 km
      .mockResolvedValueOnce(800); // 6.3 km
    // About 2 km and 8.9 km from the search point
    const inside = nearbyRow('b1', 'Two km away', 6.446, 3.4219, '2026-01-01T00:00:00.000Z');
    const outside = nearbyRow('b2', 'Nine km away', 6.508, 3.4219, '2026-01-01T00:00:00.000Z');
    db.serviceProvider.findMany.mockResolvedValue([inside, outside]);

    const result = await getNearbyProviders({ latitude, longitude, radiusKm: 25 });

    expect(db.serviceProvider.count).toHaveBeenCalledTimes(3);
    expect(db.serviceProvider.findMany.mock.calls[0][0].where.latitude).toEqual(
      boundingBox(latitude, longitude, 6.3).latitude
    );
    expect(result).toMatchObject({ radiusKm: 25, coveredRadiusKm: 6.3, total: 1 });
    expect(result.items.map((p) => p.businessName)).toEqual(['Two km away']);
  });

  it('does not narrow below 1 km', async () => {
    db.serviceProvider.count.mockResolvedValue(50000);
    db.serviceProvider.findMany.mockResolvedValue([]);

    const result = await getNearbyProviders({ latitude, longitude, radiusKm: 25 });

    expect(result.coveredRadiusKm).toBeGreaterThanOrEqual(1);
    expect(result.coveredRadiusKm / 2).toBeLessThan(1);
    expect(db.serviceProvider.findMany.mock.calls[0][0].take).toBe(MAX_NEARBY_CANDIDATES);
  });

  it('skips the density check for a radius under 2 km', async () => {
    db.serviceProvider.findMany.mockResolvedValue([]);

    const result = await getNearbyProviders({ latitude, longitude, radiusKm: 1.5 });

    expect(db.serviceProvider.count).not.toHaveBeenCalled();
    expect(result.coveredRadiusKm).toBe(1.5);
  });

  it('applies minRating before counting and loading candidates', async () => {
    db.review.groupBy.mockResolvedValueOnce([{ providerId: 'a1' }]).mockResolvedValue([]);
    db.serviceProvider.count.mockResolvedValue(1);
    db.serviceProvider.findMany.mockResolvedValue([nearOld]);

    await getNearbyProviders({ latitude, longitude, radiusKm: 25, filters: { minRating: 4.5 } });

    expect(db.review.groupBy).toHaveBeenNthCalledWith(1, {
      by: ['providerId'],
      where: notRemoved,
      having: { rating: { _avg: { gte: 4.45 } } },
    });
    expect(db.serviceProvider.count.mock.calls[0][0].where.id).toEqual({ in: ['a1'] });
    expect(db.serviceProvider.findMany.mock.calls[0][0].where.id).toEqual({ in: ['a1'] });
  });
});

// ==================
// Removed reviews
// ==================

describe('reviews removed by an admin', () => {
  it('are left out of review counts and ratings on providers', async () => {
    db.serviceProvider.findMany.mockResolvedValue([providerRow()]);
    db.serviceProvider.count.mockResolvedValue(1);

    await browseProviders({});

    const query = db.serviceProvider.findMany.mock.calls[0][0];
    expect(query.include._count).toEqual({ select: { reviews: { where: notRemoved }, likes: true } });
    expect(db.review.groupBy).toHaveBeenCalledWith({
      by: ['providerId'],
      where: { providerId: { in: [providerId] }, ...notRemoved },
      _avg: { rating: true },
    });
  });

  it('are left out of review counts and ratings on nearbyProviders', async () => {
    db.serviceProvider.findMany.mockResolvedValue([providerRow({ latitude: 6.429, longitude: 3.4225 })]);

    await getNearbyProviders({ latitude: 6.4281, longitude: 3.4219, radiusKm: 25 });

    const query = db.serviceProvider.findMany.mock.calls[0][0];
    expect(query.include._count).toEqual({ select: { reviews: { where: notRemoved }, likes: true } });
    expect(db.review.groupBy).toHaveBeenCalledWith({
      by: ['providerId'],
      where: { providerId: { in: [providerId] }, ...notRemoved },
      _avg: { rating: true },
    });
  });

  it('are left out of the rating and review total on providerProfile', async () => {
    db.serviceProvider.findUnique.mockResolvedValue(providerRow({ _count: { reviews: 5, likes: 2 } }));
    db.review.aggregate.mockResolvedValue({ _avg: { rating: 4.25 }, _count: { id: 3 } });

    const profile = await getProviderPublicProfile(providerId);

    expect(db.serviceProvider.findUnique.mock.calls[0][0].include._count).toEqual({
      select: { reviews: { where: notRemoved }, likes: true },
    });
    expect(db.review.aggregate).toHaveBeenCalledWith({
      where: { providerId, ...notRemoved },
      _avg: { rating: true },
      _count: { id: true },
    });
    expect(profile).toMatchObject({ averageRating: 4.3, totalReviews: 3, likeCount: 2 });
  });
});
