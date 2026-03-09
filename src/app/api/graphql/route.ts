/**
 * GraphQL API Route Handler
 * Next.js API route for Apollo Server
 */

import { ApolloServer } from '@apollo/server';
import { startServerAndCreateNextHandler } from '@as-integrations/next';
import { NextRequest, NextResponse } from 'next/server';
import { typeDefs, resolvers } from '@/graphql';
import { getAuthContext, GraphQLContext } from '@/middleware';
import { ApolloServerPluginLandingPageLocalDefault } from '@apollo/server/plugin/landingPage/default';

// Create Apollo Server instance
const server = new ApolloServer<GraphQLContext>({
  typeDefs,
  resolvers,
  introspection: true, // Enable introspection in all environments
  plugins: [
    // Always show embedded Apollo Sandbox for easy testing
    ApolloServerPluginLandingPageLocalDefault({ 
      embed: true,
      includeCookies: true 
    }),
  ],
});

// Create handler
const handler = startServerAndCreateNextHandler<NextRequest, GraphQLContext>(server, {
  context: async (req: NextRequest) => {
    return getAuthContext(req);
  },
});

// Export route handlers for Next.js App Router
export async function GET(request: NextRequest) {
  return handler(request);
}

export async function POST(request: NextRequest) {
  return handler(request);
}
