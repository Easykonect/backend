/**
 * Service Service Tests — geo filters + nearbyServices
 *
 * Covers the bug-fix sweep additions:
 *   - getServices() now accepts city/state/latitude/longitude/radiusKm
 *   - getNearbyServices() returns each service annotated with distanceKm,
 *     sorted ascending, restricted to providers within radius
 */

// ==================
// Mocks
// ==================

jest.mock('@/lib/prisma', () => ({
  __esModule: true,
  default: {
    serviceProvider: {
      findMany: jest.fn(),
    },
    service: {
      findMany: jest.fn(),
      count: jest.fn(),
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

import prisma from '@/lib/prisma';
import { getServices, getNearbyServices } from '@/services/service.service';

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

  it('only considers providers with non-null lat/lng', async () => {
    (prisma.serviceProvider.findMany as jest.Mock).mockResolvedValueOnce([]);

    const result = await getNearbyServices({
      latitude: lagosLat,
      longitude: lagosLng,
      radiusKm: 25,
    });

    expect(result.items).toEqual([]);
    const providerCall = (prisma.serviceProvider.findMany as jest.Mock).mock.calls[0][0];
    expect(providerCall.where.latitude).toEqual({ not: null });
    expect(providerCall.where.longitude).toEqual({ not: null });
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
