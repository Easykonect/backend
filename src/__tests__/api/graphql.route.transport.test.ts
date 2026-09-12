/**
 * GraphQL route transport: body size limits, invalid JSON, and the Content-Type
 * handling Apollo needs
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
      rateLimitAnonymousPerMinute: 300,
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
import { startServerAndCreateNextHandler } from '@as-integrations/next';
import RedisClient, { rateLimit } from '@/lib/redis';
import { GET, POST } from '@/app/api/graphql/route';

const apolloHandler = (startServerAndCreateNextHandler as unknown as jest.Mock).mock.results[0].value as jest.Mock;
const check = rateLimit.check as jest.Mock;
const connect = RedisClient.connect as jest.Mock;

const CLIENT_IP = '203.0.113.5';

beforeEach(() => {
  connect.mockResolvedValue({ exists: jest.fn().mockResolvedValue(0) });
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

const post = (body: string, headers: Record<string, string> = {}) =>
  new NextRequest('https://api.example.com/api/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': CLIENT_IP, ...headers },
    body,
  });

const errorCode = async (response: Response) => (await response.json()).errors[0].extensions.code;

// A little over 1 MB of base64-like text
const bigString = 'A'.repeat(1024 * 1024 + 10);

describe('POST body', () => {
  it('answers invalid JSON with 400 instead of reaching Apollo', async () => {
    const response = await POST(post('{ "query": '));

    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe('BAD_REQUEST');
    expect(apolloHandler).not.toHaveBeenCalled();
  });

  it('passes a JSON Content-Type with a charset to Apollo as plain application/json', async () => {
    const response = await POST(
      post(JSON.stringify({ query: '{ services { id } }' }), { 'content-type': 'application/json; charset=utf-8' })
    );

    expect(response.status).toBe(200);
    const forwarded = apolloHandler.mock.calls[0][0] as NextRequest;
    expect(forwarded.headers.get('content-type')).toBe('application/json');
  });

  it('refuses a body over 1 MB that uploads nothing', async () => {
    const body = JSON.stringify({
      query: 'mutation Send($input: SendMessageInput!) { sendMessage(input: $input) { id } }',
      variables: { input: { conversationId: '64f1c2a9e4b0a1b2c3d4e5f6', content: bigString } },
    });
    const response = await POST(post(body));

    expect(response.status).toBe(413);
    expect(await errorCode(response)).toBe('PAYLOAD_TOO_LARGE');
    expect(apolloHandler).not.toHaveBeenCalled();
  });

  it('lets a request that uploads files go over 1 MB', async () => {
    const body = JSON.stringify({
      query: 'mutation Upload($file: FileUploadInput!) { uploadProfilePhoto(file: $file) { url } }',
      variables: { file: { base64Data: bigString, filename: 'photo.jpg' } },
    });
    const response = await POST(post(body));

    expect(response.status).toBe(200);
    expect(apolloHandler).toHaveBeenCalledTimes(1);
  });

  it('refuses a declared size over 20 MB without reading the body', async () => {
    const response = await POST(post('{}', { 'content-length': String(21 * 1024 * 1024) }));

    expect(response.status).toBe(413);
    expect(check).not.toHaveBeenCalled();
  });
});

describe('GET with a JSON Content-Type', () => {
  it('drops the header Apollo would try to read a body for, and keeps the request preflighted', async () => {
    const request = new NextRequest(
      `https://api.example.com/api/graphql?query=${encodeURIComponent('{ services { id } }')}`,
      { headers: { 'content-type': 'application/json', 'x-forwarded-for': CLIENT_IP } }
    );
    const response = await GET(request);

    expect(response.status).toBe(200);
    const forwarded = apolloHandler.mock.calls[0][0] as NextRequest;
    expect(forwarded.headers.get('content-type')).toBeNull();
    expect(forwarded.headers.get('apollo-require-preflight')).toBe('true');
  });
});
