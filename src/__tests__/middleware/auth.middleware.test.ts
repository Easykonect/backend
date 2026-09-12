/**
 * Per-request account checks
 */

jest.mock('@/lib/prisma', () => ({
  __esModule: true,
  default: { user: { findUnique: jest.fn() } },
}));

jest.mock('@/utils/security', () => ({
  ...jest.requireActual('@/utils/security'),
  isTokenValid: jest.fn(),
}));

jest.mock('@/services/token.service', () => ({
  isAccessTokenRevoked: jest.fn(),
}));

// Tokens are signed for real, so don't depend on JWT_SECRET being set locally
jest.mock('@/config', () => {
  const actual = jest.requireActual('@/config');
  return { ...actual, config: { ...actual.config, jwt: { ...actual.config.jwt, secret: 'test-jwt-secret' } } };
});

import prisma from '@/lib/prisma';
import { generateToken, generateRefreshToken } from '@/lib/auth';
import { isTokenValid, isBanActive } from '@/utils/security';
import { isAccessTokenRevoked } from '@/services/token.service';
import { getAuthContext, getBearerToken, isSessionAllowed } from '@/middleware/auth.middleware';

const DAY_MS = 24 * 60 * 60 * 1000;

const payload = {
  userId: '507f1f77bcf86cd799439011',
  email: 'ada@example.com',
  role: 'SERVICE_PROVIDER' as const,
  iat: 1_700_000_000,
  iatMs: 1_700_000_000_500,
  jti: 'token-id',
};

const account = (overrides: Record<string, unknown> = {}) => ({
  role: 'SERVICE_PROVIDER',
  status: 'ACTIVE',
  bannedAt: null,
  bannedUntil: null,
  tokenInvalidatedAt: null,
  ...overrides,
});

const findUser = prisma.user.findUnique as jest.Mock;

beforeEach(() => {
  (isTokenValid as jest.Mock).mockResolvedValue(true);
  (isAccessTokenRevoked as jest.Mock).mockResolvedValue(false);
});

describe('isSessionAllowed', () => {
  it('allows an active account with the role the token was issued for', async () => {
    findUser.mockResolvedValue(account());
    await expect(isSessionAllowed(payload)).resolves.toBe(true);
  });

  it.each([
    ['deleted', null],
    ['suspended', account({ status: 'SUSPENDED' })],
    ['deactivated', account({ status: 'DEACTIVATED' })],
    ['permanently banned', account({ bannedAt: new Date() })],
    ['temporarily banned', account({ bannedAt: new Date(), bannedUntil: new Date(Date.now() + 7 * DAY_MS) })],
    ['demoted', account({ role: 'SERVICE_USER' })],
  ])('rejects a %s account', async (_label, record) => {
    findUser.mockResolvedValue(record);
    await expect(isSessionAllowed(payload)).resolves.toBe(false);
  });

  it('allows an account whose ban has expired', async () => {
    findUser.mockResolvedValue(
      account({ bannedAt: new Date(Date.now() - 14 * DAY_MS), bannedUntil: new Date(Date.now() - DAY_MS) })
    );
    await expect(isSessionAllowed(payload)).resolves.toBe(true);
  });

  it('rejects a revoked token without loading the account', async () => {
    (isTokenValid as jest.Mock).mockResolvedValue(false);
    await expect(isSessionAllowed(payload)).resolves.toBe(false);
    expect(findUser).not.toHaveBeenCalled();
  });

  it('passes the token issue time in milliseconds to the Redis check', async () => {
    findUser.mockResolvedValue(account());
    await isSessionAllowed(payload);
    expect(isTokenValid).toHaveBeenCalledWith(payload.userId, payload.iat, payload.iatMs);
  });

  it('rejects a token signed out with logout', async () => {
    (isAccessTokenRevoked as jest.Mock).mockResolvedValue(true);
    await expect(isSessionAllowed(payload, 'raw-token')).resolves.toBe(false);
    expect(isAccessTokenRevoked).toHaveBeenCalledWith(payload, 'raw-token');
  });

  describe('tokenInvalidatedAt (password change, deactivation, admin ban or forced sign-out)', () => {
    it('rejects a token issued before sessions were ended', async () => {
      findUser.mockResolvedValue(account({ tokenInvalidatedAt: new Date(payload.iatMs + 1) }));
      await expect(isSessionAllowed(payload)).resolves.toBe(false);
    });

    it('allows a token issued in the same second, just after sessions were ended', async () => {
      findUser.mockResolvedValue(account({ tokenInvalidatedAt: new Date(payload.iatMs - 200) }));
      await expect(isSessionAllowed(payload)).resolves.toBe(true);
    });

    it('rejects an older token without iatMs issued in that second', async () => {
      const { iatMs: _omitted, ...legacy } = payload;
      findUser.mockResolvedValue(account({ tokenInvalidatedAt: new Date(payload.iat * 1000 + 200) }));
      await expect(isSessionAllowed(legacy)).resolves.toBe(false);
    });
  });
});

describe('getAuthContext', () => {
  const request = (authorization?: string) =>
    new Request('http://localhost/api/graphql', {
      headers: authorization ? { authorization } : {},
    });

  const tokenPayload = { userId: payload.userId, email: payload.email, role: payload.role };

  it('signs the request in with a valid access token, checking it against sign-outs', async () => {
    findUser.mockResolvedValue(account());
    const token = generateToken(tokenPayload);

    const context = await getAuthContext(request(`Bearer ${token}`));

    expect(context.user?.userId).toBe(payload.userId);
    expect(isAccessTokenRevoked).toHaveBeenCalledWith(expect.objectContaining({ userId: payload.userId }), token);
  });

  it('treats a revoked access token as no token', async () => {
    findUser.mockResolvedValue(account());
    (isAccessTokenRevoked as jest.Mock).mockResolvedValue(true);

    const context = await getAuthContext(request(`Bearer ${generateToken(tokenPayload)}`));

    expect(context.user).toBeNull();
  });

  it('ignores a refresh token sent as a bearer token', async () => {
    const context = await getAuthContext(request(`Bearer ${generateRefreshToken(tokenPayload)}`));
    expect(context.user).toBeNull();
  });

  it('reads only Bearer authorization headers', () => {
    expect(getBearerToken(request('Bearer abc'))).toBe('abc');
    expect(getBearerToken(request('Basic abc'))).toBeNull();
    expect(getBearerToken(request())).toBeNull();
    expect(getBearerToken(undefined)).toBeNull();
  });
});

describe('isBanActive', () => {
  it('is false for an account that was never banned', () => {
    expect(isBanActive({ bannedAt: null, bannedUntil: null })).toBe(false);
  });
});
