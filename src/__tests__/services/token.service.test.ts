/**
 * Token store: refresh token lookups that tell a revoked token from an
 * unavailable store, single access token revocation, and signing out everywhere
 */

jest.mock('@/lib/redis', () => ({
  __esModule: true,
  default: { getInstance: jest.fn(), connect: jest.fn() },
}));

jest.mock('@/utils/security', () => ({
  invalidateAllUserTokens: jest.fn(),
}));

import RedisClient from '@/lib/redis';
import { invalidateAllUserTokens as invalidateTokensIssuedBefore } from '@/utils/security';
import {
  checkRefreshToken,
  endAllSessions,
  isAccessTokenRevoked,
  revokeAccessToken,
  storeRefreshToken,
  validateRefreshToken,
} from '@/services/token.service';

const USER_ID = '507f1f77bcf86cd799439011';

const createClient = (status = 'ready') => {
  const store = new Map<string, string>();
  const sets = new Map<string, Set<string>>();
  return {
    status,
    store,
    setex: jest.fn(async (key: string, _ttl: number, value: string) => {
      store.set(key, value);
      return 'OK';
    }),
    get: jest.fn(async (key: string) => store.get(key) ?? null),
    exists: jest.fn(async (...keys: string[]) => keys.filter((key) => store.has(key)).length),
    del: jest.fn(async (key: string) => (store.delete(key) ? 1 : 0)),
    sadd: jest.fn(async (key: string, member: string) => {
      sets.set(key, (sets.get(key) ?? new Set()).add(member));
      return 1;
    }),
    srem: jest.fn(),
    expire: jest.fn(),
    smembers: jest.fn(async (key: string) => [...(sets.get(key) ?? [])]),
  };
};

let client: ReturnType<typeof createClient>;

beforeEach(() => {
  client = createClient();
  (RedisClient.connect as jest.Mock).mockResolvedValue(client);
  (RedisClient.getInstance as jest.Mock).mockReturnValue(client);
});

describe('checkRefreshToken', () => {
  it('finds a stored token', async () => {
    await storeRefreshToken(USER_ID, 'refresh-1');
    await expect(checkRefreshToken('refresh-1')).resolves.toEqual({ status: 'active', userId: USER_ID });
  });

  it('reports a token that was never stored as revoked', async () => {
    await expect(checkRefreshToken('unknown')).resolves.toEqual({ status: 'revoked' });
  });

  it('reports a revoked token as revoked', async () => {
    await storeRefreshToken(USER_ID, 'refresh-1');
    await endAllSessions(USER_ID);
    await expect(checkRefreshToken('refresh-1')).resolves.toEqual({ status: 'revoked' });
  });

  it('reports an unreachable store as unavailable, not revoked', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    (RedisClient.connect as jest.Mock).mockRejectedValue(new Error('Redis is not ready'));

    await expect(checkRefreshToken('refresh-1')).resolves.toEqual({ status: 'unavailable' });
    await expect(validateRefreshToken('refresh-1')).resolves.toBeNull();
  });
});

describe('endAllSessions', () => {
  it('revokes stored refresh tokens and rejects earlier access tokens', async () => {
    await storeRefreshToken(USER_ID, 'refresh-1');
    await storeRefreshToken(USER_ID, 'refresh-2');

    await endAllSessions(USER_ID);

    await expect(validateRefreshToken('refresh-1')).resolves.toBeNull();
    await expect(validateRefreshToken('refresh-2')).resolves.toBeNull();
    expect(invalidateTokensIssuedBefore).toHaveBeenCalledWith(USER_ID);
  });
});

describe('access token revocation', () => {
  const nowSeconds = () => Math.floor(Date.now() / 1000);
  const payload = (overrides: Record<string, unknown> = {}) => ({
    userId: USER_ID,
    email: 'ada@example.com',
    role: 'SERVICE_USER' as const,
    jti: 'token-id-1',
    exp: nowSeconds() + 3600,
    ...overrides,
  });

  it('revokes a token by its ID and hash until it expires', async () => {
    await revokeAccessToken(payload(), 'access-token');

    expect(client.setex).toHaveBeenCalledTimes(2);
    for (const [key, ttl] of client.setex.mock.calls) {
      expect(key).toMatch(/^access_token_denylist:/);
      expect(ttl).toBeGreaterThan(3590);
      expect(ttl).toBeLessThanOrEqual(3600);
    }
    await expect(isAccessTokenRevoked(payload(), 'access-token')).resolves.toBe(true);
  });

  it('sees the revocation from the token ID alone, as socket connections check it', async () => {
    await revokeAccessToken(payload(), 'access-token');
    await expect(isAccessTokenRevoked(payload())).resolves.toBe(true);
  });

  it('sees the revocation of a token without an ID from its hash', async () => {
    await revokeAccessToken(payload({ jti: undefined }), 'legacy-token');

    await expect(isAccessTokenRevoked(payload({ jti: undefined }), 'legacy-token')).resolves.toBe(true);
    await expect(isAccessTokenRevoked(payload({ jti: undefined }), 'other-token')).resolves.toBe(false);
  });

  it("doesn't store anything for an expired token", async () => {
    await revokeAccessToken(payload({ exp: nowSeconds() - 10 }), 'access-token');
    expect(client.setex).not.toHaveBeenCalled();
  });

  it('lets tokens through when Redis fails, instead of signing everyone out', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    client.exists.mockRejectedValue(new Error('Connection is closed'));

    await expect(isAccessTokenRevoked(payload(), 'access-token')).resolves.toBe(false);
  });

  it("doesn't wait for a reconnect on every request", async () => {
    client.status = 'reconnecting';

    await isAccessTokenRevoked(payload(), 'access-token');

    expect(RedisClient.connect).not.toHaveBeenCalled();
    expect(client.exists).toHaveBeenCalled();
  });
});
