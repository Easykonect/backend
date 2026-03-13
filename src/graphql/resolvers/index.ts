/**
 * GraphQL Resolvers
 * Combined resolvers for the application
 * 
 * API Structure:
 * - UNIFIED: User (SERVICE_USER) and Service Provider share auth APIs
 * - SEPARATE: Admin and Super Admin have their own auth APIs
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
  changePassword,
} from '@/services/auth.service';

import {
  getUserById,
  getUsers,
  updateUserProfile,
  deleteUser,
  deleteOwnAccount,
} from '@/services/user.service';

import {
  becomeProvider,
  updateProviderProfile,
  getUserWithProvider,
  getPendingProviders,
  approveProvider,
  rejectProvider,
} from '@/services/provider.service';

import {
  adminLogin,
  createAdmin,
  adminForgotPassword,
  adminResetPassword,
  adminChangePassword,
  adminRefreshToken,
  getCurrentAdmin,
  updateAdminProfile,
  getAdmins,
  getAdminById,
  suspendAdmin,
  activateAdmin,
  updateAdminRole,
  deleteAdmin,
  suspendUser,
  activateUser,
} from '@/services/admin.service';

import {
  getServices,
  getServiceById,
  getMyServices,
  createService,
  updateService,
  deleteService,
  submitServiceForApproval,
  getPendingServices,
  approveService,
  rejectService,
  suspendService,
} from '@/services/service.service';

import {
  getCategories,
  getCategoryById,
  createCategory,
  updateCategory,
  deleteCategory,
} from '@/services/category.service';

import {
  createBooking,
  getUserBookings,
  getBookingById,
  cancelBooking,
  updateBooking,
  getProviderBookings,
  acceptBooking,
  rejectBooking,
  startService,
  completeService,
  getAllBookings,
  adminCancelBooking,
  getProviderBookingStats,
  getUserBookingStats,
} from '@/services/booking.service';

import { requireAuth, requireRole, requireAnyRole, type GraphQLContext } from '@/middleware';
import { UserRole, ServiceStatus, type ServiceStatusType } from '@/constants';

/**
 * Helper: Require admin authentication (ADMIN or SUPER_ADMIN)
 */
const requireAdminAuth = (context: GraphQLContext) => {
  return requireAnyRole(context, [UserRole.ADMIN, UserRole.SUPER_ADMIN]);
};

export const resolvers = {
  Query: {
    // ==================
    // User & Provider Queries (Unified)
    // ==================

    /**
     * Get current authenticated user
     * Works for both SERVICE_USER and SERVICE_PROVIDER
     */
    me: async (_: unknown, __: unknown, context: GraphQLContext) => {
      const user = requireAuth(context);
      return getUserWithProvider(user.userId);
    },

    /**
     * Get user by ID
     */
    user: async (_: unknown, args: { id: string }, context: GraphQLContext) => {
      requireAuth(context);
      return getUserWithProvider(args.id);
    },

    /**
     * Get all users (Admin only)
     */
    users: async (
      _: unknown,
      args: { pagination?: { page?: number; limit?: number } },
      context: GraphQLContext
    ) => {
      requireRole(context, UserRole.ADMIN);
      const { page = 1, limit = 10 } = args.pagination || {};
      return getUsers({ page, limit });
    },

    // ==================
    // Service Queries
    // ==================

    /**
     * Get all categories
     */
    categories: async (
      _: unknown,
      args: { pagination?: { page?: number; limit?: number } }
    ) => {
      const { page = 1, limit = 50 } = args.pagination || {};
      return getCategories({ page, limit });
    },

    /**
     * Get category by ID
     */
    category: async (_: unknown, args: { id: string }) => {
      return getCategoryById(args.id);
    },

    /**
     * Get all services with filters
     */
    services: async (
      _: unknown,
      args: {
        filters?: {
          categoryId?: string;
          providerId?: string;
          status?: string;
          minPrice?: number;
          maxPrice?: number;
          search?: string;
        };
        pagination?: { page?: number; limit?: number };
      }
    ) => {
      const { page = 1, limit = 20 } = args.pagination || {};
      const filters = {
        ...args.filters,
        status: args.filters?.status as ServiceStatusType | undefined,
      };
      return getServices(filters, { page, limit });
    },

    /**
     * Get service by ID
     */
    service: async (_: unknown, args: { id: string }) => {
      return getServiceById(args.id);
    },

    /**
     * Get provider's own services
     */
    myServices: async (
      _: unknown,
      args: { pagination?: { page?: number; limit?: number } },
      context: GraphQLContext
    ) => {
      const user = requireAuth(context);
      requireRole(context, UserRole.SERVICE_PROVIDER);
      const { page = 1, limit = 20 } = args.pagination || {};
      return getMyServices(user.userId, { page, limit });
    },

    // ==================
    // Admin Queries (Separate)
    // ==================

    /**
     * Get current admin
     */
    adminMe: async (_: unknown, __: unknown, context: GraphQLContext) => {
      const admin = requireAdminAuth(context);
      return getCurrentAdmin(admin.userId);
    },

    /**
     * Get all admins (SUPER_ADMIN only)
     */
    admins: async (
      _: unknown,
      args: { pagination?: { page?: number; limit?: number } },
      context: GraphQLContext
    ) => {
      requireRole(context, UserRole.SUPER_ADMIN);
      const { page = 1, limit = 10 } = args.pagination || {};
      return getAdmins({ page, limit });
    },

    /**
     * Get admin by ID (SUPER_ADMIN only)
     */
    admin: async (_: unknown, args: { id: string }, context: GraphQLContext) => {
      requireRole(context, UserRole.SUPER_ADMIN);
      return getAdminById(args.id);
    },

    /**
     * Get pending providers (Admin)
     */
    pendingProviders: async (
      _: unknown,
      args: { pagination?: { page?: number; limit?: number } },
      context: GraphQLContext
    ) => {
      requireRole(context, UserRole.ADMIN);
      const { page = 1, limit = 10 } = args.pagination || {};
      return getPendingProviders({ page, limit });
    },

    /**
     * Get pending services (Admin)
     */
    pendingServices: async (
      _: unknown,
      args: { pagination?: { page?: number; limit?: number } },
      context: GraphQLContext
    ) => {
      requireRole(context, UserRole.ADMIN);
      const { page = 1, limit = 10 } = args.pagination || {};
      return getPendingServices({ page, limit });
    },

    // ==================
    // Booking Queries
    // ==================

    /**
     * Get booking by ID
     */
    booking: async (
      _: unknown,
      args: { id: string },
      context: GraphQLContext
    ) => {
      const user = requireAuth(context);
      return getBookingById(args.id, user.userId, user.role);
    },

    /**
     * Get user's bookings (as customer)
     */
    myBookings: async (
      _: unknown,
      args: {
        filters?: { status?: string; startDate?: string; endDate?: string };
        pagination?: { page?: number; limit?: number };
      },
      context: GraphQLContext
    ) => {
      const user = requireAuth(context);
      const { page = 1, limit = 10 } = args.pagination || {};
      return getUserBookings(user.userId, args.filters || {}, { page, limit });
    },

    /**
     * Get provider's bookings
     */
    providerBookings: async (
      _: unknown,
      args: {
        filters?: { status?: string; startDate?: string; endDate?: string };
        pagination?: { page?: number; limit?: number };
      },
      context: GraphQLContext
    ) => {
      const user = requireAuth(context);
      requireRole(context, UserRole.SERVICE_PROVIDER);
      const { page = 1, limit = 10 } = args.pagination || {};
      return getProviderBookings(user.userId, args.filters || {}, { page, limit });
    },

    /**
     * Get user's booking statistics
     */
    myBookingStats: async (
      _: unknown,
      __: unknown,
      context: GraphQLContext
    ) => {
      const user = requireAuth(context);
      return getUserBookingStats(user.userId);
    },

    /**
     * Get provider's booking statistics
     */
    providerBookingStats: async (
      _: unknown,
      __: unknown,
      context: GraphQLContext
    ) => {
      const user = requireAuth(context);
      requireRole(context, UserRole.SERVICE_PROVIDER);
      return getProviderBookingStats(user.userId);
    },

    /**
     * Get all bookings (Admin only)
     */
    allBookings: async (
      _: unknown,
      args: {
        filters?: { status?: string; startDate?: string; endDate?: string };
        pagination?: { page?: number; limit?: number };
      },
      context: GraphQLContext
    ) => {
      requireAdminAuth(context);
      const { page = 1, limit = 10 } = args.pagination || {};
      return getAllBookings(args.filters || {}, { page, limit });
    },
  },

  Mutation: {
    // ==================
    // User & Provider Auth (Unified)
    // ==================

    /**
     * Register new user
     * Creates SERVICE_USER by default
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

    /**
     * Login (works for SERVICE_USER and SERVICE_PROVIDER)
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
    refreshToken: async (_: unknown, args: { refreshToken: string }) => {
      return refreshAccessToken(args.refreshToken);
    },

    /**
     * Request password reset
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

    /**
     * Change password (authenticated)
     */
    changePassword: async (
      _: unknown,
      args: { input: { currentPassword: string; newPassword: string } },
      context: GraphQLContext
    ) => {
      const user = requireAuth(context);
      return changePassword(user.userId, args.input);
    },

    /**
     * Logout
     */
    logout: async (_: unknown, __: unknown, context: GraphQLContext) => {
      requireAuth(context);
      // TODO: Invalidate refresh token in database/cache
      return {
        success: true,
        message: 'Logged out successfully',
      };
    },

    // ==================
    // User Profile (Unified)
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
     * Delete own account
     */
    deleteAccount: async (_: unknown, __: unknown, context: GraphQLContext) => {
      const user = requireAuth(context);
      return deleteOwnAccount(user.userId);
    },

    // ==================
    // Service Provider (Upgrade & Management)
    // ==================

    /**
     * Upgrade from SERVICE_USER to SERVICE_PROVIDER
     */
    becomeProvider: async (
      _: unknown,
      args: {
        input: {
          businessName: string;
          businessDescription?: string;
          address: string;
          city: string;
          state: string;
          country: string;
          latitude?: number;
          longitude?: number;
        };
      },
      context: GraphQLContext
    ) => {
      const user = requireAuth(context);
      return becomeProvider(user.userId, args.input);
    },

    /**
     * Update provider profile
     */
    updateProviderProfile: async (
      _: unknown,
      args: {
        input: {
          businessName?: string;
          businessDescription?: string;
          address?: string;
          city?: string;
          state?: string;
          country?: string;
          latitude?: number;
          longitude?: number;
        };
      },
      context: GraphQLContext
    ) => {
      const user = requireAuth(context);
      requireRole(context, UserRole.SERVICE_PROVIDER);
      return updateProviderProfile(user.userId, args.input);
    },

    // ==================
    // Service Management (Provider Only)
    // ==================

    /**
     * Create a new service
     */
    createService: async (
      _: unknown,
      args: {
        input: {
          categoryId: string;
          name: string;
          description: string;
          price: number;
          duration: number;
          images?: string[];
        };
      },
      context: GraphQLContext
    ) => {
      const user = requireAuth(context);
      requireRole(context, UserRole.SERVICE_PROVIDER);
      return createService(user.userId, args.input);
    },

    /**
     * Update a service
     */
    updateService: async (
      _: unknown,
      args: {
        id: string;
        input: {
          categoryId?: string;
          name?: string;
          description?: string;
          price?: number;
          duration?: number;
          images?: string[];
          status?: string;
        };
      },
      context: GraphQLContext
    ) => {
      const user = requireAuth(context);
      requireRole(context, UserRole.SERVICE_PROVIDER);
      const input = {
        ...args.input,
        status: args.input.status as ServiceStatusType | undefined,
      };
      return updateService(user.userId, args.id, input);
    },

    /**
     * Delete a service
     */
    deleteService: async (
      _: unknown,
      args: { id: string },
      context: GraphQLContext
    ) => {
      const user = requireAuth(context);
      requireRole(context, UserRole.SERVICE_PROVIDER);
      return deleteService(user.userId, args.id);
    },

    /**
     * Submit service for approval
     */
    submitServiceForApproval: async (
      _: unknown,
      args: { id: string },
      context: GraphQLContext
    ) => {
      const user = requireAuth(context);
      requireRole(context, UserRole.SERVICE_PROVIDER);
      return submitServiceForApproval(user.userId, args.id);
    },

    // ==================
    // Booking Management (User)
    // ==================

    /**
     * Create a new booking (USER only)
     */
    createBooking: async (
      _: unknown,
      args: {
        input: {
          serviceId: string;
          scheduledDate: string;
          scheduledTime: string;
          address: string;
          city: string;
          state: string;
          notes?: string;
        };
      },
      context: GraphQLContext
    ) => {
      const user = requireAuth(context);
      return createBooking(user.userId, args.input);
    },

    /**
     * Update a pending booking (USER only)
     */
    updateBooking: async (
      _: unknown,
      args: {
        id: string;
        input: {
          scheduledDate?: string;
          scheduledTime?: string;
          address?: string;
          city?: string;
          state?: string;
          notes?: string;
        };
      },
      context: GraphQLContext
    ) => {
      const user = requireAuth(context);
      return updateBooking(args.id, user.userId, args.input);
    },

    /**
     * Cancel a booking (USER only)
     */
    cancelBooking: async (
      _: unknown,
      args: { id: string; reason: string },
      context: GraphQLContext
    ) => {
      const user = requireAuth(context);
      return cancelBooking(args.id, user.userId, args.reason);
    },

    // ==================
    // Booking Management (Provider)
    // ==================

    /**
     * Accept a booking (PROVIDER only)
     */
    acceptBooking: async (
      _: unknown,
      args: { id: string },
      context: GraphQLContext
    ) => {
      const user = requireAuth(context);
      requireRole(context, UserRole.SERVICE_PROVIDER);
      return acceptBooking(args.id, user.userId);
    },

    /**
     * Reject a booking (PROVIDER only)
     */
    rejectBooking: async (
      _: unknown,
      args: { id: string; reason: string },
      context: GraphQLContext
    ) => {
      const user = requireAuth(context);
      requireRole(context, UserRole.SERVICE_PROVIDER);
      return rejectBooking(args.id, user.userId, args.reason);
    },

    /**
     * Start service - marks booking as IN_PROGRESS (PROVIDER only)
     */
    startService: async (
      _: unknown,
      args: { id: string },
      context: GraphQLContext
    ) => {
      const user = requireAuth(context);
      requireRole(context, UserRole.SERVICE_PROVIDER);
      return startService(args.id, user.userId);
    },

    /**
     * Complete service - marks booking as COMPLETED (PROVIDER only)
     */
    completeService: async (
      _: unknown,
      args: { id: string },
      context: GraphQLContext
    ) => {
      const user = requireAuth(context);
      requireRole(context, UserRole.SERVICE_PROVIDER);
      return completeService(args.id, user.userId);
    },

    // ==================
    // Booking Management (Admin)
    // ==================

    /**
     * Admin cancel any booking
     */
    adminCancelBooking: async (
      _: unknown,
      args: { id: string; reason: string },
      context: GraphQLContext
    ) => {
      requireAdminAuth(context);
      return adminCancelBooking(args.id, args.reason);
    },

    // ==================
    // Admin Auth (Separate)
    // ==================

    /**
     * Admin login
     */
    adminLogin: async (
      _: unknown,
      args: { input: { email: string; password: string } },
      context: GraphQLContext
    ) => {
      const clientIp = context.request ? getClientIp(context.request) : undefined;
      return adminLogin(args.input, clientIp);
    },

    /**
     * Admin refresh token
     */
    adminRefreshToken: async (_: unknown, args: { refreshToken: string }) => {
      return adminRefreshToken(args.refreshToken);
    },

    /**
     * Admin forgot password
     */
    adminForgotPassword: async (
      _: unknown,
      args: { input: { email: string } }
    ) => {
      return adminForgotPassword(args.input);
    },

    /**
     * Admin reset password
     */
    adminResetPassword: async (
      _: unknown,
      args: { input: { email: string; otp: string; newPassword: string } }
    ) => {
      return adminResetPassword(args.input);
    },

    /**
     * Admin change password
     */
    adminChangePassword: async (
      _: unknown,
      args: { input: { currentPassword: string; newPassword: string } },
      context: GraphQLContext
    ) => {
      const admin = requireAdminAuth(context);
      return adminChangePassword(admin.userId, args.input);
    },

    /**
     * Admin logout
     */
    adminLogout: async (_: unknown, __: unknown, context: GraphQLContext) => {
      requireAdminAuth(context);
      // TODO: Invalidate refresh token
      return {
        success: true,
        message: 'Admin logged out successfully',
      };
    },

    // ==================
    // Admin Profile Management
    // ==================

    /**
     * Update admin profile
     */
    updateAdminProfile: async (
      _: unknown,
      args: {
        input: {
          firstName?: string;
          lastName?: string;
        };
      },
      context: GraphQLContext
    ) => {
      const admin = requireAdminAuth(context);
      return updateAdminProfile(admin.userId, args.input);
    },

    // ==================
    // Admin Management (SUPER_ADMIN Only)
    // ==================

    /**
     * Create new admin
     */
    createAdmin: async (
      _: unknown,
      args: {
        input: {
          email: string;
          password: string;
          firstName: string;
          lastName: string;
          role: 'ADMIN' | 'SUPER_ADMIN';
        };
      },
      context: GraphQLContext
    ) => {
      const admin = requireRole(context, UserRole.SUPER_ADMIN);
      return createAdmin(args.input, admin.userId);
    },

    /**
     * Suspend admin
     */
    suspendAdmin: async (
      _: unknown,
      args: { adminId: string; reason: string },
      context: GraphQLContext
    ) => {
      const admin = requireRole(context, UserRole.SUPER_ADMIN);
      return suspendAdmin(args.adminId, args.reason, admin.userId);
    },

    /**
     * Activate admin
     */
    activateAdmin: async (
      _: unknown,
      args: { adminId: string },
      context: GraphQLContext
    ) => {
      requireRole(context, UserRole.SUPER_ADMIN);
      return activateAdmin(args.adminId);
    },

    /**
     * Update admin role
     */
    updateAdminRole: async (
      _: unknown,
      args: { adminId: string; role: 'ADMIN' | 'SUPER_ADMIN' },
      context: GraphQLContext
    ) => {
      const admin = requireRole(context, UserRole.SUPER_ADMIN);
      return updateAdminRole(args.adminId, args.role, admin.userId);
    },

    /**
     * Delete admin
     */
    deleteAdmin: async (
      _: unknown,
      args: { adminId: string },
      context: GraphQLContext
    ) => {
      const admin = requireRole(context, UserRole.SUPER_ADMIN);
      return deleteAdmin(args.adminId, admin.userId);
    },

    // ==================
    // User Management (Admin)
    // ==================

    /**
     * Suspend user
     */
    suspendUser: async (
      _: unknown,
      args: { userId: string; reason: string },
      context: GraphQLContext
    ) => {
      requireRole(context, UserRole.ADMIN);
      return suspendUser(args.userId, args.reason);
    },

    /**
     * Activate user
     */
    activateUser: async (
      _: unknown,
      args: { userId: string },
      context: GraphQLContext
    ) => {
      requireRole(context, UserRole.ADMIN);
      return activateUser(args.userId);
    },

    /**
     * Delete user (Admin)
     */
    deleteUser: async (
      _: unknown,
      args: { id: string },
      context: GraphQLContext
    ) => {
      requireRole(context, UserRole.ADMIN);
      return deleteUser(args.id);
    },

    // ==================
    // Provider Verification (Admin)
    // ==================

    /**
     * Approve provider
     */
    approveProvider: async (
      _: unknown,
      args: { providerId: string },
      context: GraphQLContext
    ) => {
      requireRole(context, UserRole.ADMIN);
      return approveProvider(args.providerId);
    },

    /**
     * Reject provider
     */
    rejectProvider: async (
      _: unknown,
      args: { providerId: string; reason: string },
      context: GraphQLContext
    ) => {
      requireRole(context, UserRole.ADMIN);
      return rejectProvider(args.providerId, args.reason);
    },

    // ==================
    // Service Moderation (Admin)
    // ==================

    /**
     * Approve service
     */
    approveService: async (
      _: unknown,
      args: { serviceId: string },
      context: GraphQLContext
    ) => {
      requireRole(context, UserRole.ADMIN);
      return approveService(args.serviceId);
    },

    /**
     * Reject service
     */
    rejectService: async (
      _: unknown,
      args: { serviceId: string; reason: string },
      context: GraphQLContext
    ) => {
      requireRole(context, UserRole.ADMIN);
      return rejectService(args.serviceId, args.reason);
    },

    /**
     * Suspend service
     */
    suspendService: async (
      _: unknown,
      args: { serviceId: string; reason: string },
      context: GraphQLContext
    ) => {
      requireRole(context, UserRole.ADMIN);
      return suspendService(args.serviceId, args.reason);
    },

    // ==================
    // Category Management (Admin)
    // ==================

    /**
     * Create category
     */
    createCategory: async (
      _: unknown,
      args: {
        input: {
          name: string;
          description?: string;
          icon?: string;
        };
      },
      context: GraphQLContext
    ) => {
      requireRole(context, UserRole.ADMIN);
      return createCategory(args.input);
    },

    /**
     * Update category
     */
    updateCategory: async (
      _: unknown,
      args: {
        id: string;
        input: {
          name?: string;
          description?: string;
          icon?: string;
          isActive?: boolean;
        };
      },
      context: GraphQLContext
    ) => {
      requireRole(context, UserRole.ADMIN);
      return updateCategory(args.id, args.input);
    },

    /**
     * Delete category
     */
    deleteCategory: async (
      _: unknown,
      args: { id: string },
      context: GraphQLContext
    ) => {
      requireRole(context, UserRole.ADMIN);
      return deleteCategory(args.id);
    },
  },

  // ==================
  // Field Resolvers
  // ==================

  /**
   * Booking field resolvers
   */
  Booking: {
    user: (parent: any) => parent.user,
    provider: (parent: any) => parent.provider,
    service: (parent: any) => parent.service,
    payment: (parent: any) => parent.payment || null,
    review: (parent: any) => parent.review || null,
    scheduledDate: (parent: any) => {
      if (parent.scheduledDate instanceof Date) {
        return parent.scheduledDate.toISOString();
      }
      return parent.scheduledDate;
    },
    completedAt: (parent: any) => {
      if (parent.completedAt instanceof Date) {
        return parent.completedAt.toISOString();
      }
      return parent.completedAt || null;
    },
    cancelledAt: (parent: any) => {
      if (parent.cancelledAt instanceof Date) {
        return parent.cancelledAt.toISOString();
      }
      return parent.cancelledAt || null;
    },
    createdAt: (parent: any) => {
      if (parent.createdAt instanceof Date) {
        return parent.createdAt.toISOString();
      }
      return parent.createdAt;
    },
    updatedAt: (parent: any) => {
      if (parent.updatedAt instanceof Date) {
        return parent.updatedAt.toISOString();
      }
      return parent.updatedAt;
    },
  },

  /**
   * Payment field resolvers
   */
  Payment: {
    paidAt: (parent: any) => {
      if (parent.paidAt instanceof Date) {
        return parent.paidAt.toISOString();
      }
      return parent.paidAt || null;
    },
    refundedAt: (parent: any) => {
      if (parent.refundedAt instanceof Date) {
        return parent.refundedAt.toISOString();
      }
      return parent.refundedAt || null;
    },
    createdAt: (parent: any) => {
      if (parent.createdAt instanceof Date) {
        return parent.createdAt.toISOString();
      }
      return parent.createdAt;
    },
    updatedAt: (parent: any) => {
      if (parent.updatedAt instanceof Date) {
        return parent.updatedAt.toISOString();
      }
      return parent.updatedAt;
    },
  },

  /**
   * Review field resolvers
   */
  Review: {
    user: (parent: any) => parent.user,
    provider: (parent: any) => parent.provider,
    createdAt: (parent: any) => {
      if (parent.createdAt instanceof Date) {
        return parent.createdAt.toISOString();
      }
      return parent.createdAt;
    },
    updatedAt: (parent: any) => {
      if (parent.updatedAt instanceof Date) {
        return parent.updatedAt.toISOString();
      }
      return parent.updatedAt;
    },
  },
};
