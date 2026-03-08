/**
 * GraphQL Context Types
 */

import type { JWTPayload } from '@/lib/auth';

/**
 * GraphQL Context
 */
export interface GraphQLContext {
  user: JWTPayload | null;
}

/**
 * Resolver parent type
 */
export type ResolverParent = unknown;

/**
 * Base resolver function type
 */
export type ResolverFn<TArgs, TResult> = (
  parent: ResolverParent,
  args: TArgs,
  context: GraphQLContext
) => Promise<TResult> | TResult;
