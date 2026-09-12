/**
 * Authentication Middleware
 * Handles authentication and authorization for GraphQL resolvers
 */

import { GraphQLError } from 'graphql';
import prisma from '@/lib/prisma';
import { verifyAccessToken, getTokenIssuedAtMs, type JWTPayload } from '@/lib/auth';
import { ErrorCode, ErrorMessage, type UserRoleType, hasMinimumRole } from '@/constants';
import { isBanActive, isIssuedAfter, isTokenValid } from '@/utils/security';
import { isAccessTokenRevoked } from '@/services/token.service';

/**
 * Context type for GraphQL resolvers
 */
export interface GraphQLContext {
  user: JWTPayload | null;
  request?: Request;
}

/**
 * The token from an `Authorization: Bearer` header, or null
 */
export const getBearerToken = (request?: Request): string | null => {
  const authHeader = request?.headers.get('authorization');
  return authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : null;
};

/**
 * Check that the account behind a valid access token may still use the API:
 * - the token wasn't revoked at sign-out, and wasn't issued before the account's
 *   sessions were ended (password change or reset, deactivation, deletion, or an
 *   admin ban or forced sign-out)
 * - the account exists, isn't suspended, deactivated or banned, and still has
 *   the role the token was issued with
 *
 * Pass the raw token when there is one, so tokens issued before token IDs
 * existed can be matched against sign-outs too.
 */
export const isSessionAllowed = async (payload: JWTPayload, token?: string): Promise<boolean> => {
  if (payload.iat && !(await isTokenValid(payload.userId, payload.iat, payload.iatMs))) {
    return false;
  }

  if (await isAccessTokenRevoked(payload, token)) {
    return false;
  }

  const account = await prisma.user.findUnique({
    where: { id: payload.userId },
    select: {
      role: true,
      status: true,
      bannedAt: true,
      bannedUntil: true,
      tokenInvalidatedAt: true,
    },
  });

  if (
    !account ||
    account.status === 'SUSPENDED' ||
    account.status === 'DEACTIVATED' ||
    isBanActive(account)
  ) {
    return false;
  }

  if (
    account.tokenInvalidatedAt &&
    !isIssuedAfter(getTokenIssuedAtMs(payload), account.tokenInvalidatedAt.getTime())
  ) {
    return false;
  }

  return account.role === payload.role;
};

/**
 * Extract and verify the access token from request headers
 */
export const getAuthContext = async (
  request: Request
): Promise<GraphQLContext> => {
  const token = getBearerToken(request);

  if (!token) {
    return { user: null, request };
  }

  try {
    const payload = verifyAccessToken(token);

    if (!(await isSessionAllowed(payload, token))) {
      return { user: null, request };
    }

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
