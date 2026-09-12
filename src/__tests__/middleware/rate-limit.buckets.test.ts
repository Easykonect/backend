/**
 * Strict rate limit buckets that are kept apart: asking for a reset code vs
 * entering one, password changes, and blocking vs reporting
 */

jest.mock('@/config', () => ({
  config: {
    isDevelopment: false,
    isProduction: false,
    redisUrl: 'redis://localhost:6379',
    jwt: { secret: 'test-secret', expiresIn: '15m', refreshExpiresIn: '30d' },
    bcrypt: { saltRounds: 4 },
    security: {
      trustedProxyCount: 1,
      rateLimitReadsPerMinute: 300,
      rateLimitWritesPerMinute: 60,
      rateLimitAnonymousPerMinute: 300,
      graphqlMaxDepth: 10,
      graphqlMaxRootFields: 20,
      graphqlMaxAliases: 30,
    },
  },
}));

// Redis client for src/lib/redis.ts; EVALSHA runs the sliding window script's logic in memory
const mockRedis = {
  status: 'ready',
  on: jest.fn(),
  script: jest.fn(),
  evalsha: jest.fn(),
  exists: jest.fn(),
  set: jest.fn(),
};

jest.mock('ioredis', () => ({ __esModule: true, default: jest.fn(() => mockRedis) }));

import { generateToken } from '@/lib/auth';
import {
  analyzeGraphQLRequest,
  checkGraphQLRateLimit,
  type GraphQLRequestParams,
} from '@/middleware/rate-limit.middleware';

const sortedSets = new Map<string, number[]>();

/** What the Lua script does, on in-memory scores */
const runScript = async (
  _sha: string,
  _numKeys: number,
  key: string,
  limit: number,
  windowMs: number,
  now: number,
  cost: number
): Promise<number[]> => {
  const scores = (sortedSets.get(key) ?? []).filter((score) => score > now - windowMs);
  sortedSets.set(key, scores);
  if (scores.length + cost <= limit) {
    scores.push(...new Array<number>(cost).fill(now));
    return [1, limit - scores.length, scores[0] + windowMs - now];
  }
  const blocking = cost <= limit ? scores[scores.length + cost - limit - 1] : now;
  return [0, Math.max(limit - scores.length, 0), blocking + windowMs - now];
};

let clock = Date.UTC(2026, 0, 1);

beforeEach(() => {
  clock += 2 * 60 * 60 * 1000;
  jest.spyOn(Date, 'now').mockImplementation(() => clock);
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
  sortedSets.clear();
  mockRedis.script.mockResolvedValue('sliding-window-sha');
  mockRedis.evalsha.mockImplementation(runScript);
});

const CLIENT_IP = '203.0.113.5';
const account = { userId: 'user-1', email: 'ada@example.com', role: 'SERVICE_USER' as const };

const requestFrom = (headers: Record<string, string> = {}) =>
  new Request('https://api.example.com/api/graphql', {
    method: 'POST',
    headers: { 'x-forwarded-for': `198.51.100.99, ${CLIENT_IP}`, ...headers },
  });

const signedIn = () => requestFrom({ authorization: `Bearer ${generateToken(account)}` });

const send = (query: string, request = requestFrom()) =>
  checkGraphQLRateLimit(request, analyzeGraphQLRequest({ query } as GraphQLRequestParams));

const repeat = async (times: number, query: string, request: () => Request = requestFrom) => {
  let last = await send(query, request());
  for (let i = 1; i < times; i++) {
    clock += 1000;
    last = await send(query, request());
  }
  return last;
};

describe('password reset', () => {
  const forgot = 'mutation { forgotPassword(input: { email: "ada@example.com" }) { message } }';
  const reset = 'mutation { resetPassword(input: { email: "ada@example.com", otp: "123456", newPassword: "N3w!Pass" }) { message } }';

  it('limits asking for a code to 3 per hour per email', async () => {
    expect(await repeat(3, forgot)).toMatchObject({ limited: false });
    expect(await send(forgot)).toMatchObject({ limited: true, limit: 3 });
  });

  it('counts entering a code separately, so asking for codes never blocks entering one', async () => {
    await repeat(3, forgot);
    expect(await send(forgot)).toMatchObject({ limited: true });

    expect(await send(reset)).toMatchObject({ limited: false });
  });

  it('limits entering a code to 10 per hour per email', async () => {
    expect(await repeat(10, reset)).toMatchObject({ limited: false });
    expect(await send(reset)).toMatchObject({ limited: true, limit: 10 });
  });
});

describe('password change', () => {
  const change = 'mutation { changePassword(input: { currentPassword: "guess", newPassword: "N3w!Pass" }) { message } }';

  it('limits a signed-in user to 5 password changes per 15 minutes', async () => {
    expect(await repeat(5, change, signedIn)).toMatchObject({ limited: false });
    expect(await send(change, signedIn())).toMatchObject({ limited: true, limit: 5 });
  });
});

describe('blocking and reporting', () => {
  const report = 'mutation { createReport(input: { targetType: USER, targetId: "64f1c2a9e4b0a1b2c3d4e5f6", reason: SPAM }) { id } }';
  const block = 'mutation { blockUser(userId: "64f1c2a9e4b0a1b2c3d4e5f6") { message } }';

  it('keeps separate buckets, so reaching the report limit still allows blocking', async () => {
    expect(await repeat(10, report, signedIn)).toMatchObject({ limited: false });
    expect(await send(report, signedIn())).toMatchObject({ limited: true, limit: 10 });

    expect(await send(block, signedIn())).toMatchObject({ limited: false });
  });

  it('limits blocking to 20 per hour', async () => {
    expect(await repeat(20, block, signedIn)).toMatchObject({ limited: false });
    expect(await send(block, signedIn())).toMatchObject({ limited: true, limit: 20 });
  });
});
