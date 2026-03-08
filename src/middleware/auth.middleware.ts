/**
 * Authentication Middleware
 * Handles authentication and authorization for GraphQL resolvers
 */

import { GraphQLError } from 'graphql';
import { verifyToken, type JWTPayload } from '@/lib/auth';
import { ErrorCode, ErrorMessage, type UserRoleType, hasMinimumRole } from '@/constants';

/**
 * Context type for GraphQL resolvers
 */
export interface GraphQLContext {
  user: JWTPayload | null;
  request?: Request;
}

/**
 * Extract and verify token from request headers
 */
export const getAuthContext = async (
  request: Request
): Promise<GraphQLContext> => {
  const authHeader = request.headers.get('authorization');

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { user: null, request };
  }

  const token = authHeader.substring(7);

  try {
    const payload = verifyToken(token);
    return { user: payload, request };
  } catch {
    return { user: null, request };
  }
};

/**
 * Require authentication - throws if user is not logged in
 */
export const requireAuth = (context: GraphQLContext): JWTPayload => {
  if (!context.user) {
    throw new GraphQLError(ErrorMessage[ErrorCode.UNAUTHENTICATED], {
      extensions: { code: ErrorCode.UNAUTHENTICATED },
    });
  }
  return context.user;
};

/**
 * Require specific role - throws if user doesn't have required role
 */
export const requireRole = (
  context: GraphQLContext,
  requiredRole: UserRoleType
): JWTPayload => {
  const user = requireAuth(context);

  if (!hasMinimumRole(user.role, requiredRole)) {
    throw new GraphQLError(ErrorMessage[ErrorCode.UNAUTHORIZED], {
      extensions: { code: ErrorCode.UNAUTHORIZED },
    });
  }

  return user;
};

/**
 * Require any of the specified roles
 */
export const requireAnyRole = (
  context: GraphQLContext,
  allowedRoles: UserRoleType[]
): JWTPayload => {
  const user = requireAuth(context);

  if (!allowedRoles.includes(user.role)) {
    throw new GraphQLError(ErrorMessage[ErrorCode.UNAUTHORIZED], {
      extensions: { code: ErrorCode.UNAUTHORIZED },
    });
  }

  return user;
};
