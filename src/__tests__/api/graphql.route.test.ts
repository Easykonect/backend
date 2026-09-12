/**
 * GraphQL route: blocklist, complexity and rate limits run before Apollo for POSTs
 * and for GETs that carry a query
 */

jest.mock('@/config', () => ({
  config: {
    isProduction: false,
    cors: { allowedOrigins: [] },
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
jest.mock('@apollo/server', () => ({ ApolloServer: jest.fn() }));
jest.mock('@apollo/server/plugin/landingPage/default', () => ({
  ApolloServerPluginLandingPageLocalDefault: jest.fn(),
}));
jest.mock('@apollo/server/plugin/disabled', () => ({ ApolloServerPluginLandingPageDisabled: jest.fn() }));
jest.mock('@as-integrations/next', () => ({ startServerAndCreateNextHandler: jest.fn(() => jest.fn()) }));
jest.mock('@/graphql', () => ({ typeDefs: '', resolvers: {} }));
jest.mock('@/middleware', () => ({ getAuthContext: jest.fn() }));
jest.mock('@/lib/sentry', () => ({ initSentry: jest.fn(), captureException: jest.fn() }));
jest.mock('@/lib/redis', () => ({
  __esModule: true,
  default: { connect: jest.fn() },
  rateLimit: { check: jest.fn() },
}));

import { NextRequest } from 'next/server';
import { ApolloServer } from '@apollo/server';
import { startServerAndCreateNextHandler } from '@as-integrations/next';
import RedisClient, { rateLimit } from '@/lib/redis';
import { GET, POST } from '@/app/api/graphql/route';

// Captured at import, before call history is cleared between tests
const apolloHandler = (startServerAndCreateNextHandler as unknown as jest.Mock).mock.results[0].value as jest.Mock;
const apolloOptions = (ApolloServer as unknown as jest.Mock).mock.calls[0][0];

const check = rateLimit.check as jest.Mock;
const connect = RedisClient.connect as jest.Mock;
const exists = jest.fn();

const CLIENT_IP = '203.0.113.5';

beforeEach(() => {
  exists.mockResolvedValue(0);
  connect.mockResolvedValue({ exists });
  check.mockImplementation(async (_key: string, limit: number, windowSeconds: number) => ({
    allowed: true,
    remaining: limit - 1,
    resetIn: windowSeconds,
  }));
  apolloHandler.mockImplementation(
    async () =>
      new Response(JSON.stringify({ data: {} }), { status: 200, headers: { 'content-type': 'application/json' } })
  );
});

const post = (body: unknown) =>
  new NextRequest('https://api.example.com/api/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': `198.51.100.99, ${CLIENT_IP}` },
    body: JSON.stringify(body),
  });

const get = (search: string) =>
  new NextRequest(`https://api.example.com/api/graphql${search}`, {
    headers: { 'x-forwarded-for': CLIENT_IP },
  });

const errorCode = async (response: Response) => (await response.json()).errors[0].extensions.code;

/** Fields nested `levels` deep, counting the operation's own selection set */
const nested = (levels: number) => `${'node { '.repeat(levels - 1)}id${' }'.repeat(levels - 1)}`;

describe('POST /api/graphql', () => {
  it('runs Apollo with the body and reports the tightest limit', async () => {
    const body = { query: 'mutation { login(input: { email: "ada@example.com", password: "x" }) { accessToken } }' };
    const response = await POST(post(body));

    expect(response.status).toBe(200);
    expect(check).toHaveBeenCalledWith(`gql:anonymous:ip:${CLIENT_IP}`, 120, 60, 1);
    expect(check).toHaveBeenCalledWith(`gql:login_per_ip:ip:${CLIENT_IP}`, 100, 900, 1);
    expect(check).toHaveBeenCalledWith(expect.stringMatching(/^gql:login:email:[0-9a-f]{64}$/), 10, 900, 1);
    expect(response.headers.get('X-RateLimit-Limit')).toBe('10');
    expect(response.headers.get('X-RateLimit-Remaining')).toBe('9');
    expect(await (apolloHandler.mock.calls[0][0] as NextRequest).json()).toEqual(body);
  });

  it('answers a limited request with 429 and Retry-After, readable by browsers', async () => {
    check.mockResolvedValue({ allowed: false, remaining: 0, resetIn: 42 });
    const response = await POST(post({ query: '{ services { id } }' }));

    expect(response.status).toBe(429);
    expect(await errorCode(response)).toBe('RATE_LIMITED');
    expect(response.headers.get('Retry-After')).toBe('42');
    expect(response.headers.get('X-RateLimit-Remaining')).toBe('0');
    expect(response.headers.get('Access-Control-Expose-Headers')).toBe(
      'Retry-After, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset'
    );
    expect(apolloHandler).not.toHaveBeenCalled();
  });

  it.each([
    ['more than 20 root fields', `{ ${Array.from({ length: 21 }, (_, i) => `field${i}`).join(' ')} }`],
    ['more than 30 aliases', `{ me { ${Array.from({ length: 31 }, (_, i) => `a${i}: id`).join(' ')} } }`],
    ['a depth over 10', `{ ${nested(11)} }`],
    ['a depth over 10 through a fragment', `{ me { ...Deep } } fragment Deep on User { ${nested(10)} }`],
  ])('rejects %s before rate limiting and Apollo', async (_label, query) => {
    const response = await POST(post({ query }));

    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe('QUERY_TOO_COMPLEX');
    expect(check).not.toHaveBeenCalled();
    expect(apolloHandler).not.toHaveBeenCalled();
  });

  it.each([
    ['a depth of exactly 10', `{ ${nested(10)} }`],
    ['braces inside a string argument', `mutation { sendMessage(input: { conversationId: "c1", content: "${'{'.repeat(30)}" }) { id } }`],
  ])('accepts %s', async (_label, query) => {
    expect((await POST(post({ query }))).status).toBe(200);
    expect(apolloHandler).toHaveBeenCalledTimes(1);
  });

  it('refuses a blocked IP', async () => {
    exists.mockResolvedValue(1);
    const response = await POST(post({ query: '{ services { id } }' }));

    expect(response.status).toBe(403);
    expect(exists).toHaveBeenCalledWith(`blocked_ip:${CLIENT_IP}`);
    expect(apolloHandler).not.toHaveBeenCalled();
  });
});

describe('GET /api/graphql', () => {
  it('limits a GET that carries a query', async () => {
    check.mockResolvedValue({ allowed: false, remaining: 0, resetIn: 7 });
    const response = await GET(get(`?query=${encodeURIComponent('{ services { id } }')}`));

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('7');
    expect(check).toHaveBeenCalledWith(`gql:anonymous:ip:${CLIENT_IP}`, 120, 60, 1);
    expect(apolloHandler).not.toHaveBeenCalled();
  });

  it('checks the complexity of a GET query', async () => {
    const response = await GET(get(`?query=${encodeURIComponent(`{ ${nested(11)} }`)}`));

    expect(response.status).toBe(400);
    expect(apolloHandler).not.toHaveBeenCalled();
  });

  it('runs an allowed GET query with rate limit headers', async () => {
    const request = get(`?query=${encodeURIComponent('{ services { id } }')}`);
    const response = await GET(request);

    expect(apolloHandler).toHaveBeenCalledWith(request);
    expect(response.headers.get('X-RateLimit-Limit')).toBe('120');
  });

  it('passes a GET without a query straight to Apollo', async () => {
    const request = get('');
    const response = await GET(request);

    expect(apolloHandler).toHaveBeenCalledWith(request);
    expect(response.status).toBe(200);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(response.headers.get('X-RateLimit-Limit')).toBeNull();
    expect(check).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });
});

describe('Apollo Server options', () => {
  it('turns off automatic persisted queries, which would hide the operation from the limits', () => {
    expect(apolloOptions.persistedQueries).toBe(false);
  });
});
