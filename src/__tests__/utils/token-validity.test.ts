/**
 * Ending every session at once: the Redis "tokens invalid before" timestamp, and
 * the issue-time claims that let a token issued moments later stay valid
 */

jest.mock('@/lib/redis', () => ({
  __esModule: true,
  default: { getInstance: jest.fn(), connect: jest.fn() },
}));

// Tokens are signed for real, so don't depend on JWT_SECRET being set locally
jest.mock('@/config', () => {
  const actual = jest.requireActual('@/config');
  return { ...actual, config: { ...actual.config, jwt: { ...actual.config.jwt, secret: 'test-jwt-secret' } } };
});

import jwt from 'jsonwebtoken';
import RedisClient from '@/lib/redis';
import { config } from '@/config';
import {
  generateRefreshToken,
  generateToken,
  getTokenIssuedAtMs,
  verifyAccessToken,
  verifyRefreshToken,
} from '@/lib/auth';
import { invalidateAllUserTokens, isIssuedAfter, isTokenValid } from '@/utils/security';

const USER_ID = '507f1f77bcf86cd799439011';
const KEY = `user:tokens_invalid_before:${USER_ID}`;

const client = {
  get: jest.fn(),
  setex: jest.fn(),
};

beforeEach(() => {
  (RedisClient.getInstance as jest.Mock).mockReturnValue(client);
  client.get.mockResolvedValue(null);
  client.setex.mockResolvedValue('OK');
});

describe('issued tokens', () => {
  const payload = { userId: USER_ID, email: 'ada@example.com', role: 'SERVICE_USER' as const };

  it('carry a unique ID and a millisecond issue time', () => {
    const before = Date.now();
    const first = verifyAccessToken(generateToken(payload));
    const second = verifyRefreshToken(generateRefreshToken(payload));

    expect(first.jti).toEqual(expect.any(String));
    expect(second.jti).toEqual(expect.any(String));
    expect(first.jti).not.toBe(second.jti);
    expect(first.iatMs).toBeGreaterThanOrEqual(before);
    expect(getTokenIssuedAtMs(first)).toBe(first.iatMs);
  });

  it('fall back to whole-second iat for tokens issued before iatMs', () => {
    const legacy = jwt.verify(
      jwt.sign({ ...payload, typ: 'access' }, config.jwt.secret),
      config.jwt.secret
    ) as { iat: number };

    expect(getTokenIssuedAtMs(legacy)).toBe(legacy.iat * 1000);
    expect(getTokenIssuedAtMs({})).toBeNull();
  });
});

describe('invalidateAllUserTokens', () => {
  it('stores the time in milliseconds', async () => {
    const before = Date.now();
    await invalidateAllUserTokens(USER_ID);

    const [key, , value] = client.setex.mock.calls[0];
    expect(key).toBe(KEY);
    expect(Number(value)).toBeGreaterThanOrEqual(before);
  });

  it("logs instead of failing when Redis is down, since tokenInvalidatedAt is the durable record", async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    client.setex.mockRejectedValue(new Error('Connection is closed'));

    await expect(invalidateAllUserTokens(USER_ID)).resolves.toBeUndefined();
  });
});

describe('isTokenValid', () => {
  const cutoffMs = 1_700_000_000_400;

  it('keeps a token issued in the same second, just after the cutoff', async () => {
    client.get.mockResolvedValue(String(cutoffMs));
    await expect(isTokenValid(USER_ID, 1_700_000_000, cutoffMs + 100)).resolves.toBe(true);
  });

  it('rejects a token issued before the cutoff', async () => {
    client.get.mockResolvedValue(String(cutoffMs));
    await expect(isTokenValid(USER_ID, 1_700_000_000, cutoffMs - 100)).resolves.toBe(false);
  });

  it('rejects a token without iatMs issued during the cutoff second', async () => {
    client.get.mockResolvedValue(String(cutoffMs));
    await expect(isTokenValid(USER_ID, 1_700_000_000)).resolves.toBe(false);
  });

  it('reads timestamps stored in seconds the way it always did', async () => {
    client.get.mockResolvedValue('1700000000');

    await expect(isTokenValid(USER_ID, 1_700_000_000, 1_700_000_000_900)).resolves.toBe(false);
    await expect(isTokenValid(USER_ID, 1_700_000_001)).resolves.toBe(true);
  });

  it('allows every token when nothing was invalidated or Redis fails', async () => {
    await expect(isTokenValid(USER_ID, 1)).resolves.toBe(true);

    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    client.get.mockRejectedValue(new Error('Connection is closed'));
    await expect(isTokenValid(USER_ID, 1)).resolves.toBe(true);
  });
});

describe('isIssuedAfter', () => {
  it('needs a known issue time strictly after the cutoff', () => {
    expect(isIssuedAfter(1001, 1000)).toBe(true);
    expect(isIssuedAfter(1000, 1000)).toBe(false);
    expect(isIssuedAfter(null, 1000)).toBe(false);
  });
});
