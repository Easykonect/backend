/**
 * Community terms: which version a user accepted, and holding back posts until
 * they accept the current one
 */

jest.mock('@/lib/prisma', () => ({
  __esModule: true,
  default: { user: { findUnique: jest.fn(), update: jest.fn() } },
}));
jest.mock('@/config', () => ({
  config: { moderation: { termsVersion: '2026-09', requireTermsAcceptance: false } },
}));

import { config } from '@/config';
import prisma from '@/lib/prisma';
import { acceptTerms, assertTermsAccepted, getTermsStatus } from '@/services/terms.service';

const USER_ID = '66e2b4c1f0a9d83b5c7e1a01';
const acceptedAt = new Date('2026-09-01T08:30:00Z');
const NOW = new Date('2026-09-12T10:00:00Z');

const findUnique = prisma.user.findUnique as jest.Mock;
const update = prisma.user.update as jest.Mock;
const moderation = config.moderation as { termsVersion: string; requireTermsAcceptance: boolean };

beforeEach(() => {
  jest.resetAllMocks();
  moderation.termsVersion = '2026-09';
  moderation.requireTermsAcceptance = false;
});

afterEach(() => {
  jest.useRealTimers();
});

describe('getTermsStatus', () => {
  it('reports a missing user as not found', async () => {
    findUnique.mockResolvedValue(null);

    await expect(getTermsStatus(USER_ID)).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } });
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: USER_ID },
      select: { acceptedTermsVersion: true, acceptedTermsAt: true },
    });
  });

  it('asks a user who never accepted the terms to accept them', async () => {
    findUnique.mockResolvedValue({ acceptedTermsVersion: null, acceptedTermsAt: null });

    await expect(getTermsStatus(USER_ID)).resolves.toEqual({
      currentVersion: '2026-09',
      acceptedVersion: null,
      acceptedAt: null,
      mustAccept: true,
    });
  });

  it('asks a user who accepted an older version to accept the current one', async () => {
    findUnique.mockResolvedValue({ acceptedTermsVersion: '2026-01', acceptedTermsAt: acceptedAt });

    await expect(getTermsStatus(USER_ID)).resolves.toEqual({
      currentVersion: '2026-09',
      acceptedVersion: '2026-01',
      acceptedAt: '2026-09-01T08:30:00.000Z',
      mustAccept: true,
    });
  });

  it('does not ask a user who accepted the current version again', async () => {
    findUnique.mockResolvedValue({ acceptedTermsVersion: '2026-09', acceptedTermsAt: acceptedAt });

    await expect(getTermsStatus(USER_ID)).resolves.toEqual({
      currentVersion: '2026-09',
      acceptedVersion: '2026-09',
      acceptedAt: '2026-09-01T08:30:00.000Z',
      mustAccept: false,
    });
  });

  it('asks again once the terms version changes', async () => {
    moderation.termsVersion = '2026-12';
    findUnique.mockResolvedValue({ acceptedTermsVersion: '2026-09', acceptedTermsAt: acceptedAt });

    await expect(getTermsStatus(USER_ID)).resolves.toMatchObject({ currentVersion: '2026-12', mustAccept: true });
  });
});

describe('acceptTerms', () => {
  it.each(['2026-01', '2026-10', ''])('refuses version "%s" when the current version is 2026-09', async (version) => {
    await expect(acceptTerms(USER_ID, version)).rejects.toMatchObject({
      message: expect.stringContaining('2026-09'),
      extensions: { code: 'TERMS_VERSION_OUTDATED' },
    });
    expect(update).not.toHaveBeenCalled();
  });

  it('stores the accepted version and when it was accepted', async () => {
    jest.useFakeTimers({ now: NOW });
    update.mockImplementation(async ({ data }: { data: { acceptedTermsVersion: string; acceptedTermsAt: Date } }) => data);

    const status = await acceptTerms(USER_ID, '2026-09');

    expect(update).toHaveBeenCalledWith({
      where: { id: USER_ID },
      data: { acceptedTermsVersion: '2026-09', acceptedTermsAt: NOW },
      select: { acceptedTermsVersion: true, acceptedTermsAt: true },
    });
    expect(status).toEqual({
      currentVersion: '2026-09',
      acceptedVersion: '2026-09',
      acceptedAt: NOW.toISOString(),
      mustAccept: false,
    });
  });
});

describe('assertTermsAccepted', () => {
  it('lets everyone post without checking the database while acceptance is not required', async () => {
    await expect(assertTermsAccepted(USER_ID)).resolves.toBeUndefined();
    expect(findUnique).not.toHaveBeenCalled();
  });

  describe('when acceptance is required', () => {
    beforeEach(() => {
      moderation.requireTermsAcceptance = true;
    });

    it.each([
      ['a user who cannot be found', null],
      ['a user who never accepted the terms', { acceptedTermsVersion: null }],
      ['a user who accepted an older version', { acceptedTermsVersion: '2026-01' }],
    ])('stops %s from posting', async (_label, user) => {
      findUnique.mockResolvedValue(user);

      await expect(assertTermsAccepted(USER_ID)).rejects.toMatchObject({
        extensions: { code: 'TERMS_NOT_ACCEPTED' },
      });
    });

    it('lets a user who accepted the current version post', async () => {
      findUnique.mockResolvedValue({ acceptedTermsVersion: '2026-09' });

      await expect(assertTermsAccepted(USER_ID)).resolves.toBeUndefined();
      expect(findUnique).toHaveBeenCalledWith({
        where: { id: USER_ID },
        select: { acceptedTermsVersion: true },
      });
    });
  });
});
