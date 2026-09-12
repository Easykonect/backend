/**
 * Service Service Tests
 *
 * Covers:
 *   - getServices() accepts city/state/latitude/longitude/radiusKm
 *   - getNearbyServices() returns each service annotated with distanceKm,
 *     sorted ascending, restricted to providers within radius
 *   - the viewer's own listings, and those of providers they blocked, are
 *     left out of both
 *   - createService/updateService screen the name and description, and an
 *     edit to a live listing is flagged for admins
 */

import { GraphQLError } from 'graphql';

// ==================
// Mocks
// ==================

jest.mock('@/lib/prisma', () => ({
  __esModule: true,
  default: {
    user: {
      findUnique: jest.fn(),
    },
    userBlock: {
      findMany: jest.fn(),
    },
    serviceCategory: {
      findUnique: jest.fn(),
    },
    serviceProvider: {
      findMany: jest.fn(),
    },
    service: {
      findMany: jest.fn(),
      count: jest.fn(),
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
  },
}));

jest.mock('@/config', () => ({
  config: {
    pagination: { defaultLimit: 10, maxLimit: 100 },
    geo: { defaultRadiusKm: 25, maxRadiusKm: 100 },
    // Service images must be in this Cloudinary account
    cloudinary: { cloudName: 'demo' },
    redisUrl: 'redis://localhost:6379',
  },
}));

jest.mock('@/services/notification.service', () => ({
  createNotification: jest.fn(),
  notifyServiceApproved: jest.fn(),
  notifyServiceRejected: jest.fn(),
}));

jest.mock('@/services/push.service', () => ({ sendPushToUser: jest.fn() }));

jest.mock('@/services/audit.service', () => ({ createAuditLog: jest.fn() }));

// Rating and like counts are covered in service-moderation.test.ts
jest.mock('@/services/provider-profile.service', () => ({
  ...jest.requireActual('@/services/provider-profile.service'),
  loadProviderStats: async () => new Map(),
}));

jest.mock('@/lib/redis', () => ({
  __esModule: true,
  default: {
    getInstance: jest.fn().mockReturnValue({
      get: jest.fn(),
      set: jest.fn(),
      del: jest.fn(),
    }),
  },
}));

jest.mock('@/services/report.service', () => ({
  flagContent: jest.fn(),
}));

jest.mock('@/services/terms.service', () => ({
  assertTermsAccepted: jest.fn(),
}));

import prisma from '@/lib/prisma';
import { flagContent } from '@/services/report.service';
import { assertTermsAccepted } from '@/services/terms.service';
import {
  getServices,
  getNearbyServices,
  createService,
  updateService,
} from '@/services/service.service';

// ==================
// Fixtures
// ==================

const lagosLat = 6.5244;
const lagosLng = 3.3792;
const ibadanLat = 7.3775; // ~125 km from Lagos
const ibadanLng = 3.9470;
const yabaLat = 6.5158; // ~1 km from Lagos centre
const yabaLng = 3.3711;

const makeProviderRow = (overrides: any = {}) => ({
  id: overrides.id ?? 'p_lagos',
  latitude: overrides.latitude ?? lagosLat,
  longitude: overrides.longitude ?? lagosLng,
  ...overrides,
});

const makeServiceRow = (overrides: any = {}) => ({
  id: overrides.id ?? 'svc1',
  providerId: overrides.providerId ?? 'p_lagos',
  categoryId: 'cat1',
  name: overrides.name ?? 'Cleaning',
  slug: 'cleaning',
  description: 'desc',
  price: 5000,
  duration: 60,
  status: 'ACTIVE',
  images: [],
  createdAt: new Date('2025-01-01T00:00:00.000Z'),
  updatedAt: new Date('2025-01-01T00:00:00.000Z'),
  provider: {
    id: overrides.providerId ?? 'p_lagos',
    businessName: 'Top',
    businessDescription: null,
    verificationStatus: 'VERIFIED',
    address: '1 Main',
    city: 'Lagos',
    state: 'Lagos',
    country: 'Nigeria',
    latitude: overrides.providerLat ?? lagosLat,
    longitude: overrides.providerLng ?? lagosLng,
    documents: [],
    createdAt: new Date('2025-01-01T00:00:00.000Z'),
    updatedAt: new Date('2025-01-01T00:00:00.000Z'),
  },
  category: {
    id: 'cat1',
    name: 'Cleaning',
    slug: 'cleaning',
    description: null,
    icon: null,
    isActive: true,
    createdAt: new Date('2025-01-01T00:00:00.000Z'),
    updatedAt: new Date('2025-01-01T00:00:00.000Z'),
  },
  ...overrides,
});

beforeEach(() => {
  (prisma.serviceProvider.findMany as jest.Mock).mockReset();
  (prisma.service.findMany as jest.Mock).mockReset();
  (prisma.service.count as jest.Mock).mockReset();
  // Nobody has blocked anybody unless a test says so
  (prisma.userBlock.findMany as jest.Mock).mockReset().mockResolvedValue([]);
  // Terms are accepted unless a test says otherwise. Reset here so a rejection
  // set by one test can't carry into the next.
  (assertTermsAccepted as jest.Mock).mockReset().mockResolvedValue(undefined);
});

// ==================
// getServices — geo filter
// ==================

describe('getServices — geo filter', () => {
  it('returns empty when no provider falls inside the radius', async () => {
    (prisma.serviceProvider.findMany as jest.Mock).mockResolvedValueOnce([
      makeProviderRow({ id: 'p_ibadan', latitude: ibadanLat, longitude: ibadanLng }),
    ]);

    const result = await getServices(
      { latitude: lagosLat, longitude: lagosLng, radiusKm: 10 },
      { page: 1, limit: 10 }
    );

    expect(result.items).toEqual([]);
    expect(result.total).toBe(0);
    // Should never have hit the service table because the provider set is empty
    expect(prisma.service.findMany).not.toHaveBeenCalled();
  });

  it('constrains the service query to providers inside the radius', async () => {
    (prisma.serviceProvider.findMany as jest.Mock).mockResolvedValueOnce([
      makeProviderRow({ id: 'p_lagos', latitude: lagosLat, longitude: lagosLng }),
      makeProviderRow({ id: 'p_yaba', latitude: yabaLat, longitude: yabaLng }),
      makeProviderRow({ id: 'p_ibadan', latitude: ibadanLat, longitude: ibadanLng }),
    ]);
    (prisma.service.findMany as jest.Mock).mockResolvedValueOnce([
      makeServiceRow({ id: 'svc1', providerId: 'p_lagos' }),
      makeServiceRow({ id: 'svc2', providerId: 'p_yaba' }),
    ]);
    (prisma.service.count as jest.Mock).mockResolvedValueOnce(2);

    await getServices(
      { latitude: lagosLat, longitude: lagosLng, radiusKm: 10 },
      { page: 1, limit: 10 }
    );

    const findManyCall = (prisma.service.findMany as jest.Mock).mock.calls[0][0];
    // Lagos and Yaba are within 10 km; Ibadan is ~125 km away → excluded
    expect(findManyCall.where.providerId).toEqual({ in: expect.arrayContaining(['p_lagos', 'p_yaba']) });
    expect(findManyCall.where.providerId.in).not.toContain('p_ibadan');
  });

  it('applies city/state filters via provider relation when no geo is given', async () => {
    (prisma.service.findMany as jest.Mock).mockResolvedValueOnce([]);
    (prisma.service.count as jest.Mock).mockResolvedValueOnce(0);

    await getServices(
      { city: 'Lagos', state: 'Lagos' },
      { page: 1, limit: 10 }
    );

    const findManyCall = (prisma.service.findMany as jest.Mock).mock.calls[0][0];
    expect(findManyCall.where.provider).toEqual({
      is: expect.objectContaining({
        city: expect.objectContaining({ equals: 'Lagos' }),
        state: expect.objectContaining({ equals: 'Lagos' }),
      }),
    });
    expect(prisma.serviceProvider.findMany).not.toHaveBeenCalled();
  });

  it('caps radiusKm at config.geo.maxRadiusKm', async () => {
    (prisma.serviceProvider.findMany as jest.Mock).mockResolvedValueOnce([
      makeProviderRow({ id: 'p_ibadan', latitude: ibadanLat, longitude: ibadanLng }),
    ]);
    (prisma.service.findMany as jest.Mock).mockResolvedValueOnce([]);
    (prisma.service.count as jest.Mock).mockResolvedValueOnce(0);

    // Ibadan ~125 km away — would be in radius if we trusted 9999, but we cap at 100
    await getServices(
      { latitude: lagosLat, longitude: lagosLng, radiusKm: 9999 },
      { page: 1, limit: 10 }
    );

    // Ibadan should be excluded -> empty providerId.in -> early return short-circuit
    // No service.findMany call made
    expect(prisma.service.findMany).not.toHaveBeenCalled();
  });
});

// ==================
// getNearbyServices
// ==================

describe('getNearbyServices', () => {
  it('returns only services whose provider is within radius, sorted by distance', async () => {
    (prisma.serviceProvider.findMany as jest.Mock).mockResolvedValueOnce([
      makeProviderRow({ id: 'p_far', latitude: yabaLat + 0.05, longitude: yabaLng + 0.05 }), // ~7 km
      makeProviderRow({ id: 'p_near', latitude: lagosLat + 0.005, longitude: lagosLng + 0.005 }), // <1 km
      makeProviderRow({ id: 'p_outside', latitude: ibadanLat, longitude: ibadanLng }), // ~125 km
    ]);
    (prisma.service.findMany as jest.Mock).mockResolvedValueOnce([
      makeServiceRow({ id: 'svc_far', providerId: 'p_far' }),
      makeServiceRow({ id: 'svc_near', providerId: 'p_near' }),
    ]);

    const result = await getNearbyServices({
      latitude: lagosLat,
      longitude: lagosLng,
      radiusKm: 25,
    });

    expect(result.items).toHaveLength(2);
    expect(result.items[0].id).toBe('svc_near'); // sorted by distance asc
    expect(result.items[1].id).toBe('svc_far');
    expect(result.items[0].distanceKm).toBeLessThan(result.items[1].distanceKm);
    // p_outside excluded by radius
    expect(result.items.find((i: any) => i.provider?.id === 'p_outside')).toBeUndefined();
  });

  it('only considers verified providers inside the search area', async () => {
    (prisma.serviceProvider.findMany as jest.Mock).mockResolvedValueOnce([]);

    const result = await getNearbyServices({
      latitude: lagosLat,
      longitude: lagosLng,
      radiusKm: 25,
    });

    expect(result.items).toEqual([]);
    const providerCall = (prisma.serviceProvider.findMany as jest.Mock).mock.calls[0][0];
    // A range filter also excludes providers without coordinates
    expect(providerCall.where.latitude).toEqual({ gte: expect.any(Number), lte: expect.any(Number) });
    expect(providerCall.where.latitude.gte).toBeLessThan(lagosLat);
    expect(providerCall.where.latitude.lte).toBeGreaterThan(lagosLat);
    expect(providerCall.where.longitude).toEqual({ gte: expect.any(Number), lte: expect.any(Number) });
    expect(providerCall.take).toBeGreaterThan(0);
    expect(providerCall.where.verificationStatus).toBe('VERIFIED');
  });

  it('attaches search filter to the service query when provided', async () => {
    (prisma.serviceProvider.findMany as jest.Mock).mockResolvedValueOnce([
      makeProviderRow({ id: 'p_lagos', latitude: lagosLat, longitude: lagosLng }),
    ]);
    (prisma.service.findMany as jest.Mock).mockResolvedValueOnce([]);

    await getNearbyServices({
      latitude: lagosLat,
      longitude: lagosLng,
      radiusKm: 25,
      search: 'cleaning',
    });

    const serviceCall = (prisma.service.findMany as jest.Mock).mock.calls[0][0];
    expect(serviceCall.where.OR).toEqual([
      { name: { contains: 'cleaning', mode: 'insensitive' } },
      { description: { contains: 'cleaning', mode: 'insensitive' } },
    ]);
  });

  it('returns metadata: radiusKm + searchLocation', async () => {
    (prisma.serviceProvider.findMany as jest.Mock).mockResolvedValueOnce([]);

    const result = await getNearbyServices({
      latitude: lagosLat,
      longitude: lagosLng,
      radiusKm: 30,
    });

    expect(result.radiusKm).toBe(30);
    expect(result.searchLocation).toEqual({ latitude: lagosLat, longitude: lagosLng });
  });
});

// ==================
// Own and blocked providers' services (caller is signed in)
// ==================

describe('getServices — excludeProviderUserId', () => {
  it('adds userId: { notIn: [viewer] } to the provider relation filter', async () => {
    (prisma.service.findMany as jest.Mock).mockResolvedValueOnce([]);
    (prisma.service.count as jest.Mock).mockResolvedValueOnce(0);

    await getServices(
      { excludeProviderUserId: 'user-A' },
      { page: 1, limit: 10 }
    );

    const call = (prisma.service.findMany as jest.Mock).mock.calls[0][0];
    expect(call.where.provider).toEqual({
      is: expect.objectContaining({ userId: { notIn: ['user-A'] } }),
    });
    expect(prisma.userBlock.findMany).toHaveBeenCalledWith({
      where: { blockerId: 'user-A' },
      select: { blockedId: true },
    });
  });

  it('combines excludeProviderUserId with city/state filters', async () => {
    (prisma.service.findMany as jest.Mock).mockResolvedValueOnce([]);
    (prisma.service.count as jest.Mock).mockResolvedValueOnce(0);

    await getServices(
      { city: 'Lagos', excludeProviderUserId: 'user-A' },
      { page: 1, limit: 10 }
    );

    const call = (prisma.service.findMany as jest.Mock).mock.calls[0][0];
    expect(call.where.provider.is).toMatchObject({
      city: expect.anything(),
      userId: { notIn: ['user-A'] },
    });
  });

  it('applies excludeProviderUserId to the geo candidate-provider query', async () => {
    (prisma.serviceProvider.findMany as jest.Mock).mockResolvedValueOnce([]);

    await getServices(
      {
        latitude: lagosLat,
        longitude: lagosLng,
        radiusKm: 10,
        excludeProviderUserId: 'user-A',
      },
      { page: 1, limit: 10 }
    );

    const providerCall = (prisma.serviceProvider.findMany as jest.Mock).mock.calls[0][0];
    expect(providerCall.where.userId).toEqual({ notIn: ['user-A'] });
  });

  it('also leaves out providers the viewer blocked, in both the list and the count', async () => {
    (prisma.userBlock.findMany as jest.Mock).mockResolvedValue([{ blockedId: 'user-B' }, { blockedId: 'user-C' }]);
    (prisma.service.findMany as jest.Mock).mockResolvedValueOnce([]);
    (prisma.service.count as jest.Mock).mockResolvedValueOnce(0);

    await getServices({ excludeProviderUserId: 'user-A' }, { page: 1, limit: 10 });

    const where = (prisma.service.findMany as jest.Mock).mock.calls[0][0].where;
    expect(where.provider).toEqual({ is: { userId: { notIn: ['user-A', 'user-B', 'user-C'] } } });
    expect((prisma.service.count as jest.Mock).mock.calls[0][0].where).toEqual(where);
  });

  it('also leaves out providers the viewer blocked from the geo candidate-provider query', async () => {
    (prisma.userBlock.findMany as jest.Mock).mockResolvedValue([{ blockedId: 'user-B' }]);
    (prisma.serviceProvider.findMany as jest.Mock).mockResolvedValueOnce([]);

    await getServices(
      { latitude: lagosLat, longitude: lagosLng, radiusKm: 10, excludeProviderUserId: 'user-A' },
      { page: 1, limit: 10 }
    );

    const providerCall = (prisma.serviceProvider.findMany as jest.Mock).mock.calls[0][0];
    expect(providerCall.where.userId).toEqual({ notIn: ['user-A', 'user-B'] });
  });

  it('does nothing when excludeProviderUserId is omitted (anonymous caller)', async () => {
    (prisma.service.findMany as jest.Mock).mockResolvedValueOnce([]);
    (prisma.service.count as jest.Mock).mockResolvedValueOnce(0);

    await getServices({}, { page: 1, limit: 10 });

    const call = (prisma.service.findMany as jest.Mock).mock.calls[0][0];
    // No provider relation filter at all — the where clause should only
    // contain the public-default status filter.
    expect(call.where.provider).toBeUndefined();
    expect(prisma.userBlock.findMany).not.toHaveBeenCalled();
  });
});

describe('getNearbyServices — excludeProviderUserId', () => {
  it('filters the candidate-provider query by userId: { notIn: [viewer] }', async () => {
    (prisma.serviceProvider.findMany as jest.Mock).mockResolvedValueOnce([]);

    await getNearbyServices({
      latitude: lagosLat,
      longitude: lagosLng,
      excludeProviderUserId: 'user-A',
    });

    const call = (prisma.serviceProvider.findMany as jest.Mock).mock.calls[0][0];
    expect(call.where.userId).toEqual({ notIn: ['user-A'] });
  });

  it('also leaves out providers the viewer blocked', async () => {
    (prisma.userBlock.findMany as jest.Mock).mockResolvedValue([{ blockedId: 'user-B' }, { blockedId: 'user-C' }]);
    (prisma.serviceProvider.findMany as jest.Mock).mockResolvedValueOnce([]);

    await getNearbyServices({
      latitude: lagosLat,
      longitude: lagosLng,
      excludeProviderUserId: 'user-A',
    });

    const call = (prisma.serviceProvider.findMany as jest.Mock).mock.calls[0][0];
    expect(call.where.userId).toEqual({ notIn: ['user-A', 'user-B', 'user-C'] });
    expect(call.where.verificationStatus).toBe('VERIFIED');
  });

  it('omits the userId filter when excludeProviderUserId is not passed', async () => {
    (prisma.serviceProvider.findMany as jest.Mock).mockResolvedValueOnce([]);

    await getNearbyServices({ latitude: lagosLat, longitude: lagosLng });

    const call = (prisma.serviceProvider.findMany as jest.Mock).mock.calls[0][0];
    expect(call.where.userId).toBeUndefined();
    expect(prisma.userBlock.findMany).not.toHaveBeenCalled();
  });
});

// ==================
// createService / updateService — screening
// ==================

const ownerUserId = '507f1f77bcf86cd700000001';
const ownerProvider = { id: 'p_lagos', userId: ownerUserId, verificationStatus: 'VERIFIED' };

const listingInput = {
  categoryId: 'cat1',
  name: 'Deep Cleaning',
  description: 'Thorough home cleaning across Lagos',
  price: 5000,
  duration: 60,
};

// An approved listing customers can see
const liveService = {
  id: 'svc1',
  providerId: 'p_lagos',
  name: 'Deep Cleaning',
  description: 'Thorough home cleaning across Lagos',
  images: ['https://res.cloudinary.com/demo/image/upload/v1/services/a.jpg'],
  price: 5000,
  duration: 60,
  status: 'ACTIVE',
};

describe('createService — screening', () => {
  beforeEach(() => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue({
      id: ownerUserId,
      role: 'SERVICE_PROVIDER',
      provider: ownerProvider,
    });
    (prisma.serviceCategory.findUnique as jest.Mock).mockResolvedValue({ id: 'cat1', isActive: true });
    (prisma.service.findFirst as jest.Mock).mockResolvedValue(null);
    (prisma.service.create as jest.Mock).mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      makeServiceRow({ ...data, id: 'svc-new' })
    );
    (assertTermsAccepted as jest.Mock).mockResolvedValue(undefined);
  });

  it.each([
    [{ name: 'Shit Hot Cleaning' }, 'INAPPROPRIATE_CONTENT'],
    [{ description: 'No bullshit, just thorough cleaning' }, 'INAPPROPRIATE_CONTENT'],
    [{ name: 'Cleaning 08031234567' }, 'CONTACT_DETAILS_NOT_ALLOWED'],
    [{ description: 'Thorough cleaning. Email ada@example.com to book' }, 'CONTACT_DETAILS_NOT_ALLOWED'],
  ])('rejects %j with %s and creates nothing', async (edit, code) => {
    await expect(createService(ownerUserId, { ...listingInput, ...edit })).rejects.toMatchObject({
      extensions: { code },
    });
    expect(prisma.service.create).not.toHaveBeenCalled();
  });

  it('checks the provider has accepted the community terms, then creates a draft', async () => {
    await createService(ownerUserId, listingInput);

    expect(assertTermsAccepted).toHaveBeenCalledWith(ownerUserId);
    expect(prisma.service.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ name: 'Deep Cleaning', status: 'DRAFT' }),
      })
    );
  });

  it('creates nothing when the provider has not accepted the terms', async () => {
    (assertTermsAccepted as jest.Mock).mockRejectedValue(
      new GraphQLError('Please accept the community terms before posting', {
        extensions: { code: 'TERMS_NOT_ACCEPTED' },
      })
    );

    await expect(createService(ownerUserId, listingInput)).rejects.toMatchObject({
      extensions: { code: 'TERMS_NOT_ACCEPTED' },
    });
    expect(prisma.service.create).not.toHaveBeenCalled();
  });
});

describe('updateService — screening and review of live listings', () => {
  const editing = (existing: typeof liveService) => {
    (prisma.service.findUnique as jest.Mock).mockResolvedValue(existing);
    (prisma.service.update as jest.Mock).mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      makeServiceRow({ ...existing, ...data })
    );
  };

  beforeEach(() => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue({
      id: ownerUserId,
      role: 'SERVICE_PROVIDER',
      provider: ownerProvider,
    });
    (flagContent as jest.Mock).mockResolvedValue(undefined);
  });

  it.each([
    [{ name: 'Fucking Good Cleaning' }, 'INAPPROPRIATE_CONTENT'],
    [{ description: 'Proper cleaning, not this shit' }, 'INAPPROPRIATE_CONTENT'],
    [{ name: 'Cleaning 08031234567' }, 'CONTACT_DETAILS_NOT_ALLOWED'],
    [{ description: 'Call 0803 123 4567 and skip the app fees' }, 'CONTACT_DETAILS_NOT_ALLOWED'],
  ])('rejects %j with %s and saves nothing', async (edit, code) => {
    editing(liveService);

    await expect(updateService(ownerUserId, 'svc1', edit)).rejects.toMatchObject({ extensions: { code } });
    expect(prisma.service.update).not.toHaveBeenCalled();
    expect(flagContent).not.toHaveBeenCalled();
  });

  it.each([
    [{ name: 'Premium Deep Cleaning' }],
    [{ description: 'Thorough home and office cleaning across Lagos' }],
    [{ images: ['https://res.cloudinary.com/demo/image/upload/v1/services/b.jpg'] }],
  ])('flags an ACTIVE listing for admins after an edit of %j', async (edit) => {
    editing(liveService);

    await updateService(ownerUserId, 'svc1', edit);

    const before = { name: liveService.name, description: liveService.description, images: liveService.images };
    expect(flagContent).toHaveBeenCalledTimes(1);
    expect(flagContent).toHaveBeenCalledWith({
      targetType: 'SERVICE',
      targetId: 'svc1',
      targetUserId: ownerUserId,
      reason: 'OTHER',
      details: expect.any(String),
      snapshot: { before, after: { ...before, ...edit } },
    });
  });

  it('does not flag edits to a DRAFT listing', async () => {
    editing({ ...liveService, status: 'DRAFT' });

    await updateService(ownerUserId, 'svc1', {
      name: 'Premium Deep Cleaning',
      description: 'Thorough home and office cleaning across Lagos',
    });

    expect(prisma.service.update).toHaveBeenCalled();
    expect(flagContent).not.toHaveBeenCalled();
  });

  it('does not flag a price-only change to an ACTIVE listing', async () => {
    editing(liveService);

    await updateService(ownerUserId, 'svc1', { price: 6500 });

    expect(prisma.service.update).toHaveBeenCalledWith(expect.objectContaining({ data: { price: 6500 } }));
    expect(flagContent).not.toHaveBeenCalled();
  });

  it('does not flag an ACTIVE listing saved with the same name and description', async () => {
    editing(liveService);

    await updateService(ownerUserId, 'svc1', { name: liveService.name, description: liveService.description });

    expect(prisma.service.update).toHaveBeenCalled();
    expect(flagContent).not.toHaveBeenCalled();
  });
});

describe('updateService — community terms', () => {
  const termsNotAccepted = () =>
    new GraphQLError('Please accept the community terms before posting', {
      extensions: { code: 'TERMS_NOT_ACCEPTED' },
    });

  beforeEach(() => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue({
      id: ownerUserId,
      role: 'SERVICE_PROVIDER',
      provider: ownerProvider,
    });
    (prisma.service.findUnique as jest.Mock).mockResolvedValue(liveService);
    (prisma.service.update as jest.Mock).mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      makeServiceRow({ ...liveService, ...data })
    );
    (flagContent as jest.Mock).mockResolvedValue(undefined);
  });

  it.each([
    [{ name: 'Premium Deep Cleaning' }],
    [{ description: 'Thorough home and office cleaning across Lagos' }],
    [{ images: ['https://res.cloudinary.com/demo/image/upload/v1/services/b.jpg'] }],
  ])('checks the provider has accepted the terms for an edit of %j', async (edit) => {
    await updateService(ownerUserId, 'svc1', edit);

    expect(assertTermsAccepted).toHaveBeenCalledWith(ownerUserId);
    expect(prisma.service.update).toHaveBeenCalled();
  });

  it.each([
    [{ price: 6500 }],
    [{ duration: 90 }],
    [{ status: 'INACTIVE' as const }],
  ])('does not check the terms for an edit of %j', async (edit) => {
    (assertTermsAccepted as jest.Mock).mockRejectedValue(termsNotAccepted());

    await updateService(ownerUserId, 'svc1', edit);

    expect(assertTermsAccepted).not.toHaveBeenCalled();
    expect(prisma.service.update).toHaveBeenCalled();
  });

  it('saves and flags nothing when the provider has not accepted the terms', async () => {
    (assertTermsAccepted as jest.Mock).mockRejectedValue(termsNotAccepted());

    await expect(updateService(ownerUserId, 'svc1', { name: 'Premium Deep Cleaning' })).rejects.toMatchObject({
      extensions: { code: 'TERMS_NOT_ACCEPTED' },
    });
    expect(prisma.service.update).not.toHaveBeenCalled();
    expect(flagContent).not.toHaveBeenCalled();
  });

  it('refuses a service owned by another provider with FORBIDDEN, whatever the terms', async () => {
    (assertTermsAccepted as jest.Mock).mockRejectedValue(termsNotAccepted());
    (prisma.service.findUnique as jest.Mock).mockResolvedValue({ ...liveService, providerId: 'p_other' });

    await expect(updateService(ownerUserId, 'svc1', { name: 'Premium Deep Cleaning' })).rejects.toMatchObject({
      extensions: { code: 'FORBIDDEN' },
    });
    expect(prisma.service.update).not.toHaveBeenCalled();
  });
});
