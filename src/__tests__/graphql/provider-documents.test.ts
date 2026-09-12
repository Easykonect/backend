/**
 * Provider documents and profiles through the resolvers
 *
 * Covers:
 *   - ServiceProviderProfile.documents returns private files as signed download
 *     links that expire, and older public URLs unchanged
 *   - addProviderDocuments is provider-only and saves as the signed-in user
 *   - providerProfile passes the viewer to the service
 */

import { createHash } from 'crypto';

jest.mock('@/lib/prisma', () => ({ __esModule: true, default: {} }));
// The Resend client throws at import time without an API key
jest.mock('@/lib/email', () => ({ __esModule: true, default: {} }));
jest.mock('@/config', () => {
  const actual = jest.requireActual<typeof import('@/config')>('@/config');
  return {
    ...actual,
    config: {
      ...actual.config,
      cloudinary: { cloudName: 'easykonnet', apiKey: '123456789012345', apiSecret: 'test-secret' },
    },
  };
});
jest.mock('@/services/upload.service', () => ({
  ...jest.requireActual('@/services/upload.service'),
  addProviderDocuments: jest.fn(),
}));
jest.mock('@/services/browse.service', () => ({
  ...jest.requireActual('@/services/browse.service'),
  getProviderPublicProfile: jest.fn(),
}));

import { resolvers } from '@/graphql/resolvers';
import { addProviderDocuments } from '@/services/upload.service';
import { getProviderPublicProfile } from '@/services/browse.service';
import type { GraphQLContext } from '@/middleware';

const contextFor = (userId: string, role: string): GraphQLContext =>
  ({ user: { userId, email: `${userId}@example.com`, role } }) as GraphQLContext;

const ownerId = '507f1f77bcf86cd799439011';
const publicDocument = `https://res.cloudinary.com/easykonnet/image/upload/v1789218000/easykonect/documents/${ownerId}_1789218000123.jpg`;
const privateDocument = `https://res.cloudinary.com/easykonnet/image/authenticated/v1789218000/easykonect/documents/${ownerId}_1789218000456_a1b2c3.pdf`;
const privateRawDocument = `https://res.cloudinary.com/easykonnet/raw/authenticated/v1789218000/easykonect/documents/${ownerId}_1789218000789_d4e5f6`;

/**
 * The signature Cloudinary expects on a download link: SHA-1 of the sorted
 * parameters (without api_key and signature) followed by the API secret
 */
const expectedSignature = (params: URLSearchParams, secret: string) => {
  const signed = [...params.entries()]
    .filter(([key]) => key !== 'api_key' && key !== 'signature')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
  return createHash('sha1').update(signed + secret).digest('hex');
};

describe('ServiceProviderProfile.documents links', () => {
  const resolve = resolvers.ServiceProviderProfile.documents;
  const profile = { userId: ownerId, documents: [publicDocument, privateDocument, privateRawDocument] };

  it('keeps older public document URLs as they are', () => {
    const [link] = resolve(profile, {}, contextFor(ownerId, 'SERVICE_PROVIDER'));
    expect(link).toBe(publicDocument);
  });

  it('turns private documents into signed download links that expire after 30 minutes', () => {
    const before = Math.floor(Date.now() / 1000);
    const [, link] = resolve(profile, {}, contextFor(ownerId, 'SERVICE_PROVIDER'));

    const url = new URL(link);
    expect(`${url.origin}${url.pathname}`).toBe('https://api.cloudinary.com/v1_1/easykonnet/image/download');
    expect(url.searchParams.get('public_id')).toBe(`easykonect/documents/${ownerId}_1789218000456_a1b2c3`);
    expect(url.searchParams.get('format')).toBe('pdf');
    expect(url.searchParams.get('type')).toBe('authenticated');
    expect(url.searchParams.get('api_key')).toBe('123456789012345');

    const expiresAt = Number(url.searchParams.get('expires_at'));
    expect(expiresAt).toBeGreaterThanOrEqual(before + 30 * 60);
    expect(expiresAt).toBeLessThanOrEqual(before + 30 * 60 + 5);

    expect(url.searchParams.get('signature')).toBe(expectedSignature(url.searchParams, 'test-secret'));
    expect(link).not.toContain('test-secret');
  });

  it('signs raw documents without a format', () => {
    const [, , link] = resolve(profile, {}, contextFor(ownerId, 'SERVICE_PROVIDER'));

    const url = new URL(link);
    expect(url.pathname).toBe('/v1_1/easykonnet/raw/download');
    expect(url.searchParams.get('public_id')).toBe(`easykonect/documents/${ownerId}_1789218000789_d4e5f6`);
    expect(url.searchParams.has('format')).toBe(false);
  });

  it('gives admins the same links and everyone else nothing', () => {
    const adminLinks = resolve(profile, {}, contextFor('admin-user', 'ADMIN'));
    expect(adminLinks[0]).toBe(publicDocument);
    expect(adminLinks[1]).toMatch(/^https:\/\/api\.cloudinary\.com\/v1_1\/easykonnet\/image\/download\?/);

    expect(resolve(profile, {}, contextFor('customer-user', 'SERVICE_USER'))).toEqual([]);
    expect(resolve(profile, {}, { user: null } as GraphQLContext)).toEqual([]);
  });

  it("returns another account's URLs unchanged, since they can't be signed", () => {
    const foreign = privateDocument.replace('/easykonnet/', '/someone-else/');
    expect(resolve({ userId: ownerId, documents: [foreign] }, {}, contextFor(ownerId, 'SERVICE_PROVIDER'))).toEqual([foreign]);
  });
});

describe('addProviderDocuments resolver', () => {
  const add = resolvers.Mutation.addProviderDocuments;

  it.each(['SERVICE_USER', 'ADMIN', 'SUPER_ADMIN'])('refuses %s', async (role) => {
    await expect(add(undefined, { documentUrls: [privateDocument] }, contextFor(ownerId, role))).rejects.toMatchObject({
      message: 'You do not have permission to perform this action',
      extensions: { code: 'UNAUTHORIZED' },
    });
    expect(addProviderDocuments).not.toHaveBeenCalled();
  });

  it('saves the documents as the signed-in provider and reports how many were added', async () => {
    const links = ['https://api.cloudinary.com/v1_1/easykonnet/image/download?public_id=x'];
    (addProviderDocuments as jest.Mock).mockResolvedValue(links);

    const result = await add(undefined, { documentUrls: [privateDocument] }, contextFor(ownerId, 'SERVICE_PROVIDER'));

    expect(addProviderDocuments).toHaveBeenCalledWith(ownerId, [privateDocument]);
    expect(result).toEqual({ success: true, urls: links, message: '1 document(s) added successfully' });
  });
});

describe('providerProfile resolver', () => {
  const providerId = '650a3b7c9d2e1f4a5b6c7d80';

  it('passes the signed-in viewer to the service', async () => {
    (getProviderPublicProfile as jest.Mock).mockResolvedValue({ id: providerId });
    const context = contextFor(ownerId, 'SERVICE_USER');

    await resolvers.Query.providerProfile(undefined, { providerId }, context);

    expect(getProviderPublicProfile).toHaveBeenCalledWith(providerId, context.user);
  });

  it('passes no viewer when signed out', async () => {
    (getProviderPublicProfile as jest.Mock).mockResolvedValue({ id: providerId });

    await resolvers.Query.providerProfile(undefined, { providerId }, { user: null } as GraphQLContext);

    expect(getProviderPublicProfile).toHaveBeenCalledWith(providerId, null);
  });
});
