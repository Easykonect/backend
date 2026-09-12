/**
 * GraphQL rate limits: who the client is, which limits a request hits, the atomic
 * Redis check with its in-memory fallback, and the IP blocklist
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
      rateLimitAnonymousPerMinute: 120,
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

import { createHash } from 'crypto';
import jwt from 'jsonwebtoken';
import { config } from '@/config';
import { generateRefreshToken, generateToken } from '@/lib/auth';
import { rateLimit } from '@/lib/redis';
import {
  analyzeGraphQLRequest,
  blockIp,
  checkGraphQLRateLimit,
  getClientIp,
  getRateLimitUserId,
  isBlockedIp,
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
  // Start each test past the longest window (an hour) so tests don't share counts
  clock += 2 * 60 * 60 * 1000;
  jest.spyOn(Date, 'now').mockImplementation(() => clock);
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
  sortedSets.clear();
  mockRedis.script.mockResolvedValue('sliding-window-sha');
  mockRedis.evalsha.mockImplementation(runScript);
});

const CLIENT_IP = '203.0.113.5';

/** A request that came through one proxy, which appended `ip` after a spoofed entry */
const requestFrom = (ip = CLIENT_IP, headers: Record<string, string> = {}) =>
  new Request('https://api.example.com/api/graphql', {
    method: 'POST',
    headers: { 'x-forwarded-for': `198.51.100.99, ${ip}`, ...headers },
  });

const send = (params: GraphQLRequestParams, request = requestFrom()) =>
  checkGraphQLRateLimit(request, analyzeGraphQLRequest(params));

/** Rate limit keys counted in Redis during this test */
const charged = () =>
  mockRedis.evalsha.mock.calls.map((call) => ({ key: call[2], limit: call[3], cost: call[6] }));

const loginEmailKey = (email: string) =>
  `ratelimit:gql:login:email:${createHash('sha256').update(email).digest('hex')}`;

const login = (email: string) => `login(input: { email: "${email}", password: "guess" }) { accessToken }`;

const account = { userId: 'user-1', email: 'ada@example.com', role: 'SERVICE_USER' as const };
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const base64Url = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');

describe('client IP', () => {
  it('uses the entry the proxy added, not entries the client sent', () => {
    const request = new Request('https://api.example.com', {
      headers: { 'x-forwarded-for': '1.2.3.4, 5.6.7.8, 203.0.113.5' },
    });
    expect(getClientIp(request)).toBe('203.0.113.5');
  });

  it('counts TRUSTED_PROXY_COUNT entries from the right', () => {
    const security = config.security as { trustedProxyCount: number };
    security.trustedProxyCount = 2;
    try {
      const request = new Request('https://api.example.com', {
        headers: { 'x-forwarded-for': '1.2.3.4, 203.0.113.5, 10.0.0.2' },
      });
      expect(getClientIp(request)).toBe('203.0.113.5');
    } finally {
      security.trustedProxyCount = 1;
    }
  });

  it('is unknown without X-Forwarded-For, whatever X-Real-IP says', () => {
    const request = new Request('https://api.example.com', { headers: { 'x-real-ip': '203.0.113.2' } });
    expect(getClientIp(request)).toBe('unknown');
  });

  it('keeps one bucket when the spoofed entry changes', async () => {
    for (const spoofed of ['1.1.1.1', '2.2.2.2']) {
      const request = new Request('https://api.example.com', {
        method: 'POST',
        headers: { 'x-forwarded-for': `${spoofed}, ${CLIENT_IP}` },
      });
      await send({ query: '{ services { id } }' }, request);
    }
    expect(charged().map(({ key }) => key)).toEqual([
      `ratelimit:gql:anonymous:ip:${CLIENT_IP}`,
      `ratelimit:gql:anonymous:ip:${CLIENT_IP}`,
    ]);
  });
});

describe('user identity', () => {
  it('gives a valid access token a user bucket', async () => {
    const request = requestFrom(CLIENT_IP, bearer(generateToken(account)));
    expect(getRateLimitUserId(request)).toBe('user-1');

    await send({ query: '{ me { id } }' }, request);
    expect(charged()).toEqual([{ key: 'ratelimit:gql:read:user:user-1', limit: 300, cost: 1 }]);
  });

  it.each([
    ['signed with another secret', () => jwt.sign({ ...account, typ: 'access' }, 'attacker-secret')],
    ['unsigned', () => `${base64Url({ alg: 'none', typ: 'JWT' })}.${base64Url({ ...account, typ: 'access' })}.`],
    ['a refresh token', () => generateRefreshToken(account)],
  ])('treats a token %s as anonymous', async (_label, token) => {
    const request = requestFrom(CLIENT_IP, bearer(token()));
    expect(getRateLimitUserId(request)).toBeNull();

    await send({ query: '{ me { id } }' }, request);
    expect(charged()).toEqual([{ key: `ratelimit:gql:anonymous:ip:${CLIENT_IP}`, limit: 120, cost: 1 }]);
  });
});

describe('limits chosen from the parsed document', () => {
  it('applies the read limit to queries and the write limit to mutations of signed-in users', async () => {
    const headers = bearer(generateToken(account));
    const read = await send({ query: '{ me { id } }' }, requestFrom(CLIENT_IP, headers));
    const write = await send(
      { query: 'mutation { markAllNotificationsAsRead { message } }' },
      requestFrom(CLIENT_IP, headers)
    );

    expect(read).toMatchObject({ limited: false, limit: 300, remaining: 299 });
    expect(write).toMatchObject({ limited: false, limit: 60, remaining: 59 });
  });

  it('applies the anonymous limit to queries and mutations without a valid token', async () => {
    expect(await send({ query: '{ services { id } }' })).toMatchObject({ limit: 120, remaining: 119 });
    expect(await send({ query: 'mutation { markAllNotificationsAsRead { message } }' })).toMatchObject({
      limit: 120,
      remaining: 118,
    });
  });

  it('ignores operation names that look like sensitive mutations', async () => {
    await send({ query: 'query RefreshTokenStatus { me { id } }', operationName: 'RefreshTokenStatus' });
    expect(charged().map(({ key }) => key)).toEqual([`ratelimit:gql:anonymous:ip:${CLIENT_IP}`]);
  });

  it('applies only the general limit when the query does not parse', async () => {
    await send({ query: 'mutation { login(' });
    expect(charged().map(({ key }) => key)).toEqual([`ratelimit:gql:anonymous:ip:${CLIENT_IP}`]);
  });

  it.each([
    ['renamed through operationName', { query: `mutation LoadFeed { ${login('ada@example.com')} }`, operationName: 'LoadFeed' }],
    ['aliased', { query: `mutation { feed: ${login('ada@example.com')} }` }],
    ['inside an inline fragment', { query: `mutation { ... on Mutation { ${login('ada@example.com')} } }` }],
    ['inside a named fragment', { query: `mutation { ...Feed } fragment Feed on Mutation { ${login('ada@example.com')} }` }],
  ])('counts a login %s against the login limits', async (_label, params) => {
    expect(await send(params)).toMatchObject({ limited: false, limit: 10, remaining: 9 });
    expect(charged()).toEqual(
      expect.arrayContaining([
        { key: `ratelimit:gql:login_per_ip:ip:${CLIENT_IP}`, limit: 100, cost: 1 },
        { key: loginEmailKey('ada@example.com'), limit: 10, cost: 1 },
      ])
    );
  });

  it('counts every aliased login field', async () => {
    const twoAttempts = { query: `mutation { a: ${login('ada@example.com')} b: ${login('ada@example.com')} }` };
    for (let request = 0; request < 5; request++) {
      expect((await send(twoAttempts)).limited).toBe(false);
    }
    expect(charged()).toEqual(
      expect.arrayContaining([
        { key: `ratelimit:gql:login_per_ip:ip:${CLIENT_IP}`, limit: 100, cost: 2 },
        { key: loginEmailKey('ada@example.com'), limit: 10, cost: 2 },
      ])
    );

    expect(await send(twoAttempts)).toMatchObject({ limited: true, limit: 10, resetIn: 900 });
  });

  it('lets different accounts sign in from one shared IP, up to 100 in 15 minutes', async () => {
    // 8 seconds apart, so the per-minute general limit isn't what stops them
    for (let i = 0; i < 100; i++) {
      expect((await send({ query: `mutation { ${login(`user${i}@example.com`)} }` })).limited).toBe(false);
      clock += 8000;
    }

    // 13 min 20 s after the first attempt, which leaves the window 100 s later
    expect(await send({ query: `mutation { ${login('user100@example.com')} }` })).toMatchObject({
      limited: true,
      limit: 100,
      resetIn: 100,
    });
  });

  it('limits the 11th login for one account, even from different IPs', async () => {
    const attempts: GraphQLRequestParams[] = [
      {
        query: 'mutation SignIn($input: LoginInput!) { login(input: $input) { accessToken } }',
        variables: { input: { email: ' Victim@Example.com ', password: 'guess' } },
      },
      {
        query:
          'mutation SignIn($input: LoginInput = { email: "victim@example.com", password: "guess" }) { login(input: $input) { accessToken } }',
      },
      { query: `mutation { ${login('VICTIM@example.com')} }` },
    ];

    for (let i = 0; i < 10; i++) {
      expect((await send(attempts[i % 3], requestFrom(`192.0.2.${i + 1}`))).limited).toBe(false);
    }
    expect(charged()).toContainEqual({ key: loginEmailKey('victim@example.com'), limit: 10, cost: 1 });

    expect(await send(attempts[2], requestFrom('192.0.2.200'))).toMatchObject({ limited: true, limit: 10 });
  });

  const register = (email: string) =>
    `register(input: { email: "${email}", password: "Secret123!", firstName: "Ada", lastName: "Obi" }) { message }`;

  it('limits registration at 5 a minute per email, from any IP', async () => {
    for (let i = 0; i < 5; i++) {
      const decision = await send(
        { query: `mutation { ${register('new@example.com')} }` },
        requestFrom(`192.0.2.${i + 1}`)
      );
      expect(decision.limited).toBe(false);
    }

    const sixth = await send({ query: `mutation { ${register('NEW@example.com')} }` }, requestFrom('192.0.2.99'));
    expect(sixth).toMatchObject({ limited: true, limit: 5 });
  });

  it('limits registration at 30 a minute per IP across different emails', async () => {
    for (let i = 0; i < 30; i++) {
      expect((await send({ query: `mutation { ${register(`new${i}@example.com`)} }` })).limited).toBe(false);
    }
    expect(charged()).toContainEqual({ key: `ratelimit:gql:auth_per_ip:ip:${CLIENT_IP}`, limit: 30, cost: 1 });

    expect(await send({ query: `mutation { ${register('new30@example.com')} }` })).toMatchObject({
      limited: true,
      limit: 30,
    });
  });

  it('limits token refresh at 120 a minute per IP, in its own bucket', async () => {
    const refreshes = (count: number) => ({
      query: `mutation { ${Array.from(
        { length: count },
        (_, i) => `r${i}: refreshToken(refreshToken: "t${i}") { accessToken }`
      ).join(' ')} }`,
    });

    // Sign-ups from the same IP leave refreshes alone (refresh used to share their bucket)
    for (let i = 0; i < 5; i++) {
      await send({ query: `mutation { ${register(`new${i}@example.com`)} }` });
    }

    // 20 aliased refreshes a request: the general limit is also 120 a minute, so this shows
    // the refresh limit is the one that stops them
    for (let request = 0; request < 6; request++) {
      expect((await send(refreshes(20))).limited).toBe(false);
    }
    expect(charged()).toContainEqual({ key: `ratelimit:gql:refresh:ip:${CLIENT_IP}`, limit: 120, cost: 20 });
    expect(await send(refreshes(1))).toMatchObject({ limited: true, limit: 120 });

    // Other IPs and sign-ups are unaffected, and a minute later the IP can refresh again
    expect((await send(refreshes(1), requestFrom('192.0.2.50'))).limited).toBe(false);
    expect((await send({ query: `mutation { ${register('late@example.com')} }` })).limited).toBe(false);
    clock += 60 * 1000;
    expect((await send(refreshes(1))).limited).toBe(false);
  });

  it('measures fragment cycles without looping', () => {
    const analysis = analyzeGraphQLRequest({
      query: 'query { ...A } fragment A on Query { ...B } fragment B on Query { ...A me { id } }',
    });
    expect(analysis.complexityError).toBeNull();
    expect(analysis.rootFields.map(({ name }) => name)).toEqual(['me']);
  });
});

describe('rateLimit.check', () => {
  it('allows up to the limit, then reports when there is room again', async () => {
    const remaining: number[] = [];
    for (let i = 0; i < 3; i++) {
      const result = await rateLimit.check('test:window', 3, 60);
      expect(result.allowed).toBe(true);
      remaining.push(result.remaining);
    }
    expect(remaining).toEqual([2, 1, 0]);
    expect(mockRedis.evalsha).toHaveBeenLastCalledWith(
      'sliding-window-sha', 1, 'ratelimit:test:window', 3, 60000, clock, 1, expect.any(String)
    );

    clock += 20 * 1000;
    expect(await rateLimit.check('test:window', 3, 60)).toEqual({ allowed: false, remaining: 0, resetIn: 40 });
    expect(mockRedis.evalsha).toHaveBeenCalledTimes(4);
  });

  it('loads the script again when Redis has lost it', async () => {
    await rateLimit.check('test:noscript', 5, 60);
    mockRedis.script.mockClear();
    mockRedis.evalsha.mockRejectedValueOnce(new Error('NOSCRIPT No matching script. Please use EVAL.'));

    expect(await rateLimit.check('test:noscript', 5, 60)).toEqual({ allowed: true, remaining: 3, resetIn: 60 });
    expect(mockRedis.script).toHaveBeenCalledWith('LOAD', expect.stringContaining("redis.call('ZADD'"));
    expect(console.error).not.toHaveBeenCalled();
  });

  it('keeps enforcing strict limits in memory while Redis is down, logging the outage once', async () => {
    mockRedis.evalsha.mockRejectedValue(new Error('Connection is closed.'));
    const attempt = { query: `mutation { ${login('ada@example.com')} }` };

    for (let i = 0; i < 10; i++) {
      expect((await send(attempt)).limited).toBe(false);
    }
    expect(await send(attempt)).toMatchObject({ limited: true, limit: 10 });
    expect(console.error).toHaveBeenCalledTimes(1);

    // Redis is tried again after a pause
    mockRedis.evalsha.mockImplementation(runScript);
    mockRedis.evalsha.mockClear();
    clock += 5000;
    await rateLimit.check('test:recovered', 5, 60);
    expect(mockRedis.evalsha).toHaveBeenCalledTimes(1);
    expect(console.log).toHaveBeenCalledWith('✅ Rate limiting is using Redis again');
  });
});

describe('IP blocklist', () => {
  it('stores each block as a key that expires on its own', async () => {
    const setTimeoutSpy = jest.spyOn(global, 'setTimeout');
    mockRedis.set.mockResolvedValue('OK');
    await blockIp('198.51.100.1', 600);
    expect(mockRedis.set).toHaveBeenCalledWith('blocked_ip:198.51.100.1', '1', 'EX', 600);
    expect(setTimeoutSpy).not.toHaveBeenCalled();

    mockRedis.exists.mockResolvedValue(1);
    expect(await isBlockedIp('198.51.100.1')).toBe(true);
    expect(mockRedis.exists).toHaveBeenCalledWith('blocked_ip:198.51.100.1');
  });

  it('reports an IP as not blocked when Redis fails', async () => {
    mockRedis.exists.mockRejectedValue(new Error('Connection is closed.'));
    await expect(isBlockedIp('198.51.100.1')).resolves.toBe(false);
  });
});
