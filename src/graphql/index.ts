/**
 * GraphQL Configuration
 * Apollo Server setup and exports
 */

import { ApolloServer } from '@apollo/server';
import { typeDefs } from './schemas';
import { resolvers } from './resolvers';

export const apolloServer = new ApolloServer({
  typeDefs,
  resolvers,
});

export { typeDefs, resolvers };
