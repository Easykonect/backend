/**
 * GraphQL API Route Handler
 * Next.js API route for Apollo Server
 * 
 * Security Features:
 * - Rate limiting per IP and operation type
 * - Query depth limiting (max 10 levels)
 * - Introspection disabled in production
 * - CORS configuration
 * - Request body size validation
 */

import { ApolloServer } from '@apollo/server';
import { startServerAndCreateNextHandler } from '@as-integrations/next';
import { NextRequest, NextResponse } from 'next/server';
import { typeDefs, resolvers } from '@/graphql';
import { getAuthContext, GraphQLContext } from '@/middleware';
import { ApolloServerPluginLandingPageLocalDefault } from '@apollo/server/plugin/landingPage/default';
import { ApolloServerPluginLandingPageDisabled } from '@apollo/server/plugin/disabled';
import { config } from '@/config';
import {
  checkRateLimit,
  rateLimitHeaders,
  rateLimitedResponse,
  extractGraphQLOperation,
  getRateLimitTypeForOperation,
  isBlockedIp,
  getClientIp,
  RateLimitConfig,
} from '@/middleware/rate-limit.middleware';

// Maximum request body size (1MB)
const MAX_BODY_SIZE = 1024 * 1024;

// Maximum query depth to prevent deeply nested queries
const MAX_QUERY_DEPTH = 10;

/**
 * Simple query depth checker
 * Counts maximum nesting level in the query
 */
const getQueryDepth = (query: string): number => {
  let maxDepth = 0;
  let currentDepth = 0;
  
  for (const char of query) {
    if (char === '{') {
      currentDepth++;
      maxDepth = Math.max(maxDepth, currentDepth);
    } else if (char === '}') {
      currentDepth--;
    }
  }
  
  return maxDepth;
};

/**
 * Validate GraphQL query depth
 */
const validateQueryDepth = async (request: NextRequest): Promise<string | null> => {
  try {
    const body = await request.clone().json();
    if (body.query) {
      const depth = getQueryDepth(body.query);
      if (depth > MAX_QUERY_DEPTH) {
        return `Query depth ${depth} exceeds maximum allowed depth of ${MAX_QUERY_DEPTH}`;
      }
    }
    return null;
  } catch {
    return null;
  }
};

// CORS headers for GraphQL endpoint
const corsHeaders = {
  'Access-Control-Allow-Origin': config.cors.allowedOrigins.length > 0 
    ? config.cors.allowedOrigins.join(',') 
    : '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
  'Access-Control-Max-Age': '86400',
};

// Create Apollo Server instance with production security
const server = new ApolloServer<GraphQLContext>({
  typeDefs,
  resolvers,
  introspection: !config.isProduction, // Disable introspection in production
  plugins: [
    // Show Apollo Sandbox only in development
    config.isProduction
      ? ApolloServerPluginLandingPageDisabled()
      : ApolloServerPluginLandingPageLocalDefault({ 
          embed: true,
          includeCookies: true 
        }),
  ],
  formatError: (formattedError, error) => {
    // Hide internal error details in production
    if (config.isProduction) {
      // Don't expose internal errors
      if (formattedError.extensions?.code === 'INTERNAL_SERVER_ERROR') {
        console.error('Internal Error:', error);
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

// Export OPTIONS handler for CORS preflight
export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: corsHeaders,
  });
}

// Export route handlers for Next.js App Router
export async function GET(request: NextRequest) {
  // Add CORS headers
  const response = await handler(request);
  Object.entries(corsHeaders).forEach(([key, value]) => {
    response.headers.set(key, value);
  });
  return response;
}

export async function POST(request: NextRequest) {
  // Check if IP is blocked
  const clientIp = getClientIp(request);
  if (await isBlockedIp(clientIp)) {
    return new NextResponse(
      JSON.stringify({
        errors: [{ message: 'Access denied', extensions: { code: 'FORBIDDEN' } }],
      }),
      { status: 403, headers: corsHeaders }
    );
  }
  
  // Check content length (prevent oversized requests)
  const contentLength = request.headers.get('content-length');
  if (contentLength && parseInt(contentLength) > MAX_BODY_SIZE) {
    return new NextResponse(
      JSON.stringify({
        errors: [{ message: 'Request body too large', extensions: { code: 'PAYLOAD_TOO_LARGE' } }],
      }),
      { status: 413, headers: corsHeaders }
    );
  }
  
  // Validate query depth
  const depthError = await validateQueryDepth(request);
  if (depthError) {
    return new NextResponse(
      JSON.stringify({
        errors: [{ message: depthError, extensions: { code: 'QUERY_TOO_COMPLEX' } }],
      }),
      { status: 400, headers: corsHeaders }
    );
  }
  
  // Extract operation for rate limiting
  const { operationName } = await extractGraphQLOperation(request);
  const rateLimitType = getRateLimitTypeForOperation(operationName);
  
  // Check rate limit (hybrid: uses userId for authenticated, IP for unauthenticated)
  const rateCheck = await checkRateLimit(request, rateLimitType, undefined, operationName);
  if (rateCheck.limited) {
    const response = rateLimitedResponse(rateCheck.resetIn);
    Object.entries(corsHeaders).forEach(([key, value]) => {
      response.headers.set(key, value);
    });
    return response;
  }
  
  // Process the request
  const response = await handler(request);
  
  // Add CORS and rate limit headers
  Object.entries(corsHeaders).forEach(([key, value]) => {
    response.headers.set(key, value);
  });
  
  const limitConfig = RateLimitConfig[rateLimitType];
  Object.entries(rateLimitHeaders(rateCheck.remaining, rateCheck.resetIn, limitConfig.limit)).forEach(
    ([key, value]) => {
      response.headers.set(key, value);
    }
  );
  
  return response;
}

