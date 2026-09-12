/**
 * Service Visibility, Editing Rules and Moderation Tests
 *
 * Covers:
 *   - service(id): services that aren't ACTIVE are only for their provider and
 *     admins, and a block either way hides a live service
 *   - services: filters.status is honoured for admins and a provider's own
 *     list only; a providerId outside the search radius gives an empty page
 *   - updateService: a SUSPENDED service keeps its status, renamed services get
 *     a slug that doesn't clash, inactive categories and foreign image URLs are
 *     refused, price and duration must be above 0
 *   - createService: punctuation in names, transliterated slugs, image checks
 *   - approveService reinstates a suspended service
 *   - approveService / rejectService / suspendService: status rules, saved
 *     reasons, in-app and push notifications, audit logs, report decisions
 *   - provider rating and like counts on services
 */

jest.mock('@/lib/prisma', () => ({
  __esModule: true,
  default: {
    user: { findUnique: jest.fn() },
    serviceCategory: { findUnique: jest.fn() },
    serviceProvider: { findUnique: jest.fn(), findMany: jest.fn() },
    service: {
      findMany: jest.fn(),
      count: jest.fn(),
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    review: { groupBy: jest.fn() },
    providerLike: { groupBy: jest.fn() },
  },
}));

jest.mock('@/config', () => ({
  config: {
    pagination: { defaultLimit: 10, maxLimit: 100 },
    geo: { defaultRadiusKm: 25, maxRadiusKm: 100 },
    cloudinary: { cloudName: 'easykonnet' },
    redisUrl: 'redis://localhost:6379',
  },
}));

jest.mock('@/lib/redis', () => ({ __esModule: true, default: { getInstance: jest.fn() } }));
jest.mock('@/services/block.service', () => ({ isBlockedBetween: jest.fn(), getBlockedUserIds: jest.fn() }));
jest.mock('@/services/report.service', () => ({ flagContent: jest.fn() }));
jest.mock('@/services/terms.service', () => ({ assertTermsAccepted: jest.fn() }));
jest.mock('@/services/notification.service', () => ({
  createNotification: jest.fn(),
  notifyServiceApproved: jest.fn(),
  notifyServiceRejected: jest.fn(),
}));
jest.mock('@/services/push.service', () => ({ sendPushToUser: jest.fn() }));
jest.mock('@/services/audit.service', () => ({ createAuditLog: jest.fn() }));

import prisma from '@/lib/prisma';
import { getBlockedUserIds, isBlockedBetween } from '@/services/block.service';
import { flagContent } from '@/services/report.service';
import { assertTermsAccepted } from '@/services/terms.service';
import { createNotification, notifyServiceApproved, notifyServiceRejected } from '@/services/notification.service';
import { sendPushToUser } from '@/services/push.service';
import { createAuditLog } from '@/services/audit.service';
import {
  approveService,
  createService,
  getPendingServices,
  getServiceById,
  getServices,
  rejectService,
  suspendService,
  updateService,
} from '@/services/service.service';

// ==================
// Fixtures
// ==================

const OWNER_ID = '64f1c2a9e4b0a1b2c3d4e5f6';
const CUSTOMER_ID = '64f1c2a9e4b0a1b2c3d4e5f7';
const ADMIN_ID = '64f1c2a9e4b0a1b2c3d4e5f8';
const PROVIDER_ID = '6501a3b7c9d2e4f5a6b7c8d9';
const OTHER_PROVIDER_ID = '6501a3b7c9d2e4f5a6b7c8da';
const SERVICE_ID = '6504c6e0f1a2b3c4d5e6f7a8';

const cloudImage = (name: string) => `https://res.cloudinary.com/easykonnet/image/upload/v1/services/${name}.jpg`;

const dates = {
  createdAt: new Date('2026-09-01T10:00:00.000Z'),
  updatedAt: new Date('2026-09-02T10:00:00.000Z'),
};

const providerRow = {
  id: PROVIDER_ID,
  userId: OWNER_ID,
  businessName: 'Eze Power Solutions',
  businessDescription: 'Generator servicing and inverter installation in Abuja.',
  verificationStatus: 'VERIFIED',
  rejectionReason: null,
  address: 'Plot 45 Aminu Kano Crescent, Wuse 2',
  city: 'Abuja',
  state: 'FCT',
  country: 'Nigeria',
  latitude: 9.0765,
  longitude: 7.3986,
  documents: ['https://res.cloudinary.com/easykonnet/image/upload/v1/documents/cac.jpg'],
  images: ['https://res.cloudinary.com/easykonnet/image/upload/v1/providers/workshop.jpg'],
  ...dates,
};

const serviceRow = (overrides: Record<string, unknown> = {}) => ({
  id: SERVICE_ID,
  providerId: PROVIDER_ID,
  categoryId: 'cat-generator',
  name: 'Generator Servicing',
  slug: 'generator-servicing',
  description: 'Oil change, plug and filter replacement for petrol generators.',
  price: 25000,
  duration: 120,
  status: 'ACTIVE',
  rejectionReason: null,
  suspensionReason: null,
  images: [cloudImage('generator')],
  ...dates,
  provider: providerRow,
  category: {
    id: 'cat-generator',
    name: 'Generator Repair',
    slug: 'generator-repair',
    description: null,
    icon: null,
    isActive: true,
    ...dates,
  },
  ...overrides,
});

// The service as findUnique returns it without relations
const plainRow = (overrides: Record<string, unknown> = {}) => {
  const { provider, category, ...row } = serviceRow(overrides);
  return row;
};

const admin = {
  id: ADMIN_ID,
  role: 'ADMIN',
  ipAddress: '203.0.113.5',
  userAgent: 'EasykonnetDashboard/1.0',
};

const REASON = 'The photos show another company’s branding.';

beforeEach(() => {
  jest.resetAllMocks();
  (prisma.review.groupBy as jest.Mock).mockResolvedValue([]);
  (prisma.providerLike.groupBy as jest.Mock).mockResolvedValue([]);
  (isBlockedBetween as jest.Mock).mockResolvedValue(false);
  (getBlockedUserIds as jest.Mock).mockResolvedValue([]);
  (assertTermsAccepted as jest.Mock).mockResolvedValue(undefined);
  (flagContent as jest.Mock).mockResolvedValue(undefined);
  (createNotification as jest.Mock).mockResolvedValue({});
  (notifyServiceApproved as jest.Mock).mockResolvedValue({});
  (notifyServiceRejected as jest.Mock).mockResolvedValue({});
  (sendPushToUser as jest.Mock).mockResolvedValue({ success: true });
  (createAuditLog as jest.Mock).mockResolvedValue({});
});

// ==================
// service(id)
// ==================

describe('service(id) — who can see it', () => {
  const owner = { userId: OWNER_ID, role: 'SERVICE_PROVIDER' };
  const customer = { userId: CUSTOMER_ID, role: 'SERVICE_USER' };

  it('returns a live service to a guest, with the provider gallery, rating and like counts', async () => {
    (prisma.service.findUnique as jest.Mock).mockResolvedValue(serviceRow());
    (prisma.review.groupBy as jest.Mock).mockResolvedValue([
      { providerId: PROVIDER_ID, _avg: { rating: 4.25 }, _count: { _all: 8 } },
    ]);
    (prisma.providerLike.groupBy as jest.Mock).mockResolvedValue([{ providerId: PROVIDER_ID, _count: { _all: 12 } }]);

    const service = await getServiceById(SERVICE_ID, null);

    expect(service.provider).toMatchObject({
      id: PROVIDER_ID,
      userId: OWNER_ID,
      images: providerRow.images,
      averageRating: 4.3,
      totalReviews: 8,
      likeCount: 12,
      isLiked: null,
    });
    expect(isBlockedBetween).not.toHaveBeenCalled();
  });

  it.each(['DRAFT', 'PENDING_APPROVAL', 'INACTIVE', 'SUSPENDED'])(
    'hides a %s service from guests and customers',
    async (status) => {
      (prisma.service.findUnique as jest.Mock).mockResolvedValue(serviceRow({ status }));

      await expect(getServiceById(SERVICE_ID, null)).rejects.toMatchObject({
        message: 'Service not found',
        extensions: { code: 'NOT_FOUND' },
      });
      await expect(getServiceById(SERVICE_ID, customer)).rejects.toMatchObject({
        extensions: { code: 'NOT_FOUND' },
      });
    }
  );

  it.each(['DRAFT', 'PENDING_APPROVAL', 'INACTIVE', 'SUSPENDED'])(
    'shows a %s service to its provider and to admins',
    async (status) => {
      (prisma.service.findUnique as jest.Mock).mockResolvedValue(serviceRow({ status }));

      for (const viewer of [owner, { userId: ADMIN_ID, role: 'ADMIN' }, { userId: ADMIN_ID, role: 'SUPER_ADMIN' }]) {
        await expect(getServiceById(SERVICE_ID, viewer)).resolves.toMatchObject({ id: SERVICE_ID, status });
      }
      expect(isBlockedBetween).not.toHaveBeenCalled();
    }
  );

  it('hides a live service when the customer and the provider have blocked each other', async () => {
    (prisma.service.findUnique as jest.Mock).mockResolvedValue(serviceRow());
    (isBlockedBetween as jest.Mock).mockResolvedValue(true);

    await expect(getServiceById(SERVICE_ID, customer)).rejects.toMatchObject({
      message: 'Service not found',
      extensions: { code: 'NOT_FOUND' },
    });
    expect(isBlockedBetween).toHaveBeenCalledWith(CUSTOMER_ID, OWNER_ID);
  });

  it('shows a live service to a signed-in customer when there is no block', async () => {
    (prisma.service.findUnique as jest.Mock).mockResolvedValue(serviceRow());

    await expect(getServiceById(SERVICE_ID, customer)).resolves.toMatchObject({ id: SERVICE_ID });
    expect(isBlockedBetween).toHaveBeenCalledWith(CUSTOMER_ID, OWNER_ID);
  });

  it('returns NOT_FOUND for a service that does not exist', async () => {
    (prisma.service.findUnique as jest.Mock).mockResolvedValue(null);

    await expect(getServiceById(SERVICE_ID, owner)).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } });
  });
});

// ==================
// services
// ==================

describe('services — status filter and own lists', () => {
  const where = () => (prisma.service.findMany as jest.Mock).mock.calls[0][0].where;

  beforeEach(() => {
    (prisma.service.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.service.count as jest.Mock).mockResolvedValue(0);
  });

  it('ignores status for guests', async () => {
    await getServices({ status: 'DRAFT' }, { page: 1, limit: 20 });

    expect(where().status).toBe('ACTIVE');
  });

  it("ignores status for a customer asking about someone else's services", async () => {
    (prisma.serviceProvider.findUnique as jest.Mock).mockResolvedValue({ userId: OWNER_ID });

    await getServices(
      { providerId: PROVIDER_ID, status: 'SUSPENDED', excludeProviderUserId: CUSTOMER_ID },
      { page: 1, limit: 20 },
      'SERVICE_USER'
    );

    expect(where().status).toBe('ACTIVE');
    expect(where().provider).toEqual({ is: { userId: { notIn: [CUSTOMER_ID] } } });
  });

  it.each(['ADMIN', 'SUPER_ADMIN'])('honours status for %s', async (role) => {
    await getServices({ status: 'SUSPENDED', excludeProviderUserId: ADMIN_ID }, { page: 1, limit: 20 }, role);

    expect(where().status).toBe('SUSPENDED');
    expect(prisma.serviceProvider.findUnique).not.toHaveBeenCalled();
  });

  it('lists only ACTIVE services for an admin who sends no status', async () => {
    await getServices({ excludeProviderUserId: ADMIN_ID }, { page: 1, limit: 20 }, 'ADMIN');

    expect(where().status).toBe('ACTIVE');
  });

  it("honours status on a provider's own list and doesn't leave their services out", async () => {
    (prisma.serviceProvider.findUnique as jest.Mock).mockResolvedValue({ userId: OWNER_ID });

    await getServices(
      { providerId: PROVIDER_ID, status: 'DRAFT', excludeProviderUserId: OWNER_ID },
      { page: 1, limit: 20 },
      'SERVICE_PROVIDER'
    );

    expect(prisma.serviceProvider.findUnique).toHaveBeenCalledWith({
      where: { id: PROVIDER_ID },
      select: { userId: true },
    });
    expect(where()).toMatchObject({ status: 'DRAFT', providerId: PROVIDER_ID });
    expect(where().provider).toBeUndefined();
    expect(getBlockedUserIds).not.toHaveBeenCalled();
  });

  it('returns an empty page when providerId is outside the search radius', async () => {
    (prisma.serviceProvider.findMany as jest.Mock).mockResolvedValue([
      { id: OTHER_PROVIDER_ID, latitude: 9.0765, longitude: 7.3986 },
    ]);

    const result = await getServices(
      { providerId: PROVIDER_ID, latitude: 9.0765, longitude: 7.3986, radiusKm: 10 },
      { page: 2, limit: 20 }
    );

    expect(result).toEqual({
      items: [],
      total: 0,
      page: 2,
      limit: 20,
      totalPages: 0,
      hasNextPage: false,
      hasPreviousPage: false,
    });
    expect(prisma.service.findMany).not.toHaveBeenCalled();
  });

  it('keeps the providerId filter when that provider is inside the radius', async () => {
    (prisma.serviceProvider.findMany as jest.Mock).mockResolvedValue([
      { id: PROVIDER_ID, latitude: 9.0765, longitude: 7.3986 },
      { id: OTHER_PROVIDER_ID, latitude: 9.08, longitude: 7.4 },
    ]);

    await getServices(
      { providerId: PROVIDER_ID, latitude: 9.0765, longitude: 7.3986, radiusKm: 10 },
      { page: 1, limit: 20 }
    );

    expect(where().providerId).toBe(PROVIDER_ID);
  });
});

// ==================
// updateService
// ==================

describe('updateService — editing rules', () => {
  const editing = (row: Record<string, unknown>) => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue({
      id: OWNER_ID,
      role: 'SERVICE_PROVIDER',
      provider: providerRow,
    });
    (prisma.service.findUnique as jest.Mock).mockResolvedValue(row);
    (prisma.service.update as jest.Mock).mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      serviceRow({ ...row, ...data })
    );
  };

  const saved = () => (prisma.service.update as jest.Mock).mock.calls[0][0].data;

  it.each(['DRAFT', 'INACTIVE'] as const)('refuses to move a SUSPENDED service to %s', async (status) => {
    editing(plainRow({ status: 'SUSPENDED', suspensionReason: 'Misleading photos' }));

    await expect(updateService(OWNER_ID, SERVICE_ID, { status })).rejects.toMatchObject({
      message: "This service has been suspended by an admin, so its status can't be changed",
      extensions: { code: 'SERVICE_SUSPENDED' },
    });
    expect(prisma.service.update).not.toHaveBeenCalled();
  });

  it('still lets the provider change other fields of a SUSPENDED service', async () => {
    editing(plainRow({ status: 'SUSPENDED' }));

    await updateService(OWNER_ID, SERVICE_ID, { price: 30000 });

    expect(saved()).toEqual({ price: 30000 });
  });

  it('keeps refusing statuses other than DRAFT and INACTIVE', async () => {
    editing(plainRow({ status: 'DRAFT' }));

    await expect(updateService(OWNER_ID, SERVICE_ID, { status: 'ACTIVE' })).rejects.toMatchObject({
      extensions: { code: 'INVALID_STATUS' },
    });
  });

  it("adds a random suffix when another of the provider's services has the new slug", async () => {
    editing(plainRow({ status: 'DRAFT' }));
    (prisma.service.findFirst as jest.Mock).mockResolvedValue({ id: '6504c6e0f1a2b3c4d5e6f7b9' });

    await updateService(OWNER_ID, SERVICE_ID, { name: 'Home Cleaning' });

    expect(prisma.service.findFirst).toHaveBeenCalledWith({
      where: { providerId: PROVIDER_ID, slug: 'home-cleaning', id: { not: SERVICE_ID } },
      select: { id: true },
    });
    expect(saved().slug).toMatch(/^home-cleaning-[0-9a-f]{8}$/);
  });

  it('uses the plain slug when it is free, with accents transliterated', async () => {
    editing(plainRow({ status: 'DRAFT' }));
    (prisma.service.findFirst as jest.Mock).mockResolvedValue(null);

    await updateService(OWNER_ID, SERVICE_ID, { name: 'Ọlá Plumbing & Sons' });

    expect(saved()).toMatchObject({ name: 'Ọlá Plumbing & Sons', slug: 'ola-plumbing-sons' });
  });

  it('falls back to a random slug for a name with no letters or digits', async () => {
    editing(plainRow({ status: 'DRAFT' }));

    await updateService(OWNER_ID, SERVICE_ID, { name: '...' });

    expect(saved().slug).toMatch(/^service-[0-9a-f]{8}$/);
    expect(prisma.service.findFirst).not.toHaveBeenCalled();
  });

  it('keeps the slug when the name is unchanged', async () => {
    editing(plainRow({ status: 'DRAFT' }));

    await updateService(OWNER_ID, SERVICE_ID, { name: 'Generator Servicing' });

    expect(saved()).toEqual({ name: 'Generator Servicing' });
    expect(prisma.service.findFirst).not.toHaveBeenCalled();
  });

  it('refuses to move a service into an inactive category', async () => {
    editing(plainRow());
    (prisma.serviceCategory.findUnique as jest.Mock).mockResolvedValue({ id: 'cat-retired', isActive: false });

    await expect(updateService(OWNER_ID, SERVICE_ID, { categoryId: 'cat-retired' })).rejects.toMatchObject({
      message: 'Cannot add services to an inactive category',
      extensions: { code: 'CATEGORY_INACTIVE' },
    });
    expect(prisma.service.update).not.toHaveBeenCalled();
  });

  it("accepts the service's current category even if it has been deactivated since", async () => {
    editing(plainRow({ status: 'DRAFT' }));

    await updateService(OWNER_ID, SERVICE_ID, { categoryId: 'cat-generator', price: 30000 });

    expect(prisma.serviceCategory.findUnique).not.toHaveBeenCalled();
    expect(saved()).toEqual({ price: 30000 });
  });

  it.each([
    ['an http URL', 'http://res.cloudinary.com/easykonnet/image/upload/v1/services/a.jpg'],
    ['another Cloudinary account', 'https://res.cloudinary.com/someone-else/image/upload/v1/a.jpg'],
    ['another host', 'https://example.com/easykonnet/image/upload/v1/a.jpg'],
    ['a video upload', 'https://res.cloudinary.com/easykonnet/video/upload/v1/a.mp4'],
    ['a file name', 'generator.jpg'],
  ])('refuses an image from %s', async (_label, image) => {
    editing(plainRow({ status: 'DRAFT' }));

    await expect(updateService(OWNER_ID, SERVICE_ID, { images: [cloudImage('ok'), image] })).rejects.toMatchObject({
      message: 'Each image must be a photo uploaded to Easykonnet',
      extensions: { code: 'INVALID_IMAGE_URL' },
    });
    expect(prisma.service.update).not.toHaveBeenCalled();
  });

  it('refuses more than 10 images', async () => {
    editing(plainRow({ status: 'DRAFT' }));
    const images = Array.from({ length: 11 }, (_, index) => cloudImage(`photo-${index}`));

    await expect(updateService(OWNER_ID, SERVICE_ID, { images })).rejects.toMatchObject({
      message: 'A service can have at most 10 images',
      extensions: { code: 'MAX_IMAGES_EXCEEDED' },
    });
  });

  it("saves up to 10 of the platform's own images", async () => {
    editing(plainRow({ status: 'DRAFT' }));
    const images = Array.from({ length: 10 }, (_, index) => cloudImage(`photo-${index}`));

    await updateService(OWNER_ID, SERVICE_ID, { images });

    expect(saved().images).toEqual(images);
  });

  it('still flags a live listing whose images changed', async () => {
    editing(plainRow());

    await updateService(OWNER_ID, SERVICE_ID, { images: [cloudImage('new-photo')] });

    expect(flagContent).toHaveBeenCalledWith(
      expect.objectContaining({ targetType: 'SERVICE', targetId: SERVICE_ID, reason: 'OTHER' })
    );
  });

  it.each([
    ['Price', { price: 0 }],
    ['Price', { price: -500 }],
    ['Duration', { duration: 0 }],
  ])('refuses a %s of %j', async (label, edit) => {
    editing(plainRow());

    await expect(updateService(OWNER_ID, SERVICE_ID, edit)).rejects.toMatchObject({
      message: `${label} must be positive`,
      extensions: { code: 'INVALID_INPUT' },
    });
  });
});

// ==================
// createService
// ==================

describe('createService — names, slugs and images', () => {
  const input = {
    categoryId: 'cat-generator',
    name: 'AC/Fridge Repair & Servicing',
    description: 'Repairs and gas refills for air conditioners and fridges.',
    price: 18000,
    duration: 90,
  };

  const created = () => (prisma.service.create as jest.Mock).mock.calls[0][0].data;

  beforeEach(() => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue({
      id: OWNER_ID,
      role: 'SERVICE_PROVIDER',
      provider: providerRow,
    });
    (prisma.serviceCategory.findUnique as jest.Mock).mockResolvedValue({ id: 'cat-generator', isActive: true });
    (prisma.service.findFirst as jest.Mock).mockResolvedValue(null);
    (prisma.service.create as jest.Mock).mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      serviceRow({ ...data, id: SERVICE_ID })
    );
  });

  it('accepts common punctuation in the name and builds the slug from it', async () => {
    const service = await createService(OWNER_ID, input);

    expect(created()).toMatchObject({
      name: 'AC/Fridge Repair & Servicing',
      slug: 'ac-fridge-repair-servicing',
      images: [],
      status: 'DRAFT',
    });
    expect(service.name).toBe('AC/Fridge Repair & Servicing');
  });

  it('adds a random suffix when the provider already uses the slug', async () => {
    (prisma.service.findFirst as jest.Mock).mockResolvedValue({ id: '6504c6e0f1a2b3c4d5e6f7b9' });

    await createService(OWNER_ID, input);

    expect(prisma.service.findFirst).toHaveBeenCalledWith({
      where: { providerId: PROVIDER_ID, slug: 'ac-fridge-repair-servicing' },
      select: { id: true },
    });
    expect(created().slug).toMatch(/^ac-fridge-repair-servicing-[0-9a-f]{8}$/);
  });

  it('saves images uploaded to the platform', async () => {
    await createService(OWNER_ID, { ...input, images: [cloudImage('fridge')] });

    expect(created().images).toEqual([cloudImage('fridge')]);
  });

  it('refuses other image URLs and creates nothing', async () => {
    await expect(
      createService(OWNER_ID, { ...input, images: ['https://example.com/fridge.jpg'] })
    ).rejects.toMatchObject({ extensions: { code: 'INVALID_IMAGE_URL' } });
    expect(prisma.service.create).not.toHaveBeenCalled();
  });

  it('refuses a duration of 0', async () => {
    await expect(createService(OWNER_ID, { ...input, duration: 0 })).rejects.toMatchObject({
      message: 'Duration must be positive',
    });
    expect(prisma.service.create).not.toHaveBeenCalled();
  });
});

// ==================
// Moderation
// ==================

describe('approveService / rejectService / suspendService', () => {
  // The status check reads the service, then the response reads it again
  const deciding = (from: string, after: Record<string, unknown>) => {
    (prisma.service.findUnique as jest.Mock)
      .mockResolvedValueOnce(plainRow({ status: from }))
      .mockResolvedValueOnce(serviceRow(after));
    (prisma.service.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
  };

  describe('approveService', () => {
    it('makes a service pending approval live, tells the provider and writes the audit log', async () => {
      deciding('PENDING_APPROVAL', { status: 'ACTIVE' });

      const service = await approveService(SERVICE_ID, admin);

      expect(prisma.service.updateMany).toHaveBeenCalledWith({
        where: { id: SERVICE_ID, status: 'PENDING_APPROVAL' },
        data: { status: 'ACTIVE', rejectionReason: null, suspensionReason: null },
      });
      expect(service.status).toBe('ACTIVE');
      expect(notifyServiceApproved).toHaveBeenCalledWith(OWNER_ID, SERVICE_ID, 'Generator Servicing');
      expect(sendPushToUser).toHaveBeenCalledWith(OWNER_ID, {
        title: 'Service Approved',
        message: 'Your service "Generator Servicing" has been approved and is now live',
        data: { type: 'SERVICE', serviceId: SERVICE_ID, action: 'approved' },
      });
      expect(createAuditLog).toHaveBeenCalledWith({
        action: 'APPROVE_SERVICE',
        targetType: 'Service',
        targetId: SERVICE_ID,
        performedBy: ADMIN_ID,
        performedByRole: 'ADMIN',
        previousValue: { status: 'PENDING_APPROVAL' },
        newValue: { status: 'ACTIVE' },
        ipAddress: '203.0.113.5',
        userAgent: 'EasykonnetDashboard/1.0',
      });
    });

    it.each(['DRAFT', 'ACTIVE', 'INACTIVE'])('refuses a %s service', async (status) => {
      (prisma.service.findUnique as jest.Mock).mockResolvedValue(plainRow({ status }));

      await expect(approveService(SERVICE_ID, admin)).rejects.toMatchObject({
        message: 'Only services that are pending approval or suspended can be approved',
        extensions: { code: 'INVALID_STATUS' },
      });
      expect(prisma.service.updateMany).not.toHaveBeenCalled();
      expect(notifyServiceApproved).not.toHaveBeenCalled();
      expect(createAuditLog).not.toHaveBeenCalled();
    });

    it('reinstates a suspended service, clears the suspension reason and tells the provider', async () => {
      (prisma.service.findUnique as jest.Mock)
        .mockResolvedValueOnce(plainRow({ status: 'SUSPENDED', suspensionReason: 'Misleading photos' }))
        .mockResolvedValueOnce(serviceRow({ status: 'ACTIVE' }));
      (prisma.service.updateMany as jest.Mock).mockResolvedValue({ count: 1 });

      const service = await approveService(SERVICE_ID, admin);

      expect(prisma.service.updateMany).toHaveBeenCalledWith({
        where: { id: SERVICE_ID, status: 'SUSPENDED' },
        data: { status: 'ACTIVE', rejectionReason: null, suspensionReason: null },
      });
      expect(service).toMatchObject({ status: 'ACTIVE', suspensionReason: null });
      expect(notifyServiceApproved).not.toHaveBeenCalled();
      expect(createNotification).toHaveBeenCalledWith({
        userId: OWNER_ID,
        type: 'SERVICE_APPROVED',
        title: 'Service Reinstated',
        message: 'Your service "Generator Servicing" has been reinstated and is live again',
        entityType: 'service',
        entityId: SERVICE_ID,
      });
      expect(sendPushToUser).toHaveBeenCalledWith(OWNER_ID, {
        title: 'Service Reinstated',
        message: 'Your service "Generator Servicing" has been reinstated and is live again',
        data: { type: 'SERVICE', serviceId: SERVICE_ID, action: 'reinstated' },
      });
      expect(createAuditLog).toHaveBeenCalledWith({
        action: 'APPROVE_SERVICE',
        targetType: 'Service',
        targetId: SERVICE_ID,
        performedBy: ADMIN_ID,
        performedByRole: 'ADMIN',
        previousValue: { status: 'SUSPENDED', suspensionReason: 'Misleading photos' },
        newValue: { status: 'ACTIVE' },
        ipAddress: '203.0.113.5',
        userAgent: 'EasykonnetDashboard/1.0',
      });
    });

    it('refuses to reinstate when another admin changed the service first', async () => {
      (prisma.service.findUnique as jest.Mock).mockResolvedValue(plainRow({ status: 'SUSPENDED' }));
      (prisma.service.updateMany as jest.Mock).mockResolvedValue({ count: 0 });

      await expect(approveService(SERVICE_ID, admin)).rejects.toMatchObject({
        message: 'Only services that are pending approval or suspended can be approved',
        extensions: { code: 'INVALID_STATUS' },
      });
      expect(prisma.service.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: SERVICE_ID, status: 'SUSPENDED' } })
      );
      expect(createNotification).not.toHaveBeenCalled();
      expect(sendPushToUser).not.toHaveBeenCalled();
      expect(createAuditLog).not.toHaveBeenCalled();
    });

    it('refuses when another admin decided first', async () => {
      (prisma.service.findUnique as jest.Mock).mockResolvedValue(plainRow({ status: 'PENDING_APPROVAL' }));
      (prisma.service.updateMany as jest.Mock).mockResolvedValue({ count: 0 });

      await expect(approveService(SERVICE_ID, admin)).rejects.toMatchObject({
        extensions: { code: 'INVALID_STATUS' },
      });
      expect(notifyServiceApproved).not.toHaveBeenCalled();
      expect(createAuditLog).not.toHaveBeenCalled();
    });

    it('keeps the approval when notifying the provider fails', async () => {
      deciding('PENDING_APPROVAL', { status: 'ACTIVE' });
      (notifyServiceApproved as jest.Mock).mockRejectedValue(new Error('database unavailable'));
      (sendPushToUser as jest.Mock).mockRejectedValue(new Error('push provider unavailable'));
      const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);

      await expect(approveService(SERVICE_ID, admin)).resolves.toMatchObject({ status: 'ACTIVE' });
      expect(createAuditLog).toHaveBeenCalled();

      consoleError.mockRestore();
    });

    it('returns NOT_FOUND for a service that does not exist', async () => {
      (prisma.service.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(approveService(SERVICE_ID, admin)).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } });
    });
  });

  describe('rejectService', () => {
    it('sends a service pending approval back to DRAFT with the reason saved and sent', async () => {
      deciding('PENDING_APPROVAL', { status: 'DRAFT', rejectionReason: REASON });

      const service = await rejectService(
        SERVICE_ID,
        '  The photos show <b>another</b> company’s branding.  ',
        admin
      );

      expect(prisma.service.updateMany).toHaveBeenCalledWith({
        where: { id: SERVICE_ID, status: 'PENDING_APPROVAL' },
        data: { status: 'DRAFT', rejectionReason: REASON },
      });
      expect(service).toMatchObject({ status: 'DRAFT', rejectionReason: REASON });
      expect(notifyServiceRejected).toHaveBeenCalledWith(OWNER_ID, SERVICE_ID, 'Generator Servicing', REASON);
      expect(sendPushToUser).toHaveBeenCalledWith(
        OWNER_ID,
        expect.objectContaining({ data: { type: 'SERVICE', serviceId: SERVICE_ID, action: 'rejected' } })
      );
      expect(createAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'REJECT_SERVICE',
          targetId: SERVICE_ID,
          performedBy: ADMIN_ID,
          previousValue: { status: 'PENDING_APPROVAL' },
          newValue: { status: 'DRAFT' },
          reason: REASON,
        })
      );
    });

    it.each(['DRAFT', 'ACTIVE', 'INACTIVE', 'SUSPENDED'])('refuses a %s service', async (status) => {
      (prisma.service.findUnique as jest.Mock).mockResolvedValue(plainRow({ status }));

      await expect(rejectService(SERVICE_ID, REASON, admin)).rejects.toMatchObject({
        message: 'Only services pending approval can be rejected',
        extensions: { code: 'INVALID_STATUS' },
      });
      expect(prisma.service.updateMany).not.toHaveBeenCalled();
      expect(notifyServiceRejected).not.toHaveBeenCalled();
    });

    it.each([
      ['an empty reason', '', 'A reason is required'],
      ['a blank reason', '   ', 'A reason is required'],
      ['a reason that is only tags', '<p></p>', 'A reason is required'],
      ['a reason over 1000 characters', 'x'.repeat(1001), 'Reason must be at most 1000 characters'],
    ])('refuses %s before looking anything up', async (_label, reason, message) => {
      await expect(rejectService(SERVICE_ID, reason, admin)).rejects.toMatchObject({
        message,
        extensions: { code: 'INVALID_INPUT' },
      });
      expect(prisma.service.findUnique).not.toHaveBeenCalled();
    });
  });

  describe('suspendService', () => {
    const SUSPENSION = 'Several customers reported the listing as misleading.';

    it.each(['DRAFT', 'PENDING_APPROVAL', 'ACTIVE', 'INACTIVE'])(
      'suspends a %s service, saves the reason and tells the provider',
      async (status) => {
        deciding(status, { status: 'SUSPENDED', suspensionReason: SUSPENSION });

        const service = await suspendService(SERVICE_ID, SUSPENSION, admin);

        expect(prisma.service.updateMany).toHaveBeenCalledWith({
          where: { id: SERVICE_ID, status: { not: 'SUSPENDED' } },
          data: { status: 'SUSPENDED', suspensionReason: SUSPENSION },
        });
        expect(service).toMatchObject({ status: 'SUSPENDED', suspensionReason: SUSPENSION });
        expect(createNotification).toHaveBeenCalledWith({
          userId: OWNER_ID,
          type: 'SERVICE_SUSPENDED',
          title: 'Service Suspended',
          message: `Your service "Generator Servicing" has been suspended: ${SUSPENSION}`,
          entityType: 'service',
          entityId: SERVICE_ID,
        });
        expect(sendPushToUser).toHaveBeenCalledWith(OWNER_ID, {
          title: 'Service Suspended',
          message: `Your service "Generator Servicing" has been suspended: ${SUSPENSION}`,
          data: { type: 'SERVICE', serviceId: SERVICE_ID, action: 'suspended' },
        });
        expect(createAuditLog).toHaveBeenCalledWith({
          action: 'SUSPEND_SERVICE',
          targetType: 'Service',
          targetId: SERVICE_ID,
          performedBy: ADMIN_ID,
          performedByRole: 'ADMIN',
          previousValue: { status },
          newValue: { status: 'SUSPENDED' },
          reason: SUSPENSION,
          ipAddress: '203.0.113.5',
          userAgent: 'EasykonnetDashboard/1.0',
        });
      }
    );

    it('refuses a service that is already suspended', async () => {
      (prisma.service.findUnique as jest.Mock).mockResolvedValue(plainRow({ status: 'SUSPENDED' }));

      await expect(suspendService(SERVICE_ID, SUSPENSION, admin)).rejects.toMatchObject({
        message: 'Service is already suspended',
        extensions: { code: 'ALREADY_SUSPENDED' },
      });
      expect(prisma.service.updateMany).not.toHaveBeenCalled();
      expect(createNotification).not.toHaveBeenCalled();
    });

    it('works for a report decision, called with only the service and the reason', async () => {
      deciding('ACTIVE', { status: 'SUSPENDED', suspensionReason: SUSPENSION });

      await suspendService(SERVICE_ID, SUSPENSION);

      expect(prisma.service.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: 'SUSPENDED', suspensionReason: SUSPENSION } })
      );
      expect(createNotification).toHaveBeenCalledWith(expect.objectContaining({ type: 'SERVICE_SUSPENDED' }));
      expect(sendPushToUser).toHaveBeenCalled();
      // Report decisions write their own RESOLVE_REPORT entry
      expect(createAuditLog).not.toHaveBeenCalled();
    });

    it('refuses an empty reason', async () => {
      await expect(suspendService(SERVICE_ID, ' ', admin)).rejects.toMatchObject({
        message: 'A reason is required',
      });
      expect(prisma.service.findUnique).not.toHaveBeenCalled();
    });
  });
});

// ==================
// Rating and like counts
// ==================

describe('provider rating and like counts on service lists', () => {
  it('loads the counts once for every provider on the page', async () => {
    (prisma.service.findMany as jest.Mock).mockResolvedValue([
      serviceRow({ status: 'PENDING_APPROVAL' }),
      serviceRow({ id: '6504c6e0f1a2b3c4d5e6f7b9', status: 'PENDING_APPROVAL' }),
      serviceRow({
        id: '6504c6e0f1a2b3c4d5e6f7c0',
        status: 'PENDING_APPROVAL',
        providerId: OTHER_PROVIDER_ID,
        provider: { ...providerRow, id: OTHER_PROVIDER_ID },
      }),
    ]);
    (prisma.service.count as jest.Mock).mockResolvedValue(3);
    (prisma.review.groupBy as jest.Mock).mockResolvedValue([
      { providerId: PROVIDER_ID, _avg: { rating: 5 }, _count: { _all: 1 } },
    ]);

    const result = await getPendingServices({ page: 1, limit: 10 });

    expect(prisma.review.groupBy).toHaveBeenCalledTimes(1);
    expect(prisma.review.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({ where: { providerId: { in: [PROVIDER_ID, OTHER_PROVIDER_ID] } } })
    );
    expect(prisma.providerLike.groupBy).toHaveBeenCalledTimes(1);
    expect(result.items[0].provider).toMatchObject({ averageRating: 5, totalReviews: 1, likeCount: 0 });
    expect(result.items[2].provider).toMatchObject({ averageRating: 0, totalReviews: 0, likeCount: 0 });
  });
});
