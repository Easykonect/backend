/**
 * GraphQL Configuration
 * Apollo Server setup and exports
 */

import { ApolloServer } from '@apollo/server';
import { typeDefs } from './schemas';
import { resolvers as baseResolvers } from './resolvers';
import { dateAwareFieldResolver, withRequestGuards } from './request-guards';

// ID checks, pagination limits and ISO dates for every operation
export const resolvers = withRequestGuards(baseResolvers);

export const apolloServer = new ApolloServer({
  typeDefs,
  resolvers,
  fieldResolver: dateAwareFieldResolver,
});

export { typeDefs, dateAwareFieldResolver };
