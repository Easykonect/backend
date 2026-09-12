/**
 * Providers, services and categories: resolver access rules
 *
 * Covers:
 *   - categories(includeInactive: true) is for admins only
 *   - service(id) and services pass the signed-in viewer to the service layer
 *   - provider and service decisions pass the admin (with IP and user agent)
 *     for the audit log
 *   - Service.rejectionReason, Service.suspensionReason and
 *     ServiceProviderProfile.rejectionReason are only returned to the provider
 *     and admins
 *   - the schema has the new optional argument and nullable fields
 */

import { buildASTSchema, type GraphQLObjectType } from 'graphql';

jest.mock('@/lib/prisma', () => ({ __esModule: true, default: {} }));
// The Resend client throws at import time without an API key
jest.mock('@/lib/email', () => ({ __esModule: true, default: {} }));
jest.mock('@/services/category.service', () => ({
  ...jest.requireActual('@/services/category.service'),
  getCategories: jest.fn(),
}));
jest.mock('@/services/service.service', () => ({
  ...jest.requireActual('@/services/service.service'),
  getServices: jest.fn(),
  getServiceById: jest.fn(),
  approveService: jest.fn(),
  rejectService: jest.fn(),
  suspendService: jest.fn(),
}));
jest.mock('@/services/provider.service', () => ({
  ...jest.requireActual('@/services/provider.service'),
  approveProvider: jest.fn(),
  rejectProvider: jest.fn(),
}));

import { resolvers } from '@/graphql/resolvers';
import { typeDefs } from '@/graphql/schemas';
import { getCategories } from '@/services/category.service';
import {
  approveService,
  getServiceById,
  getServices,
  rejectService,
  suspendService,
} from '@/services/service.service';
import { approveProvider, rejectProvider } from '@/services/provider.service';
import type { GraphQLContext } from '@/middleware';

const OWNER_ID = '64f1c2a9e4b0a1b2c3d4e5f6';
const CUSTOMER_ID = '64f1c2a9e4b0a1b2c3d4e5f7';
const ADMIN_ID = '64f1c2a9e4b0a1b2c3d4e5f8';
const PROVIDER_ID = '6502a4c8d0e1f2a3b4c5d6f0';
const SERVICE_ID = '6504c6e0f1a2b3c4d5e6f7a8';

const contextFor = (userId: string, role: string, request?: Request): GraphQLContext =>
  ({ user: { userId, email: `${userId}@example.com`, role }, request }) as GraphQLContext;

const anonymous = { user: null } as GraphQLContext;

describe('categories(includeInactive)', () => {
  it('lists active categories for anyone who leaves the flag out', async () => {
    await resolvers.Query.categories({}, {}, anonymous);

    expect(getCategories).toHaveBeenCalledWith({ page: 1, limit: 50 }, false);
  });

  it.each([
    ['a guest', anonymous, 'UNAUTHENTICATED'],
    ['a customer', contextFor(CUSTOMER_ID, 'SERVICE_USER'), 'UNAUTHORIZED'],
    ['a provider', contextFor(OWNER_ID, 'SERVICE_PROVIDER'), 'UNAUTHORIZED'],
  ])('refuses includeInactive for %s', async (_label, context, code) => {
    await expect(resolvers.Query.categories({}, { includeInactive: true }, context)).rejects.toMatchObject({
      extensions: { code },
    });
    expect(getCategories).not.toHaveBeenCalled();
  });

  it.each(['ADMIN', 'SUPER_ADMIN'])('lets %s include inactive categories', async (role) => {
    await resolvers.Query.categories({}, { includeInactive: true }, contextFor(ADMIN_ID, role));

    expect(getCategories).toHaveBeenCalledWith({ page: 1, limit: 50 }, true);
  });

  it('treats includeInactive: false like leaving it out', async () => {
    await resolvers.Query.categories({}, { includeInactive: false }, anonymous);

    expect(getCategories).toHaveBeenCalledWith({ page: 1, limit: 50 }, false);
  });
});

describe('service(id) and services pass the viewer', () => {
  it('passes no viewer for a guest', async () => {
    await resolvers.Query.service({}, { id: SERVICE_ID }, anonymous);

    expect(getServiceById).toHaveBeenCalledWith(SERVICE_ID, null);
  });

  it('passes the signed-in user and role', async () => {
    await resolvers.Query.service({}, { id: SERVICE_ID }, contextFor(CUSTOMER_ID, 'SERVICE_USER'));

    expect(getServiceById).toHaveBeenCalledWith(SERVICE_ID, { userId: CUSTOMER_ID, role: 'SERVICE_USER' });
  });

  it('passes the role to services so admins can filter by status', async () => {
    await resolvers.Query.services({}, { filters: { status: 'SUSPENDED' } }, contextFor(ADMIN_ID, 'ADMIN'));

    expect(getServices).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'SUSPENDED', excludeProviderUserId: ADMIN_ID }),
      { page: 1, limit: 20 },
      'ADMIN'
    );
  });
});

describe('provider and service decisions pass the admin', () => {
  const request = new Request('https://api.easykonnet.com/api/graphql', {
    method: 'POST',
    headers: { 'user-agent': 'EasykonnetDashboard/1.0', 'x-forwarded-for': '203.0.113.7' },
  });
  const admin = contextFor(ADMIN_ID, 'ADMIN', request);
  const actor = {
    id: ADMIN_ID,
    role: 'ADMIN',
    ipAddress: expect.any(String),
    userAgent: 'EasykonnetDashboard/1.0',
  };

  it('approveProvider', async () => {
    await resolvers.Mutation.approveProvider({}, { providerId: PROVIDER_ID }, admin);
    expect(approveProvider).toHaveBeenCalledWith(PROVIDER_ID, actor);
  });

  it('rejectProvider', async () => {
    await resolvers.Mutation.rejectProvider({}, { providerId: PROVIDER_ID, reason: 'Unreadable CAC certificate' }, admin);
    expect(rejectProvider).toHaveBeenCalledWith(PROVIDER_ID, 'Unreadable CAC certificate', actor);
  });

  it('approveService', async () => {
    await resolvers.Mutation.approveService({}, { serviceId: SERVICE_ID }, admin);
    expect(approveService).toHaveBeenCalledWith(SERVICE_ID, actor);
  });

  it('rejectService', async () => {
    await resolvers.Mutation.rejectService({}, { serviceId: SERVICE_ID, reason: 'Blurry photos' }, admin);
    expect(rejectService).toHaveBeenCalledWith(SERVICE_ID, 'Blurry photos', actor);
  });

  it('suspendService', async () => {
    await resolvers.Mutation.suspendService({}, { serviceId: SERVICE_ID, reason: 'Misleading listing' }, admin);
    expect(suspendService).toHaveBeenCalledWith(SERVICE_ID, 'Misleading listing', actor);
  });

  it('refuses a provider', async () => {
    await expect(
      resolvers.Mutation.suspendService(
        {},
        { serviceId: SERVICE_ID, reason: 'Misleading listing' },
        contextFor(OWNER_ID, 'SERVICE_PROVIDER')
      )
    ).rejects.toThrow();
    expect(suspendService).not.toHaveBeenCalled();
  });
});

describe('rejection and suspension reasons are private', () => {
  const service = {
    provider: { userId: OWNER_ID },
    rejectionReason: 'Blurry photos',
    suspensionReason: 'Misleading listing',
  };
  const providerProfile = { userId: OWNER_ID, rejectionReason: 'Unreadable CAC certificate' };

  it.each([
    ['the provider', contextFor(OWNER_ID, 'SERVICE_PROVIDER')],
    ['an admin', contextFor(ADMIN_ID, 'ADMIN')],
    ['a super admin', contextFor(ADMIN_ID, 'SUPER_ADMIN')],
  ])('returns them to %s', (_label, context) => {
    expect(resolvers.Service.rejectionReason(service, {}, context)).toBe('Blurry photos');
    expect(resolvers.Service.suspensionReason(service, {}, context)).toBe('Misleading listing');
    expect(resolvers.ServiceProviderProfile.rejectionReason(providerProfile, {}, context)).toBe(
      'Unreadable CAC certificate'
    );
  });

  it.each([
    ['a customer', contextFor(CUSTOMER_ID, 'SERVICE_USER')],
    ['another provider', contextFor(CUSTOMER_ID, 'SERVICE_PROVIDER')],
    ['a guest', anonymous],
  ])('returns null to %s', (_label, context) => {
    expect(resolvers.Service.rejectionReason(service, {}, context)).toBeNull();
    expect(resolvers.Service.suspensionReason(service, {}, context)).toBeNull();
    expect(resolvers.ServiceProviderProfile.rejectionReason(providerProfile, {}, context)).toBeNull();
  });

  it('returns null when the parent has no owner to check', () => {
    expect(resolvers.Service.rejectionReason({ rejectionReason: 'Blurry photos' }, {}, contextFor(OWNER_ID, 'SERVICE_PROVIDER'))).toBeNull();
  });
});

describe('schema', () => {
  const schema = buildASTSchema(typeDefs);

  it('adds an optional includeInactive argument to categories', () => {
    const argument = schema.getQueryType()!.getFields().categories.args.find((arg) => arg.name === 'includeInactive');
    expect(argument?.type.toString()).toBe('Boolean');
  });

  it('adds nullable reason fields', () => {
    const service = schema.getType('Service') as GraphQLObjectType;
    const profile = schema.getType('ServiceProviderProfile') as GraphQLObjectType;

    expect(service.getFields().rejectionReason.type.toString()).toBe('String');
    expect(service.getFields().suspensionReason.type.toString()).toBe('String');
    expect(profile.getFields().rejectionReason.type.toString()).toBe('String');
  });
});
