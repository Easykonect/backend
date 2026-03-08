/**
 * GraphQL Resolvers
 * Combined resolvers for the application
 */

import {
  registerUser,
  loginUser,
  getCurrentUser,
  verifyEmail,
  resendVerificationOtp,
  forgotPassword,
  resetPassword,
  refreshAccessToken,
  getClientIp,
} from '@/services/auth.service';
import { getUserById, getUsers, updateUserProfile, deleteUser } from '@/services/user.service';
import { requireAuth, requireRole, type GraphQLContext } from '@/middleware';
import { UserRole } from '@/constants';

export const resolvers = {
  Query: {
    // Get current authenticated user
    me: async (_: unknown, __: unknown, context: GraphQLContext) => {
      const user = requireAuth(context);
      return getCurrentUser(user.userId);
    },

    // Get user by ID
    user: async (_: unknown, args: { id: string }, context: GraphQLContext) => {
      requireAuth(context);
      return getUserById(args.id);
    },

    // Get all users (Admin only)
    users: async (
      _: unknown,
      args: { pagination?: { page?: number; limit?: number } },
      context: GraphQLContext
    ) => {
      requireRole(context, UserRole.ADMIN);
      const { page = 1, limit = 10 } = args.pagination || {};
      return getUsers({ page, limit });
    },
  },

  Mutation: {
    // ==================
    // Auth - Registration & Verification
    // ==================
    
    /**
     * Register new user
     * Sends verification OTP to email
     */
    register: async (
      _: unknown,
      args: {
        input: {
          email: string;
          password: string;
          firstName: string;
          lastName: string;
          phone?: string;
        };
      }
    ) => {
      return registerUser(args.input);
    },

    /**
     * Verify email with OTP
     * Returns tokens on success
     */
    verifyEmail: async (
      _: unknown,
      args: { input: { email: string; otp: string } }
    ) => {
      return verifyEmail(args.input);
    },

    /**
     * Resend verification OTP
     */
    resendVerificationOtp: async (
      _: unknown,
      args: { input: { email: string } }
    ) => {
      return resendVerificationOtp(args.input);
    },

    // ==================
    // Auth - Login & Sessions
    // ==================

    /**
     * Login user
     * Tracks login IP for security
     */
    login: async (
      _: unknown,
      args: { input: { email: string; password: string } },
      context: GraphQLContext
    ) => {
      const clientIp = context.request ? getClientIp(context.request) : undefined;
      return loginUser(args.input, clientIp);
    },

    /**
     * Refresh access token
     */
    refreshToken: async (
      _: unknown,
      args: { refreshToken: string }
    ) => {
      return refreshAccessToken(args.refreshToken);
    },

    // ==================
    // Auth - Password Management
    // ==================

    /**
     * Request password reset
     * Sends OTP to email
     */
    forgotPassword: async (
      _: unknown,
      args: { input: { email: string } }
    ) => {
      return forgotPassword(args.input);
    },

    /**
     * Reset password with OTP
     */
    resetPassword: async (
      _: unknown,
      args: { input: { email: string; otp: string; newPassword: string } }
    ) => {
      return resetPassword(args.input);
    },

    // ==================
    // Users
    // ==================

    /**
     * Update user profile
     */
    updateProfile: async (
      _: unknown,
      args: {
        input: {
          firstName?: string;
          lastName?: string;
          phone?: string;
        };
      },
      context: GraphQLContext
    ) => {
      const user = requireAuth(context);
      return updateUserProfile(user.userId, args.input);
    },

    /**
     * Delete user (Admin only)
     */
    deleteUser: async (
      _: unknown,
      args: { id: string },
      context: GraphQLContext
    ) => {
      requireRole(context, UserRole.ADMIN);
      return deleteUser(args.id);
    },
  },
};
