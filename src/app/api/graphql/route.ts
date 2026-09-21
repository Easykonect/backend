/**
 * GraphQL API Route Handler
 * Next.js API route for Apollo Server
 *
 * Security Features:
 * - IP blocklist, query complexity limits (depth, root fields, aliases) and rate limits for
 *   every request that carries a GraphQL document: POSTs, and GETs with a `query` parameter
 * - Request body limits: 1 MB, or 20 MB for requests that upload files
 * - Introspection disabled in production
 * - CORS configuration
 * - Sentry error monitoring
 */

import { ApolloServer } from '@apollo/server';
import { startServerAndCreateNextHandler } from '@as-integrations/next';
import { NextRequest, NextResponse } from 'next/server';
import { typeDefs, resolvers } from '@/graphql';
import { dateAwareFieldResolver } from '@/graphql/request-guards';
import { getAuthContext, GraphQLContext } from '@/middleware';
import { ApolloServerPluginLandingPageLocalDefault } from '@apollo/server/plugin/landingPage/default';
import { ApolloServerPluginLandingPageDisabled } from '@apollo/server/plugin/disabled';
import { config } from '@/config';
import {
  analyzeGraphQLRequest,
  checkGraphQLRateLimit,
  getClientIp,
  isBlockedIp,
  rateLimitHeaders,
  rateLimitedResponse,
  UPLOAD_FIELDS,
  type GraphQLRequestAnalysis,
  type GraphQLRequestParams,
} from '@/middleware/rate-limit.middleware';
import { initSentry, captureException } from '@/lib/sentry';

// Initialize Sentry as early as possible
initSentry();

// Request body limits. Files are uploaded as base64 inside GraphQL, so a request that
// uploads files may be larger; every other request keeps the normal limit.
const MAX_BODY_SIZE = 1024 * 1024; // 1 MB
const MAX_UPLOAD_BODY_SIZE = 20 * 1024 * 1024; // 20 MB

// CORS headers for GraphQL endpoint
// Note: Access-Control-Allow-Origin cannot be a comma-separated list.
// Use '*' for development or dynamically set from request origin for production.
const baseCorsHeaders = {
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
  // Let browser clients read how long to wait and how much of their limit is left
  'Access-Control-Expose-Headers': 'Retry-After, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset',
  'Access-Control-Max-Age': '86400',
  'Access-Control-Allow-Credentials': 'true',
};

/**
 * Get CORS headers with the correct Access-Control-Allow-Origin
 * For production: echo the request origin if it's in the allowlist
 * For development: use wildcard '*'
 */
const getCorsHeaders = (requestOrigin: string | null): Record<string, string> => {
  // In production, validate origin against allowlist
  if (config.isProduction && config.cors.allowedOrigins.length > 0) {
    const isAllowed = requestOrigin && config.cors.allowedOrigins.includes(requestOrigin);
    return {
      ...baseCorsHeaders,
      'Access-Control-Allow-Origin': isAllowed ? requestOrigin : config.cors.allowedOrigins[0],
    };
  }

  // In development, allow all origins
  return {
    ...baseCorsHeaders,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Credentials': 'false', // Cannot use 'true' with '*'
  };
};

// Create Apollo Server instance with production security
const server = new ApolloServer<GraphQLContext>({
  typeDefs,
  resolvers,
  // Dates reach the app as ISO strings
  fieldResolver: dateAwareFieldResolver,
  introspection: !config.isProduction, // Disable introspection in production
  // Automatic persisted queries let a client send only a hash, which the limits below can't
  // inspect. Clients that use them fall back to sending the full query.
  persistedQueries: false,
  plugins: [
    // Show Apollo Sandbox only in development
    config.isProduction
      ? ApolloServerPluginLandingPageDisabled()
      : ApolloServerPluginLandingPageLocalDefault({
          embed: true,
          includeCookies: true
        }),
    // Clients only ever see "An internal error occurred". Log which operation
    // failed, for whom, and the full stack, so the server log can explain it.
    // Errors thrown on purpose carry a code and are skipped.
    {
      async requestDidStart() {
        return {
          async didEncounterErrors({ errors, operationName, contextValue }) {
            for (const error of errors) {
              const code = error.extensions?.code;
              if (code && code !== 'INTERNAL_SERVER_ERROR') continue;

              const cause = error.originalError ?? error;
              console.error(
                'Internal Error:',
                JSON.stringify({
                  operation: operationName ?? null,
                  path: error.path?.join('.') ?? null,
                  userId: contextValue.user?.userId ?? null,
                  role: contextValue.user?.role ?? null,
                  message: cause.message,
                })
              );
              console.error(cause.stack ?? cause);
            }
          },
        };
      },
    },
  ],
  formatError: (formattedError, error) => {
    // Capture errors in Sentry (except validation errors)
    const errorCode = formattedError.extensions?.code as string;
    const skipCodes = ['VALIDATION_ERROR', 'BAD_USER_INPUT', 'UNAUTHENTICATED', 'FORBIDDEN'];

    if (!skipCodes.includes(errorCode)) {
      captureException(error, {
        tags: {
          'graphql.error_code': errorCode || 'UNKNOWN',
        },
        extra: {
          path: formattedError.path,
          locations: formattedError.locations,
        },
        level: errorCode === 'INTERNAL_SERVER_ERROR' ? 'error' : 'warning',
      });
    }

    // Hide internal error details in production
    if (config.isProduction) {
      // Don't expose internal errors
      if (errorCode === 'INTERNAL_SERVER_ERROR') {
        // Logged with its operation and user by the plugin above
        return {
          message: 'An internal error occurred',
          extensions: { code: 'INTERNAL_SERVER_ERROR' },
        };
      }
    }
    return formattedError;
  },
});

// Create handler
const handler = startServerAndCreateNextHandler<NextRequest, GraphQLContext>(server, {
  context: async (req: NextRequest) => {
    return getAuthContext(req);
  },
});

const errorResponse = (
  status: number,
  message: string,
  code: string,
  headers: Record<string, string>
): NextResponse => NextResponse.json({ errors: [{ message, extensions: { code } }] }, { status, headers });

const withHeaders = (response: Response, headers: Record<string, string>): Response => {
  Object.entries(headers).forEach(([key, value]) => {
    response.headers.set(key, value);
  });
  return response;
};

const isJsonContentType = (value: string | null): boolean =>
  value?.split(';')[0].trim().toLowerCase() === 'application/json';

/**
 * A GET has no body, but Apollo tries to read one when Content-Type says JSON, and fails.
 * Drop the header and mark the request as preflighted, which a JSON Content-Type already
 * guaranteed for browsers.
 */
const forApolloGet = (request: NextRequest): NextRequest => {
  if (!isJsonContentType(request.headers.get('content-type'))) return request;

  const headers = new Headers(request.headers);
  headers.delete('content-type');
  headers.set('apollo-require-preflight', 'true');
  return new NextRequest(request.url, { method: 'GET', headers });
};

const complexityResponse = (
  analysis: GraphQLRequestAnalysis,
  corsHeaders: Record<string, string>
): NextResponse | null =>
  analysis.complexityError ? errorResponse(400, analysis.complexityError, 'QUERY_TOO_COMPLEX', corsHeaders) : null;

/**
 * Rate limits for a request that carries a GraphQL document, before Apollo runs it.
 * Returns the response to send instead, or the headers to add to Apollo's response.
 */
const checkLimits = async (
  request: NextRequest,
  analysis: GraphQLRequestAnalysis,
  corsHeaders: Record<string, string>
): Promise<{ response: Response } | { headers: Record<string, string> }> => {
  const decision = await checkGraphQLRateLimit(request, analysis);
  const headers = {
    ...corsHeaders,
    ...rateLimitHeaders(decision.remaining, decision.resetIn, decision.limit),
  };
  if (decision.limited) {
    return { response: withHeaders(rateLimitedResponse(decision.resetIn), headers) };
  }
  return { headers };
};

// Export OPTIONS handler for CORS preflight
export async function OPTIONS(request: NextRequest) {
  const origin = request.headers.get('origin');
  const corsHeaders = getCorsHeaders(origin);
  return new NextResponse(null, {
    status: 204,
    headers: corsHeaders,
  });
}

// Export route handlers for Next.js App Router
export async function GET(request: NextRequest) {
  const corsHeaders = getCorsHeaders(request.headers.get('origin'));
  const searchParams = request.nextUrl.searchParams;

  // Without a query there is nothing to run (the landing page). /api/health is the health check.
  if (!searchParams.has('query')) {
    return withHeaders(await handler(forApolloGet(request)), corsHeaders);
  }

  if (await isBlockedIp(getClientIp(request))) {
    return errorResponse(403, 'Access denied', 'FORBIDDEN', corsHeaders);
  }

  // Apollo rejects a repeated parameter, so only a single value counts
  const single = (name: string): string | undefined => {
    const values = searchParams.getAll(name);
    return values.length === 1 ? values[0] : undefined;
  };
  let variables: unknown;
  try {
    variables = JSON.parse(single('variables') ?? 'null');
  } catch {
    // Invalid JSON: Apollo returns the error
  }

  const analysis = analyzeGraphQLRequest({
    query: single('query'),
    operationName: single('operationName'),
    variables,
  });
  const tooComplex = complexityResponse(analysis, corsHeaders);
  if (tooComplex) return tooComplex;

  const limits = await checkLimits(request, analysis, corsHeaders);
  if ('response' in limits) return limits.response;

  return withHeaders(await handler(forApolloGet(request)), limits.headers);
}

export async function POST(request: NextRequest) {
  const corsHeaders = getCorsHeaders(request.headers.get('origin'));
  const tooLarge = () => errorResponse(413, 'Request body too large', 'PAYLOAD_TOO_LARGE', corsHeaders);

  // Check if IP is blocked
  if (await isBlockedIp(getClientIp(request))) {
    return errorResponse(403, 'Access denied', 'FORBIDDEN', corsHeaders);
  }

  // Refuse a body declared larger than any request may be, before reading it
  const contentLength = parseInt(request.headers.get('content-length') ?? '', 10);
  if (contentLength > MAX_UPLOAD_BODY_SIZE) {
    return tooLarge();
  }

  // Read body once — Next.js 16 streams can only be consumed once.
  // We reconstruct the request for Apollo after inspecting the body.
  const bodyText = await request.text();
  const bodySize = Buffer.byteLength(bodyText);
  if (bodySize > MAX_UPLOAD_BODY_SIZE) {
    return tooLarge();
  }

  let body: unknown;
  if (bodyText.trim()) {
    try {
      body = JSON.parse(bodyText);
    } catch {
      return errorResponse(400, 'The request body is not valid JSON', 'BAD_REQUEST', corsHeaders);
    }
  }

  const params = typeof body === 'object' && body !== null ? (body as GraphQLRequestParams) : {};
  const analysis = analyzeGraphQLRequest(params);
  const tooComplex = complexityResponse(analysis, corsHeaders);
  if (tooComplex) return tooComplex;

  // Only requests that upload files may use the larger limit
  if (bodySize > MAX_BODY_SIZE && !analysis.rootFields.some((field) => UPLOAD_FIELDS.has(field.name))) {
    return tooLarge();
  }

  const limits = await checkLimits(request, analysis, corsHeaders);
  if ('response' in limits) return limits.response;

  // Apollo only reads the body when Content-Type is exactly application/json, so a
  // charset suffix (application/json; charset=utf-8) is dropped
  const headers = new Headers(request.headers);
  if (isJsonContentType(headers.get('content-type'))) {
    headers.set('content-type', 'application/json');
  }

  // Reconstruct request with the body so Apollo can read it
  const reconstructedRequest = new NextRequest(request.url, {
    method: request.method,
    headers,
    body: bodyText,
  });

  return withHeaders(await handler(reconstructedRequest), limits.headers);
}
