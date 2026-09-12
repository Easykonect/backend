import { uploadProviderImages, removeProviderImage } from '@/services/provider-image.service';
import { GraphQLError } from 'graphql';
/**
 * GraphQL Resolvers
 * Combined resolvers for the application
 * 
 * API Structure:
 * - UNIFIED: User (SERVICE_USER) and Service Provider share auth APIs
 * - SEPARATE: Admin and Super Admin have their own auth APIs
 */

import prisma from '@/lib/prisma';

import {
  registerUser,
  loginUser,
  verifyEmail,
  resendVerificationOtp,
  forgotPassword,
  resetPassword,
  refreshAccessToken,
  getClientIp,
  changePassword,
  logout,
} from '@/services/auth.service';


import {
  getUsers,
  updateUserProfile,
  requestEmailChange,
  confirmEmailChange,
  deleteUser,
  deleteOwnAccount,
  likeProvider,
  unlikeProvider,
  toggleProviderLike,
  isProviderLiked,
  getProviderLikeCount,
  getMyLikedProviders,
} from '@/services/user.service';

import {
  becomeProvider,
  updateProviderProfile,
  getUserWithProvider,
  getPendingProviders,
  approveProvider,
  rejectProvider,
  submitForVerification,
  getVerificationStatus,
  switchActiveRole,
  getActiveRole,
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
  adminRequestEmailChange,
  adminConfirmEmailChange,
  getAdmins,
  getAdminById,
  suspendAdmin,
  activateAdmin,
  updateAdminRole,
  deleteAdmin,
  suspendUser,
  activateUser,
  adminLogout,
} from '@/services/admin.service';

import {
  getServices,
  getNearbyServices,
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
  confirmServiceDelivery,
  getAllBookings,
  adminCancelBooking,
  getProviderBookingStats,
  getUserBookingStats,
} from '@/services/booking.service';

import {
  createReview,
  respondToReview,
  getReviewById,
  getProviderReviews,
  getUserReviews,
  getProviderRatingStats,
  getServiceReviews,
  deleteReview,
  updateReview,
  canReviewBooking,
} from '@/services/review.service';

import {
  addFavourite,
  removeFavourite,
  getUserFavourites,
  isFavourited,
  getFavouriteById,
  toggleFavourite,
  getServiceFavouriteCount,
} from '@/services/favourite.service';

import {
  createDispute,
  getDisputeById,
  getBookingDispute,
  getMyDisputes,
  getAllDisputes,
  getOpenDisputesCount,
  takeDisputeUnderReview,
  resolveDispute,
  addDisputeEvidence,
  closeDispute,
  getDisputeStats,
} from '@/services/dispute.service';

import {
  uploadProfilePhoto,
  removeProfilePhoto,
  uploadServiceImages,
  removeServiceImage,
  uploadProviderDocuments,
  addProviderDocuments,
  removeProviderDocument,
  generateSignedUploadParams,
  getUploadStats,
  getDocumentViewUrl,
} from '@/services/upload.service';

import {
  createOrGetConversation,
  getConversationById,
  getMyConversations,
  archiveConversation,
  unarchiveConversation,
  sendMessage,
  getConversationMessages,
  markMessagesAsRead,
  deleteMessage,
  getUnreadMessageCount,
  startSupportConversation,
  getBookingConversation,
} from '@/services/messaging.service';

import {
  getNotificationById,
  getMyNotifications,
  markNotificationAsRead,
  markAllNotificationsAsRead,
  deleteNotification,
  deleteReadNotifications,
  getUnreadNotificationCount,
  getNotificationStats,
  sendAdminAnnouncement,
  sendAdminBroadcast,
  type BroadcastInput,
} from '@/services/notification.service';

import {
  registerPushToken,
  unregisterPushToken,
  updatePushPreference,
} from '@/services/push.service';

import {
  initializePayment,
  verifyPayment,
  payWithWallet,
  processRefund,
  getPaymentById,
  getPaymentByBookingId,
  getUserPayments,
  getProviderPayments,
  getProviderEarnings,
  getAllPayments,
  getPaymentStats,
} from '@/services/payment.service';

// Wallet & Bank Services (use bank.service for comprehensive bank functions)
import {
  ensureWallet,
  getOrCreateWallet,
  getWalletTransactions,
  adjustWalletBalance,
} from '@/services/wallet.service';

import {
  listBanks,
  suggestBankFromAccountNumber,
  verifyBankAccount,
  addProviderBankAccount,
  getProviderBankAccounts,
  getBankAccountById,
  setDefaultBankAccount,
  deleteBankAccount,
} from '@/services/bank.service';

import {
  requestWithdrawal,
  cancelWithdrawal,
  getProviderWithdrawals,
  getAllWithdrawals,
  processWithdrawal,
  rejectWithdrawal,
  retryWithdrawal,
  getProviderWithdrawalById,
  getWithdrawalProviderSummary,
  type WithdrawalProviderSummary,
} from '@/services/withdrawal.service';

import {
  getAllUsers,
  getUserDetails,
  getAllProviders,
  banUser,
  unbanUser,
  restrictUser,
  removeRestriction,
} from '@/services/user-management.service';

import {
  getProviderEarningsReport,
  getAdminPaymentAnalytics,
  getRefundStats,
  getTopEarningProviders,
} from '@/services/payment-analytics.service';

import {
  getPlatformSettings,
  updateCommissionRate,
} from '@/services/platform-settings.service';

import type { ModerationAction, ReportReason, ReportStatus, ReportTargetType } from '@prisma/client';

import {
  blockUser,
  unblockUser,
  getMyBlockedUsers,
} from '@/services/block.service';

import {
  createReport,
  getMyReports,
  getReports,
  getReportById,
  getReportedConversationMessages,
  resolveReport,
} from '@/services/report.service';

import { acceptTerms, getTermsStatus } from '@/services/terms.service';

import {
  setPayoutSchedule,
  getPayoutSchedule,
  pausePayoutSchedule,
  getProviderPendingEarnings,
  getScheduledPayoutHistory,
} from '@/services/payout.service';

import {
  getAuditLogs,
} from '@/services/audit.service';

import { requireAuth, requireRole, requireAnyRole, getBearerToken, type GraphQLContext } from '@/middleware';
import { UserRole, type ServiceStatusType } from '@/constants';

import {
  browseProviders,
  getNearbyProviders,
  getProviderPublicProfile,
} from '@/services/browse.service';

import {
  enablePushNotifications,
  disablePushNotifications,
  togglePushNotifications,
  getPushStatus,
  getMySettings,
  updateMySettings,
  resetMySettings,
  deactivateMyAccount,
  reactivateMyAccount,
} from '@/services/settings.service';

/**
 * Helper: Require admin authentication (ADMIN or SUPER_ADMIN)
 */
const requireAdminAuth = (context: GraphQLContext) => {
  return requireAnyRole(context, [UserRole.ADMIN, UserRole.SUPER_ADMIN]);
};

/**
 * Helper: Require super admin authentication (SUPER_ADMIN only)
 */
const requireSuperAdminAuth = (context: GraphQLContext) => {
  return requireRole(context, UserRole.SUPER_ADMIN);
};

/**
 * Helper: Require a service provider. Checked by exact role: requireRole ranks
 * roles, which would let admins into provider-only operations.
 */
const requireProviderAuth = (context: GraphQLContext) => {
  return requireAnyRole(context, [UserRole.SERVICE_PROVIDER]);
};

const providerNotFound = () =>
  new GraphQLError('Provider profile not found', {
    extensions: { code: 'PROVIDER_NOT_FOUND' },
  });

/**
 * The signed-in admin behind a provider or service decision, for the audit log
 */
const moderationActor = (admin: { userId: string; role: string }, context: GraphQLContext) => ({
  id: admin.userId,
  role: admin.role,
  ipAddress: context.request ? getClientIp(context.request) : undefined,
  userAgent: context.request?.headers.get('user-agent') ?? undefined,
});

/**
 * Whether the viewer may see a provider's private fields: they are that provider, or an admin
 */
const isProviderOrAdmin = (providerUserId: string | undefined, context: GraphQLContext): boolean => {
  const viewer = context.user;
  if (!viewer) return false;
  const isAdmin = viewer.role === UserRole.ADMIN || viewer.role === UserRole.SUPER_ADMIN;
  return isAdmin || (Boolean(providerUserId) && providerUserId === viewer.userId);
};

/**
 * The review fields moderation affects, as they reach the Review type
 */
type ModeratedReview = {
  isHidden?: boolean | null;
  comment?: string | null;
  response?: string | null;
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
     * Get user by ID (own data only or admin)
     * IDOR Protection: Users can only view their own profile
     */
    user: async (_: unknown, args: { id: string }, context: GraphQLContext) => {
      const currentUser = requireAuth(context);
      
      // Allow users to view only their own profile
      // Admins can view any profile
      const isAdmin = currentUser.role === UserRole.ADMIN || currentUser.role === UserRole.SUPER_ADMIN;
      
      if (!isAdmin && currentUser.userId !== args.id) {
        throw new GraphQLError('You can only view your own profile', {
          extensions: { code: 'FORBIDDEN' },
        });
      }
      
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
      args: { pagination?: { page?: number; limit?: number }; includeInactive?: boolean | null },
      context: GraphQLContext
    ) => {
      // Inactive categories are for the admin dashboard only
      if (args.includeInactive) {
        requireAdminAuth(context);
      }
      const { page = 1, limit = 50 } = args.pagination || {};
      return getCategories({ page, limit }, Boolean(args.includeInactive));
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
          city?: string;
          state?: string;
          latitude?: number;
          longitude?: number;
          radiusKm?: number;
        };
        pagination?: { page?: number; limit?: number };
      },
      context: GraphQLContext
    ) => {
      const { page = 1, limit = 20 } = args.pagination || {};
      const filters = {
        ...args.filters,
        status: args.filters?.status as ServiceStatusType | undefined,
        // Hide the caller's own services from the customer-facing list.
        // Customer-only accounts will simply have no matching services to exclude.
        excludeProviderUserId: context.user?.userId,
      };
      // The role decides whether filters.status is honoured
      return getServices(filters, { page, limit }, context.user?.role);
    },

    /**
     * Get service by ID. Non-active services are only for their provider and
     * admins, and blocks hide the service between the viewer and the provider.
     */
    service: async (_: unknown, args: { id: string }, context: GraphQLContext) => {
      const viewer = context.user ? { userId: context.user.userId, role: context.user.role } : null;
      return getServiceById(args.id, viewer);
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
      requireProviderAuth(context);
      const { page = 1, limit = 20 } = args.pagination || {};
      return getMyServices(user.userId, { page, limit });
    },

    /**
     * Get provider verification status
     */
    myVerificationStatus: async (
      _: unknown,
      __: unknown,
      context: GraphQLContext
    ) => {
      const user = requireAuth(context);
      requireProviderAuth(context);
      return getVerificationStatus(user.userId);
    },

    /**
     * Get own provider profile with full provider details & services
     * Only accessible to SERVICE_PROVIDER role
     */
    myProviderProfile: async (
      _: unknown,
      __: unknown,
      context: GraphQLContext
    ) => {
      const user = requireProviderAuth(context);
      return getUserWithProvider(user.userId);
    },

    /**
     * Get current active role status (for role switching)
     */
    myActiveRole: async (
      _: unknown,
      __: unknown,
      context: GraphQLContext
    ) => {
      const user = requireAuth(context);
      return getActiveRole(user.userId);
    },

    // ==================
    // Review Queries
    // ==================

    /**
     * Get review by ID
     */
    review: async (
      _: unknown,
      args: { id: string },
      _context: GraphQLContext
    ) => {
      return getReviewById(args.id);
    },

    /**
     * Get reviews for a provider
     */
    providerReviews: async (
      _: unknown,
      args: {
        providerId: string;
        filters?: { rating?: number; hasResponse?: boolean };
        pagination?: { page?: number; limit?: number };
      },
      _context: GraphQLContext
    ) => {
      const { page = 1, limit = 10 } = args.pagination || {};
      return getProviderReviews(args.providerId, args.filters || {}, { page, limit });
    },

    /**
     * Get reviews for a service
     */
    serviceReviews: async (
      _: unknown,
      args: {
        serviceId: string;
        pagination?: { page?: number; limit?: number };
      },
      _context: GraphQLContext
    ) => {
      const { page = 1, limit = 10 } = args.pagination || {};
      return getServiceReviews(args.serviceId, { page, limit });
    },

    /**
     * Get my reviews (reviews I've written)
     */
    myReviews: async (
      _: unknown,
      args: { pagination?: { page?: number; limit?: number } },
      context: GraphQLContext
    ) => {
      const user = requireAuth(context);
      const { page = 1, limit = 10 } = args.pagination || {};
      return getUserReviews(user.userId, { page, limit });
    },

    /**
     * Get provider's rating statistics
     */
    providerRating: async (
      _: unknown,
      args: { providerId: string },
      _context: GraphQLContext
    ) => {
      return getProviderRatingStats(args.providerId);
    },

    /**
     * Check if user can review a booking
     */
    canReviewBooking: async (
      _: unknown,
      args: { bookingId: string },
      context: GraphQLContext
    ) => {
      const user = requireAuth(context);
      return canReviewBooking(user.userId, args.bookingId);
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
      requireProviderAuth(context);
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
      requireProviderAuth(context);
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

    // ==================
    // Favourite Queries
    // ==================

    /**
     * Get user's favourite services
     */
    myFavourites: async (
      _: unknown,
      args: { pagination?: { page?: number; limit?: number } },
      context: GraphQLContext
    ) => {
      const user = requireAuth(context);
      const { page = 1, limit = 10 } = args.pagination || {};
      return getUserFavourites(user.userId, { page, limit });
    },

    /**
     * Get a specific favourite by ID
     */
    favourite: async (
      _: unknown,
      args: { id: string },
      context: GraphQLContext
    ) => {
      const user = requireAuth(context);
      return getFavouriteById(user.userId, args.id);
    },

    /**
     * Check if a service is favourited by the user
     */
    isFavourited: async (
      _: unknown,
      args: { serviceId: string },
      context: GraphQLContext
    ) => {
      const user = requireAuth(context);
      return isFavourited(user.userId, args.serviceId);
    },

    /**
     * Get favourite count for a service (public)
     */
    serviceFavouriteCount: async (
      _: unknown,
      args: { serviceId: string }
    ) => {
      return getServiceFavouriteCount(args.serviceId);
    },


    // ==================
    // Provider Like Queries
    // ==================

    /**
     * Get providers liked by the user
     */
    myLikedProviders: async (
      _: unknown,
      args: { pagination?: { page?: number; limit?: number } },
      context: GraphQLContext
    ) => {
      const user = requireAuth(context);
  const { page = 1, limit = 10 } = args.pagination || {};
  return getMyLikedProviders(user.userId, { page, limit });
    },

    /**
     * Check if a provider is liked by the user
     */
    isProviderLiked: async (
      _: unknown,
      args: { providerId: string },
      context: GraphQLContext
    ) => {
      const user = requireAuth(context);
      const liked = await isProviderLiked(user.userId, args.providerId);
      const likeCount = await getProviderLikeCount(args.providerId);
      return { isLiked: liked, likeCount };
    },

    /**
     * Get like count for a provider (public)
     */
    providerLikeCount: async (
      _: unknown,
      args: { providerId: string }
    ) => {
      return getProviderLikeCount(args.providerId);
    },

    // ==================
    // Browse / Discovery Queries (Public)
    // ==================

    /**
     * Browse all verified providers with filters + sorting
     */
    providers: async (
      _: unknown,
      args: { input?: { filters?: any; sortBy?: string; pagination?: { page: number; limit: number } } },
      context: GraphQLContext
    ) => {
      const { filters, sortBy, pagination } = args.input ?? {};
      return browseProviders({
        filters: filters ?? {},
        sortBy: (sortBy as any) ?? 'NEWEST',
        pagination: pagination ?? { page: 1, limit: 10 },
        excludeUserId: context.user?.userId,
      });
    },

    /**
     * Get a provider's full public profile by ID
     */
    providerProfile: async (
      _: unknown,
      args: { providerId: string },
      context: GraphQLContext
    ) => {
      // Unverified providers are visible only to themselves and admins
      return getProviderPublicProfile(args.providerId, context.user);
    },

    /**
     * Get nearby providers using Haversine distance (geolocation)
     */
    nearbyProviders: async (
      _: unknown,
      args: {
        input: {
          latitude: number;
          longitude: number;
          radiusKm?: number;
          filters?: any;
          sortBy?: string;
          pagination?: { page: number; limit: number };
        };
      },
      context: GraphQLContext
    ) => {
      const { latitude, longitude, radiusKm, filters, sortBy, pagination } = args.input;
      return getNearbyProviders({
        latitude,
        longitude,
        radiusKm,
        filters: filters ?? {},
        sortBy: (sortBy as any) ?? 'RATING_DESC',
        pagination: pagination ?? { page: 1, limit: 10 },
        excludeUserId: context.user?.userId,
      });
    },

    /**
     * Get nearby services using Haversine distance (geolocation)
     */
    nearbyServices: async (
      _: unknown,
      args: {
        input: {
          latitude: number;
          longitude: number;
          radiusKm?: number;
          categoryId?: string;
          minPrice?: number;
          maxPrice?: number;
          search?: string;
          pagination?: { page?: number; limit?: number };
        };
      },
      context: GraphQLContext
    ) => {
      return getNearbyServices({
        ...args.input,
        excludeProviderUserId: context.user?.userId,
      });
    },

    // ==================
    // Dispute Queries
    // ==================

    /**
     * Get dispute by ID
     */
    dispute: async (
      _: unknown,
      args: { id: string },
      context: GraphQLContext
    ) => {
      const user = requireAuth(context);
      const isAdmin = user.role === UserRole.ADMIN || user.role === UserRole.SUPER_ADMIN;
      return getDisputeById(args.id, user.userId, isAdmin);
    },

    /**
     * Get dispute for a booking
     */
    bookingDispute: async (
      _: unknown,
      args: { bookingId: string },
      context: GraphQLContext
    ) => {
      const user = requireAuth(context);
      const isAdmin = user.role === UserRole.ADMIN || user.role === UserRole.SUPER_ADMIN;
      return getBookingDispute(args.bookingId, user.userId, isAdmin);
    },

    /**
     * Get user's disputes
     */
    myDisputes: async (
      _: unknown,
      args: {
        filters?: { status?: string; raisedByRole?: string };
        pagination?: { page?: number; limit?: number };
      },
      context: GraphQLContext
    ) => {
      const user = requireAuth(context);
      const { page = 1, limit = 10 } = args.pagination || {};
      return getMyDisputes(user.userId, args.filters || {}, { page, limit });
    },

    /**
     * Get all disputes (Admin only)
     */
    allDisputes: async (
      _: unknown,
      args: {
        filters?: { status?: string; raisedByRole?: string };
        pagination?: { page?: number; limit?: number };
      },
      context: GraphQLContext
    ) => {
      requireAdminAuth(context);
      const { page = 1, limit = 10 } = args.pagination || {};
      return getAllDisputes(args.filters || {}, { page, limit });
    },

    /**
     * Get open disputes count (Admin dashboard)
     */
    openDisputesCount: async (
      _: unknown,
      __: unknown,
      context: GraphQLContext
    ) => {
      requireAdminAuth(context);
      return getOpenDisputesCount();
    },

    /**
     * Get dispute statistics (Admin dashboard)
     */
    disputeStats: async (
      _: unknown,
      __: unknown,
      context: GraphQLContext
    ) => {
      requireAdminAuth(context);
      return getDisputeStats();
    },

    // ==================
    // Upload Queries
    // ==================

    /**
     * Get signed upload parameters for profile photo
     */
    getProfileUploadParams: async (
      _: unknown,
      __: unknown,
      context: GraphQLContext
    ) => {
      const user = requireAuth(context);
      return generateSignedUploadParams('profile', user.userId);
    },

    /**
     * Get signed upload parameters for service images
     */
    getServiceUploadParams: async (
      _: unknown,
      __: unknown,
      context: GraphQLContext
    ) => {
      const user = requireProviderAuth(context);
      return generateSignedUploadParams('service', user.userId);
    },

    /**
     * Get signed upload parameters for documents
     */
    getDocumentUploadParams: async (
      _: unknown,
      __: unknown,
      context: GraphQLContext
    ) => {
      const user = requireProviderAuth(context);
      return generateSignedUploadParams('document', user.userId);
    },

    /**
     * Get signed upload parameters for dispute evidence
     */
    getEvidenceUploadParams: async (
      _: unknown,
      __: unknown,
      context: GraphQLContext
    ) => {
      const user = requireAuth(context);
      return generateSignedUploadParams('evidence', user.userId);
    },

    /**
     * Get upload statistics (Admin)
     */
    uploadStats: async (
      _: unknown,
      __: unknown,
      context: GraphQLContext
    ) => {
      requireAdminAuth(context);
      return getUploadStats();
    },

    // ==================
    // Messaging Queries
    // ==================

    /**
     * Get user's conversations
     */
    myConversations: async (
      _: unknown,
      args: { pagination?: { page?: number; limit?: number }; archived?: boolean | null },
      context: GraphQLContext
    ) => {
      const user = requireAuth(context);
      return getMyConversations(user.userId, args.pagination, { archived: args.archived ?? false });
    },

    /**
     * Get conversation by ID
     */
    conversation: async (
      _: unknown,
      args: { id: string },
      context: GraphQLContext
    ) => {
      const user = requireAuth(context);
      return getConversationById(user.userId, args.id);
    },

    /**
     * Get messages in a conversation
     */
    conversationMessages: async (
      _: unknown,
      args: { conversationId: string; pagination?: { page?: number; limit?: number } },
      context: GraphQLContext
    ) => {
      const user = requireAuth(context);
      return getConversationMessages(user.userId, args.conversationId, args.pagination);
    },

    /**
     * Get unread message count
     */
    unreadMessageCount: async (
      _: unknown,
      __: unknown,
      context: GraphQLContext
    ) => {
      const user = requireAuth(context);
      return getUnreadMessageCount(user.userId);
    },

    /**
     * Get booking conversation
     */
    bookingConversation: async (
      _: unknown,
      args: { bookingId: string },
      context: GraphQLContext
    ) => {
      const user = requireAuth(context);
      return getBookingConversation(user.userId, user.role, args.bookingId);
    },

    // ==================
    // Notification Queries
    // ==================

    /**
     * Get user's notifications
     */
    myNotifications: async (
      _: unknown,
      args: {
        filters?: { type?: string; isRead?: boolean };
        pagination?: { page?: number; limit?: number };
      },
      context: GraphQLContext
    ) => {
      const user = requireAuth(context);
      return getMyNotifications(user.userId, args.filters, args.pagination);
    },

    /**
     * Get notification by ID
     */
    notification: async (
      _: unknown,
      args: { id: string },
      context: GraphQLContext
    ) => {
      const user = requireAuth(context);
      return getNotificationById(user.userId, args.id);
    },

    /**
     * Get unread notification count
     */
    unreadNotificationCount: async (
      _: unknown,
      __: unknown,
      context: GraphQLContext
    ) => {
      const user = requireAuth(context);
      return getUnreadNotificationCount(user.userId);
    },

    /**
     * Get notification statistics
     */
    notificationStats: async (
      _: unknown,
      __: unknown,
      context: GraphQLContext
    ) => {
      const user = requireAuth(context);
      return getNotificationStats(user.userId);
    },

    // ==================
    // Push Status Query
    // ==================

    /**
     * Get current push notification status (enabled + device registered)
     */
    myPushStatus: async (
      _: unknown,
      __: unknown,
      context: GraphQLContext
    ) => {
      const user = requireAuth(context);
      return getPushStatus(user.userId);
    },

    // ==================
    // Settings Query
    // ==================

    /**
     * Get authenticated user's account settings
     */
    mySettings: async (
      _: unknown,
      __: unknown,
      context: GraphQLContext
    ) => {
      const user = requireAuth(context);
      return getMySettings(user.userId);
    },

    // ==================
    // Payment Queries
    // ==================

    /**
     * Get payment by ID
     */
    payment: async (
      _: unknown,
      args: { id: string },
      context: GraphQLContext
    ) => {
      const user = requireAuth(context);
      return getPaymentById(args.id, user.userId, user.role);
    },

    /**
     * Get payment by booking ID
     */
    paymentByBooking: async (
      _: unknown,
      args: { bookingId: string },
      context: GraphQLContext
    ) => {
      const user = requireAuth(context);
      return getPaymentByBookingId(args.bookingId, { userId: user.userId, role: user.role });
    },

    /**
     * Get user's payment history
     */
    myPayments: async (
      _: unknown,
      args: {
        filters?: { status?: string; startDate?: string; endDate?: string };
        pagination?: { page?: number; limit?: number };
      },
      context: GraphQLContext
    ) => {
      const user = requireAuth(context);
      return getUserPayments(
        user.userId,
        args.filters || {},
        { page: args.pagination?.page || 1, limit: args.pagination?.limit || 10 }
      );
    },

    /**
     * Get provider's payment/earnings history
     */
    providerPayments: async (
      _: unknown,
      args: {
        filters?: { status?: string; startDate?: string; endDate?: string };
        pagination?: { page?: number; limit?: number };
      },
      context: GraphQLContext
    ) => {
      const user = requireProviderAuth(context);
      return getProviderPayments(
        user.userId,
        args.filters || {},
        { page: args.pagination?.page || 1, limit: args.pagination?.limit || 10 }
      );
    },

    /**
     * Get provider's earnings summary
     */
    myEarnings: async (
      _: unknown,
      __: unknown,
      context: GraphQLContext
    ) => {
      const user = requireProviderAuth(context);
      return getProviderEarnings(user.userId);
    },

    /**
     * Get all payments (Super Admin only)
     * Financial overview - restricted to super admin
     */
    allPayments: async (
      _: unknown,
      args: {
        filters?: { status?: string; startDate?: string; endDate?: string };
        pagination?: { page?: number; limit?: number };
      },
      context: GraphQLContext
    ) => {
      requireSuperAdminAuth(context);
      return getAllPayments(
        args.filters || {},
        { page: args.pagination?.page || 1, limit: args.pagination?.limit || 10 }
      );
    },

    /**
     * Get payment statistics (Super Admin only)
     * Includes commission data - restricted to super admin
     */
    paymentStats: async (
      _: unknown,
      __: unknown,
      context: GraphQLContext
    ) => {
      requireSuperAdminAuth(context);
      return getPaymentStats();
    },

    /**
     * Platform settings, including the commission rate (Admin)
     */
    platformSettings: async (
      _: unknown,
      __: unknown,
      context: GraphQLContext
    ) => {
      requireAdminAuth(context);
      return getPlatformSettings();
    },

    /**
     * People the current user has blocked
     */
    myBlockedUsers: async (
      _: unknown,
      args: { pagination?: { page?: number; limit?: number } },
      context: GraphQLContext
    ) => {
      const user = requireAuth(context);
      return getMyBlockedUsers(user.userId, args.pagination);
    },

    /**
     * Reports the current user has made
     */
    myReports: async (
      _: unknown,
      args: { pagination?: { page?: number; limit?: number } },
      context: GraphQLContext
    ) => {
      const user = requireAuth(context);
      return getMyReports(user.userId, args.pagination);
    },

    /**
     * Which community terms the current user has accepted
     */
    termsStatus: async (
      _: unknown,
      __: unknown,
      context: GraphQLContext
    ) => {
      const user = requireAuth(context);
      return getTermsStatus(user.userId);
    },

    /**
     * Report queue (Admin)
     */
    reports: async (
      _: unknown,
      args: {
        filters?: { status?: ReportStatus; targetType?: ReportTargetType; reason?: ReportReason };
        pagination?: { page?: number; limit?: number };
      },
      context: GraphQLContext
    ) => {
      requireAdminAuth(context);
      return getReports(args.filters ?? {}, args.pagination);
    },

    /**
     * One report (Admin)
     */
    report: async (
      _: unknown,
      args: { id: string },
      context: GraphQLContext
    ) => {
      requireAdminAuth(context);
      return getReportById(args.id);
    },

    /**
     * Messages in a reported conversation, audit-logged (Admin)
     */
    reportedConversationMessages: async (
      _: unknown,
      args: { reportId: string; pagination?: { page?: number; limit?: number } },
      context: GraphQLContext
    ) => {
      const admin = requireAdminAuth(context);
      return getReportedConversationMessages(
        args.reportId,
        { id: admin.userId, role: admin.role },
        args.pagination
      );
    },

    /**
     * List available banks
     */
    banks: async () => {
      return listBanks();
    },

    /**
     * Verify bank account details
     */
    verifyBankAccount: async (
      _: unknown,
      args: { accountNumber: string; bankCode: string },
      context: GraphQLContext
    ) => {
      const user = requireAuth(context);
      return verifyBankAccount(user.userId, args.accountNumber, args.bankCode);
    },

    /**
     * Suggest banks based on account number prefix
     */
    suggestBankFromAccountNumber: async (
      _: unknown,
      args: { accountNumber: string },
      context: GraphQLContext
    ) => {
      requireAuth(context);
      return suggestBankFromAccountNumber(args.accountNumber);
    },

    // ==================
    // Wallet Queries
    // ==================

    /**
     * Get my wallet
     */
    myWallet: async (
      _: unknown,
      __: unknown,
      context: GraphQLContext
    ) => {
      const user = requireAuth(context);
      return getOrCreateWallet(user.userId);
    },

    /**
     * Get wallet transaction history
     */
    myWalletTransactions: async (
      _: unknown,
      args: {
        filters?: {
          type?: string;
          source?: string;
          startDate?: string;
          endDate?: string;
        };
        pagination?: { page?: number; limit?: number };
      },
      context: GraphQLContext
    ) => {
      const user = requireAuth(context);
      // Only the wallet's ID is needed, not its balances
      const wallet = await ensureWallet(user.userId);
      return getWalletTransactions(
        wallet.id,
        (args.filters ?? {}) as Parameters<typeof getWalletTransactions>[1],
        { page: args.pagination?.page || 1, limit: args.pagination?.limit || 10 }
      );
    },

    // ==================
    // Bank Account Queries (Provider)
    // ==================

    /**
     * Get my bank accounts
     */
    myBankAccounts: async (
      _: unknown,
      __: unknown,
      context: GraphQLContext
    ) => {
      const user = requireProviderAuth(context);
      const provider = await prisma.serviceProvider.findUnique({
        where: { userId: user.userId },
      });
      if (!provider) {
        throw providerNotFound();
      }
      return getProviderBankAccounts(provider.id);
    },

    /**
     * Get a specific bank account
     */
    bankAccount: async (
      _: unknown,
      args: { id: string },
      context: GraphQLContext
    ) => {
      const user = requireProviderAuth(context);
      const provider = await prisma.serviceProvider.findUnique({
        where: { userId: user.userId },
      });
      if (!provider) {
        throw providerNotFound();
      }
      return getBankAccountById(args.id, provider.id);
    },

    // ==================
    // Withdrawal Queries (Provider)
    // ==================

    /**
     * Get my withdrawals
     */
    myWithdrawals: async (
      _: unknown,
      args: {
        filters?: {
          status?: string;
          startDate?: string;
          endDate?: string;
        };
        pagination?: { page?: number; limit?: number };
      },
      context: GraphQLContext
    ) => {
      const user = requireProviderAuth(context);
      const provider = await prisma.serviceProvider.findUnique({
        where: { userId: user.userId },
      });
      if (!provider) {
        throw providerNotFound();
      }
      return getProviderWithdrawals(
        provider.id,
        args.filters as Parameters<typeof getProviderWithdrawals>[1],
        { page: args.pagination?.page || 1, limit: args.pagination?.limit || 10 }
      );
    },

    /**
     * Get a specific withdrawal - Note: using getProviderWithdrawals with filter
     */
    withdrawal: async (
      _: unknown,
      args: { id: string },
      context: GraphQLContext
    ) => {
      const user = requireProviderAuth(context);
      const provider = await prisma.serviceProvider.findUnique({
        where: { userId: user.userId },
      });
      if (!provider) {
        throw providerNotFound();
      }
      return getProviderWithdrawalById(args.id, provider.id);
    },

    // ==================
    // Payout Schedule Queries (Provider)
    // ==================

    /**
     * Get my payout schedule
     */
    myPayoutSchedule: async (
      _: unknown,
      __: unknown,
      context: GraphQLContext
    ) => {
      const user = requireProviderAuth(context);
      const provider = await prisma.serviceProvider.findUnique({
        where: { userId: user.userId },
      });
      if (!provider) {
        throw providerNotFound();
      }
      return getPayoutSchedule(provider.id);
    },

    /**
     * Get pending earnings
     */
    myPendingEarnings: async (
      _: unknown,
      __: unknown,
      context: GraphQLContext
    ) => {
      const user = requireProviderAuth(context);
      const provider = await prisma.serviceProvider.findUnique({
        where: { userId: user.userId },
      });
      if (!provider) {
        throw providerNotFound();
      }
      return getProviderPendingEarnings(provider.id, user.userId);
    },

    /**
     * Get scheduled payouts
     */
    myScheduledPayouts: async (
      _: unknown,
      args: { pagination?: { page?: number; limit?: number } },
      context: GraphQLContext
    ) => {
      const user = requireProviderAuth(context);
      const provider = await prisma.serviceProvider.findUnique({
        where: { userId: user.userId },
      });
      if (!provider) {
        throw providerNotFound();
      }
      return getScheduledPayoutHistory(
        provider.id,
        { page: args.pagination?.page || 1, limit: args.pagination?.limit || 10 }
      );
    },

    // ==================
    // Payment Analytics Queries
    // ==================

    /**
     * Get provider earnings report
     */
    myEarningsReport: async (
      _: unknown,
      args: {
        input: {
          period: string;
          startDate?: string;
          endDate?: string;
        };
      },
      context: GraphQLContext
    ) => {
      const user = requireProviderAuth(context);
      const provider = await prisma.serviceProvider.findUnique({
        where: { userId: user.userId },
      });
      if (!provider) {
        throw providerNotFound();
      }
      return getProviderEarningsReport(
        provider.id,
        args.input.period as 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'ALL_TIME',
        args.input.startDate,
        args.input.endDate
      );
    },

    /**
     * Get admin payment analytics
     */
    adminPaymentAnalytics: async (
      _: unknown,
      args: {
        input: {
          period: string;
          startDate?: string;
          endDate?: string;
        };
      },
      context: GraphQLContext
    ) => {
      requireAdminAuth(context);
      return getAdminPaymentAnalytics(
        args.input as Parameters<typeof getAdminPaymentAnalytics>[0]
      );
    },

    /**
     * Providers with the most earnings released to their wallets in the
     * period, highest first (Admin)
     */
    topEarningProviders: async (
      _: unknown,
      args: { limit?: number | null; period?: string | null },
      context: GraphQLContext
    ) => {
      requireAdminAuth(context);
      return getTopEarningProviders(
        args.limit ?? undefined,
        (args.period ?? undefined) as Parameters<typeof getTopEarningProviders>[1]
      );
    },

    /**
     * Get refund statistics (Super Admin only)
     * Financial data - restricted to super admin
     */
    refundStats: async (
      _: unknown,
      args: { period?: string },
      context: GraphQLContext
    ) => {
      requireSuperAdminAuth(context);
      return getRefundStats(
        args.period as Parameters<typeof getRefundStats>[0] || 'ALL_TIME'
      );
    },

    // ==================
    // User Management Queries (Admin)
    // ==================

    /**
     * Get all managed users with filters
     */
    managedUsers: async (
      _: unknown,
      args: {
        filters?: {
          role?: string;
          accountStatus?: string;
          isBanned?: boolean;
          isRestricted?: boolean;
          searchTerm?: string;
          startDate?: string;
          endDate?: string;
          verificationStatus?: string;
          city?: string;
          state?: string;
        };
        pagination?: { page?: number; limit?: number };
      },
      context: GraphQLContext
    ) => {
      requireAdminAuth(context);
      return getAllUsers(
        args.filters as Parameters<typeof getAllUsers>[0] || {},
        { page: args.pagination?.page || 1, limit: args.pagination?.limit || 10 }
      );
    },

    /**
     * Get managed user details
     */
    managedUser: async (
      _: unknown,
      args: { id: string },
      context: GraphQLContext
    ) => {
      requireAdminAuth(context);
      return getUserDetails(args.id);
    },

    /**
     * Get all managed providers with filters
     */
    managedProviders: async (
      _: unknown,
      args: {
        filters?: {
          role?: string;
          accountStatus?: string;
          isBanned?: boolean;
          isRestricted?: boolean;
          searchTerm?: string;
          startDate?: string;
          endDate?: string;
        };
        pagination?: { page?: number; limit?: number };
      },
      context: GraphQLContext
    ) => {
      requireAdminAuth(context);
      return getAllProviders(
        args.filters as Parameters<typeof getAllProviders>[0] || {},
        { page: args.pagination?.page || 1, limit: args.pagination?.limit || 10 }
      );
    },

    /**
     * Get admin audit logs
     */
    auditLogs: async (
      _: unknown,
      args: {
        filters?: {
          action?: string;
          adminId?: string;
          targetId?: string;
          startDate?: string;
          endDate?: string;
        };
        pagination?: { page?: number; limit?: number };
      },
      context: GraphQLContext
    ) => {
      requireAdminAuth(context);
      return getAuditLogs(
        args.filters as Parameters<typeof getAuditLogs>[0] || {},
        { page: args.pagination?.page || 1, limit: args.pagination?.limit || 10 }
      );
    },

    /**
     * Get audit logs for a specific target
     */
    auditLogsForTarget: async (
      _: unknown,
      args: { targetId: string; pagination?: { page?: number; limit?: number } },
      context: GraphQLContext
    ) => {
      requireAdminAuth(context);
      return getAuditLogs(
        { targetId: args.targetId },
        { page: args.pagination?.page || 1, limit: args.pagination?.limit || 10 }
      );
    },

    /**
     * Get all pending withdrawals (Admin)
     */
    pendingWithdrawals: async (
      _: unknown,
      args: { pagination?: { page?: number; limit?: number } },
      context: GraphQLContext
    ) => {
      requireAdminAuth(context);
      // Use getAllWithdrawals with PENDING filter
      return getAllWithdrawals(
        { status: 'PENDING' } as Parameters<typeof getAllWithdrawals>[0],
        { page: args.pagination?.page || 1, limit: args.pagination?.limit || 10 }
      );
    },

    /**
     * Get all withdrawals (Admin)
     */
    allWithdrawals: async (
      _: unknown,
      args: {
        filters?: {
          status?: string;
          startDate?: string;
          endDate?: string;
          providerId?: string;
        };
        pagination?: { page?: number; limit?: number };
      },
      context: GraphQLContext
    ) => {
      requireAdminAuth(context);
      return getAllWithdrawals(
        args.filters as Parameters<typeof getAllWithdrawals>[0] || {},
        { page: args.pagination?.page || 1, limit: args.pagination?.limit || 10 }
      );
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
    logout: async (
      _: unknown,
      args: { refreshToken?: string | null },
      context: GraphQLContext
    ) => {
      const user = requireAuth(context);
      return logout(args.refreshToken, {
        payload: user,
        accessToken: getBearerToken(context.request),
      });
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
          profilePhoto?: string;
        };
      },
      context: GraphQLContext
    ) => {
      const user = requireAuth(context);
      return updateUserProfile(user.userId, args.input);
    },

    /**
     * Request email change — sends OTP to the new email
     */
    requestEmailChange: async (
      _: unknown,
      args: { input: { newEmail: string } },
      context: GraphQLContext
    ) => {
      const user = requireAuth(context);
      return requestEmailChange(user.userId, args.input.newEmail);
    },

    /**
     * Confirm email change — verifies OTP and commits the new email
     */
    confirmEmailChange: async (
      _: unknown,
      args: { input: { otp: string } },
      context: GraphQLContext
    ) => {
      const user = requireAuth(context);
      return confirmEmailChange(user.userId, args.input.otp);
    },

    /**
     * Delete own account
     */
    deleteAccount: async (
      _: unknown,
      args: { password?: string | null },
      context: GraphQLContext
    ) => {
      const user = requireAuth(context);
      return deleteOwnAccount(user.userId, args.password);
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
          profilePhoto?: string | null;
        };
      },
      context: GraphQLContext
    ) => {
      const user = requireAuth(context);
      requireProviderAuth(context);
      return updateProviderProfile(user.userId, args.input);
    },

    /**
     * Submit provider profile for verification
     */
    submitProviderForVerification: async (
      _: unknown,
      __: unknown,
      context: GraphQLContext
    ) => {
      const user = requireAuth(context);
      requireProviderAuth(context);
      return submitForVerification(user.userId);
    },

    /**
     * Switch between SERVICE_USER and SERVICE_PROVIDER mode
     * Only available for users who have a provider profile
     */
    switchActiveRole: async (
      _: unknown,
      args: { targetRole: string },
      context: GraphQLContext
    ) => {
      const user = requireAuth(context);
      return switchActiveRole(user.userId, args.targetRole);
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
      requireProviderAuth(context);
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
      requireProviderAuth(context);
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
      requireProviderAuth(context);
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
      requireProviderAuth(context);
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
      requireProviderAuth(context);
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
      requireProviderAuth(context);
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
      requireProviderAuth(context);
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
      requireProviderAuth(context);
      return completeService(args.id, user.userId);
    },

    /**
     * Confirm service delivery (USER only). The payment is released to the
     * provider 24 hours later unless a dispute is opened before then.
     */
    confirmServiceDelivery: async (
      _: unknown,
      args: { bookingId: string },
      context: GraphQLContext
    ) => {
      const user = requireAuth(context);
      requireRole(context, UserRole.SERVICE_USER);
      return confirmServiceDelivery(args.bookingId, user.userId);
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
      const admin = requireAdminAuth(context);
      return adminCancelBooking(args.id, args.reason, { id: admin.userId, role: admin.role });
    },

    // ==================
    // Payment Mutations
    // ==================

    /**
     * Initialize payment for a booking
     */
    initializePayment: async (
      _: unknown,
      args: { input: { bookingId: string; callbackUrl?: string; returnDeepLink?: string } },
      context: GraphQLContext
    ) => {
      const user = requireAuth(context);
      return initializePayment(user.userId, args.input);
    },

    /**
     * Verify payment status
     */
    verifyPayment: async (
      _: unknown,
      args: { transactionRef: string },
      context: GraphQLContext
    ) => {
      const user = requireAuth(context);
      return verifyPayment(args.transactionRef, { userId: user.userId, role: user.role });
    },

    /**
     * Process refund (Super Admin only)
     * Involves money movement - restricted to super admin
     */
    processRefund: async (
      _: unknown,
      args: { input: { paymentId: string; amount?: number; reason: string } },
      context: GraphQLContext
    ) => {
      const admin = requireSuperAdminAuth(context);
      return processRefund(admin.userId, args.input, admin.role);
    },

    // ==================
    // Wallet Mutations
    // ==================

    /**
     * Pay for a booking using wallet balance
     */
    payWithWallet: async (
      _: unknown,
      args: { input: { bookingId: string } },
      context: GraphQLContext
    ) => {
      const user = requireAuth(context);
      // The amount comes from the booking on the server
      return payWithWallet(user.userId, args.input.bookingId);
    },

    // ==================
    // Bank Account Mutations (Provider)
    // ==================

    /**
     * Add a bank account
     */
    addBankAccount: async (
      _: unknown,
      args: { input: { bankCode: string; accountNumber: string } },
      context: GraphQLContext
    ) => {
      const user = requireProviderAuth(context);
      const provider = await prisma.serviceProvider.findUnique({
        where: { userId: user.userId },
      });
      if (!provider) {
        throw providerNotFound();
      }
      return addProviderBankAccount(
        provider.id,
        args.input,
        user.userId
      );
    },

    /**
     * Set default bank account
     */
    setDefaultBankAccount: async (
      _: unknown,
      args: { id: string },
      context: GraphQLContext
    ) => {
      const user = requireProviderAuth(context);
      const provider = await prisma.serviceProvider.findUnique({
        where: { userId: user.userId },
      });
      if (!provider) {
        throw providerNotFound();
      }
      return setDefaultBankAccount(args.id, provider.id);
    },

    /**
     * Remove a bank account
     */
    removeBankAccount: async (
      _: unknown,
      args: { id: string },
      context: GraphQLContext
    ) => {
      const user = requireProviderAuth(context);
      const provider = await prisma.serviceProvider.findUnique({
        where: { userId: user.userId },
      });
      if (!provider) {
        throw providerNotFound();
      }
      await deleteBankAccount(args.id, provider.id);
      return { success: true, message: 'Bank account removed successfully' };
    },

    // ==================
    // Withdrawal Mutations (Provider)
    // ==================

    /**
     * Request a withdrawal
     */
    requestWithdrawal: async (
      _: unknown,
      args: { input: { amount: number; bankAccountId: string } },
      context: GraphQLContext
    ) => {
      const user = requireProviderAuth(context);
      const provider = await prisma.serviceProvider.findUnique({
        where: { userId: user.userId },
      });
      if (!provider) {
        throw providerNotFound();
      }
      const withdrawal = await requestWithdrawal(provider.id, user.userId, args.input);
      return {
        success: true,
        message: 'Withdrawal requested. It will be processed after review.',
        withdrawal,
      };
    },

    /**
     * Cancel a pending withdrawal
     */
    cancelWithdrawal: async (
      _: unknown,
      args: { id: string },
      context: GraphQLContext
    ) => {
      const user = requireProviderAuth(context);
      const provider = await prisma.serviceProvider.findUnique({
        where: { userId: user.userId },
      });
      if (!provider) {
        throw providerNotFound();
      }
      return cancelWithdrawal(args.id, provider.id, user.userId);
    },

    // ==================
    // Payout Schedule Mutations (Provider)
    // ==================

    /**
     * Set payout schedule
     */
    setPayoutSchedule: async (
      _: unknown,
      args: {
        input: {
          frequency: string;
          dayOfWeek?: number;
          dayOfMonth?: number;
          minimumAmount?: number;
          bankAccountId?: string;
        };
      },
      context: GraphQLContext
    ) => {
      const user = requireProviderAuth(context);
      const provider = await prisma.serviceProvider.findUnique({
        where: { userId: user.userId },
      });
      if (!provider) {
        throw providerNotFound();
      }
      return setPayoutSchedule(
        provider.id,
        user.userId,
        args.input as Parameters<typeof setPayoutSchedule>[2]
      );
    },

    /**
     * Disable scheduled payouts
     */
    disablePayoutSchedule: async (
      _: unknown,
      __: unknown,
      context: GraphQLContext
    ) => {
      const user = requireProviderAuth(context);
      const provider = await prisma.serviceProvider.findUnique({
        where: { userId: user.userId },
      });
      if (!provider) {
        throw providerNotFound();
      }
      await pausePayoutSchedule(provider.id);
      return { success: true, message: 'Payout schedule disabled' };
    },

    // ==================
    // Withdrawal Mutations (Admin)
    // ==================

    /**
     * Process a pending withdrawal (SUPER_ADMIN only)
     */
    processWithdrawal: async (
      _: unknown,
      args: { id: string },
      context: GraphQLContext
    ) => {
      const admin = requireSuperAdminAuth(context);
      const withdrawal = await processWithdrawal(args.id, admin.userId, admin.role);
      return { success: true, message: 'Withdrawal approved and transfer started', withdrawal };
    },

    /**
     * Reject a withdrawal (SUPER_ADMIN only)
     */
    rejectWithdrawal: async (
      _: unknown,
      args: { id: string; reason: string },
      context: GraphQLContext
    ) => {
      const admin = requireSuperAdminAuth(context);
      const withdrawal = await rejectWithdrawal(args.id, admin.userId, admin.role, args.reason);
      return { success: true, message: 'Withdrawal rejected', withdrawal };
    },

    /**
     * Retry a failed withdrawal (SUPER_ADMIN only)
     */
    retryWithdrawal: async (
      _: unknown,
      args: { id: string },
      context: GraphQLContext
    ) => {
      const admin = requireSuperAdminAuth(context);
      const withdrawal = await retryWithdrawal(args.id, admin.userId, admin.role);
      return { success: true, message: 'Transfer retried', withdrawal };
    },

    // ==================
    // User Management Mutations (Admin)
    // ==================

    /**
     * Ban a user/provider
     */
    banUser: async (
      _: unknown,
      args: { input: { userId: string; reason: string; durationDays?: number | null } },
      context: GraphQLContext
    ) => {
      const admin = requireAdminAuth(context);
      const clientIp = context.request ? getClientIp(context.request) : undefined;
      return banUser(
        { userId: args.input.userId, reason: args.input.reason, days: args.input.durationDays },
        admin.userId,
        admin.role,
        clientIp
      );
    },

    /**
     * Unban a user/provider
     */
    unbanUser: async (
      _: unknown,
      args: { userId: string },
      context: GraphQLContext
    ) => {
      const admin = requireAdminAuth(context);
      const clientIp = context.request ? getClientIp(context.request) : undefined;
      return unbanUser(args.userId, admin.userId, admin.role, clientIp);
    },

    /**
     * Restrict a user/provider for specific days
     */
    restrictUser: async (
      _: unknown,
      args: { input: { userId: string; reason: string; durationDays: number } },
      context: GraphQLContext
    ) => {
      const admin = requireAdminAuth(context);
      const clientIp = context.request ? getClientIp(context.request) : undefined;
      return restrictUser(
        { userId: args.input.userId, reason: args.input.reason, days: args.input.durationDays },
        admin.userId,
        admin.role,
        clientIp
      );
    },

    /**
     * Remove restriction from user/provider
     */
    removeRestriction: async (
      _: unknown,
      args: { userId: string },
      context: GraphQLContext
    ) => {
      const admin = requireAdminAuth(context);
      const clientIp = context.request ? getClientIp(context.request) : undefined;
      return removeRestriction(args.userId, admin.userId, admin.role, clientIp);
    },

    /**
     * Adjust a customer's or provider's wallet balance (SUPER_ADMIN only)
     * For manual corrections or compensations
     *
     * SECURITY: Super Admin only, max ₦1,000,000 per adjustment
     */
    adjustWalletBalance: async (
      _: unknown,
      args: { userId: string; amount: number; reason: string },
      context: GraphQLContext
    ) => {
      const admin = requireSuperAdminAuth(context);
      // Determine CREDIT or DEBIT based on amount sign
      const type = args.amount >= 0 ? 'CREDIT' : 'DEBIT';
      const amountKobo = Math.round(Math.abs(args.amount) * 100); // Convert to kobo
      // Pass admin role for limit enforcement
      await adjustWalletBalance(args.userId, amountKobo, type, args.reason, admin.userId, admin.role);
      // The mutation returns the updated wallet, not the ledger entry
      return getOrCreateWallet(args.userId);
    },

    /**
     * Set the commission rate for new bookings (SUPER_ADMIN only)
     * `rate` is a percentage: 7.5 means 7.5%
     */
    updateCommissionRate: async (
      _: unknown,
      args: { rate: number },
      context: GraphQLContext
    ) => {
      const admin = requireSuperAdminAuth(context);
      return updateCommissionRate(args.rate, admin.userId, admin.role);
    },

    /**
     * Broadcast a notification — ADMIN or SUPER_ADMIN.
     * ADMIN can target SERVICE_USER + SERVICE_PROVIDER only. Targeting the
     * ADMIN role is reserved for the super-admin endpoint below.
     *
     * Checked first, then counted against the admin's daily cap of 50, shared
     * with superAdminBroadcastNotification and sendSystemAnnouncement.
     */
    adminBroadcastNotification: async (
      _: unknown,
      args: { input: BroadcastInput },
      context: GraphQLContext
    ) => {
      const admin = requireAdminAuth(context);
      // ADMIN can target users + providers, never admins/super-admins.
      return sendAdminBroadcast(admin.userId, args.input, ['SERVICE_USER', 'SERVICE_PROVIDER']);
    },

    /**
     * Broadcast a notification — SUPER_ADMIN only.
     * Can additionally target the ADMIN role (e.g. ops-team announcements).
     *
     * The same checks and shared daily cap as adminBroadcastNotification.
     */
    superAdminBroadcastNotification: async (
      _: unknown,
      args: { input: BroadcastInput },
      context: GraphQLContext
    ) => {
      const admin = requireSuperAdminAuth(context);
      // SUPER_ADMIN can additionally hit ADMIN role.
      return sendAdminBroadcast(admin.userId, args.input, [
        'SERVICE_USER',
        'SERVICE_PROVIDER',
        'ADMIN',
      ]);
    },

    // ==================
    // Review Management
    // ==================

    /**
     * Create a review for a completed booking
     */
    createReview: async (
      _: unknown,
      args: { input: { bookingId: string; rating: number; comment?: string } },
      context: GraphQLContext
    ) => {
      const user = requireAuth(context);
      return createReview(user.userId, args.input);
    },

    /**
     * Update own review within 24 hours
     */
    updateReview: async (
      _: unknown,
      args: { id: string; input: { rating?: number; comment?: string } },
      context: GraphQLContext
    ) => {
      const user = requireAuth(context);
      return updateReview(user.userId, args.id, args.input);
    },

    /**
     * Provider responds to a review
     */
    respondToReview: async (
      _: unknown,
      args: { reviewId: string; response: string },
      context: GraphQLContext
    ) => {
      const user = requireAuth(context);
      requireProviderAuth(context);
      
      // Get provider ID
      const provider = await prisma.serviceProvider.findUnique({
        where: { userId: user.userId },
      });
      
      if (!provider) {
        throw providerNotFound();
      }
      
      return respondToReview(provider.id, args.reviewId, args.response);
    },

    /**
     * Delete a review (Admin only)
     */
    deleteReview: async (
      _: unknown,
      args: { id: string; reason?: string | null },
      context: GraphQLContext
    ) => {
      const admin = requireAdminAuth(context);
      return deleteReview(args.id, { id: admin.userId, role: admin.role }, args.reason ?? undefined);
    },

    // ==================
    // Favourite Management
    // ==================

    /**
     * Add a service to favourites
     */
    addFavourite: async (
      _: unknown,
      args: { serviceId: string },
      context: GraphQLContext
    ) => {
      const user = requireAuth(context);
      return addFavourite(user.userId, args.serviceId);
    },

    /**
     * Remove a service from favourites
     */
    removeFavourite: async (
      _: unknown,
      args: { serviceId: string },
      context: GraphQLContext
    ) => {
      const user = requireAuth(context);
      return removeFavourite(user.userId, args.serviceId);
    },

    /**
     * Toggle favourite status
     */
    toggleFavourite: async (
      _: unknown,
      args: { serviceId: string },
      context: GraphQLContext
    ) => {
      const user = requireAuth(context);
      return toggleFavourite(user.userId, args.serviceId);
    },


    // ==================
    // Provider Like Management
    // ==================

    /**
     * Like a provider
     */
    likeProvider: async (
      _: unknown,
      args: { providerId: string },
      context: GraphQLContext
    ) => {
      const user = requireAuth(context);
      return likeProvider(user.userId, args.providerId);
    },

    /**
     * Unlike a provider
     */
    unlikeProvider: async (
      _: unknown,
      args: { providerId: string },
      context: GraphQLContext
    ) => {
      const user = requireAuth(context);
      return unlikeProvider(user.userId, args.providerId);
    },

    /**
     * Toggle provider like status
     */
    toggleProviderLike: async (
      _: unknown,
      args: { providerId: string },
      context: GraphQLContext
    ) => {
      const user = requireAuth(context);
      return toggleProviderLike(user.userId, args.providerId);
    },

    // ==================
    // Dispute Management
    // ==================

    /**
     * Create a dispute for a booking
     */
    createDispute: async (
      _: unknown,
      args: {
        input: {
          bookingId: string;
          reason: string;
          description: string;
          evidence?: string[];
        };
      },
      context: GraphQLContext
    ) => {
      const user = requireAuth(context);
      return createDispute(user.userId, user.role, args.input);
    },

    /**
     * Add evidence to a dispute
     */
    addDisputeEvidence: async (
      _: unknown,
      args: { disputeId: string; evidence: string[] },
      context: GraphQLContext
    ) => {
      const user = requireAuth(context);
      return addDisputeEvidence(args.disputeId, user.userId, args.evidence);
    },

    /**
     * Take dispute under review (Admin only)
     */
    takeDisputeUnderReview: async (
      _: unknown,
      args: { disputeId: string },
      context: GraphQLContext
    ) => {
      const admin = requireAdminAuth(context);
      return takeDisputeUnderReview(args.disputeId, admin.userId);
    },

    /**
     * Resolve a dispute (Admin only)
     */
    resolveDispute: async (
      _: unknown,
      args: {
        disputeId: string;
        input: {
          resolution: string;
          resolutionNotes: string;
          refundAmount?: number;
        };
      },
      context: GraphQLContext
    ) => {
      const admin = requireAdminAuth(context);
      return resolveDispute(args.disputeId, admin.userId, args.input, admin.role);
    },

    /**
     * Close a dispute without resolution (Admin only)
     */
    closeDispute: async (
      _: unknown,
      args: { disputeId: string; reason: string },
      context: GraphQLContext
    ) => {
      const admin = requireAdminAuth(context);
      return closeDispute(args.disputeId, admin.userId, args.reason, admin.role);
    },

    // ==================
    // File Upload Management (User)
    // ==================

    /**
     * Upload profile photo
     */
    uploadProfilePhoto: async (
      _: unknown,
      args: { file: { base64Data: string; filename: string } },
      context: GraphQLContext
    ) => {
      const user = requireAuth(context);
      const result = await uploadProfilePhoto(
        user.userId,
        args.file.base64Data,
        args.file.filename
      );
      return {
        success: true,
        url: result.url,
        publicId: result.publicId,
        message: 'Profile photo uploaded successfully',
      };
    },

    /**
     * Remove profile photo
     */
    removeProfilePhoto: async (
      _: unknown,
      __: unknown,
      context: GraphQLContext
    ) => {
      const user = requireAuth(context);
      await removeProfilePhoto(user.userId);
      return {
        success: true,
        message: 'Profile photo removed successfully',
      };
    },

    // ==================
    // File Upload Management (Provider)
    // ==================

    /**
     * Upload provider gallery images
     */
    uploadProviderImages: async (
      _: unknown,
      args: { files: Array<{ base64Data: string; filename: string }> },
      context: GraphQLContext
    ) => {
      const user = requireProviderAuth(context);
      const urls = await uploadProviderImages(user.userId, args.files);
      return {
        success: true,
        urls,
        message: `${urls.length} image(s) uploaded successfully`,
      };
    },

    /**
     * Remove a provider gallery image
     */
    removeProviderImage: async (
      _: unknown,
      args: { imageUrl: string },
      context: GraphQLContext
    ) => {
      const user = requireProviderAuth(context);
      await removeProviderImage(user.userId, args.imageUrl);
      return { success: true, message: 'Image removed successfully' };
    },

    /**
     * Upload service images
     */
    uploadServiceImages: async (
      _: unknown,
      args: {
        serviceId: string;
        files: Array<{ base64Data: string; filename: string }>;
      },
      context: GraphQLContext
    ) => {
      const user = requireProviderAuth(context);
      const urls = await uploadServiceImages(
        user.userId,
        args.serviceId,
        args.files
      );
      return {
        success: true,
        urls,
        message: `${urls.length} image(s) uploaded successfully`,
      };
    },

    /**
     * Remove service image
     */
    removeServiceImage: async (
      _: unknown,
      args: { serviceId: string; imageUrl: string },
      context: GraphQLContext
    ) => {
      const user = requireProviderAuth(context);
      await removeServiceImage(user.userId, args.serviceId, args.imageUrl);
      return {
        success: true,
        message: 'Service image removed successfully',
      };
    },

    /**
     * Upload provider documents
     */
    uploadProviderDocuments: async (
      _: unknown,
      args: { files: Array<{ base64Data: string; filename: string }> },
      context: GraphQLContext
    ) => {
      const user = requireProviderAuth(context);
      const urls = await uploadProviderDocuments(user.userId, args.files);
      return {
        success: true,
        urls,
        message: `${urls.length} document(s) uploaded successfully`,
      };
    },

    /**
     * Save provider documents uploaded straight to Cloudinary
     */
    addProviderDocuments: async (
      _: unknown,
      args: { documentUrls: string[] },
      context: GraphQLContext
    ) => {
      const user = requireProviderAuth(context);
      const urls = await addProviderDocuments(user.userId, args.documentUrls);
      return {
        success: true,
        urls,
        message: `${urls.length} document(s) added successfully`,
      };
    },

    /**
     * Remove provider document
     */
    removeProviderDocument: async (
      _: unknown,
      args: { documentUrl: string },
      context: GraphQLContext
    ) => {
      const user = requireProviderAuth(context);
      await removeProviderDocument(user.userId, args.documentUrl);
      return {
        success: true,
        message: 'Document removed successfully',
      };
    },

    // ==================
    // Messaging Mutations
    // ==================

    /**
     * Start a new conversation or get existing
     */
    startConversation: async (
      _: unknown,
      args: {
        input: {
          participantId: string;
          subject?: string;
          bookingId?: string;
          initialMessage?: string;
        };
      },
      context: GraphQLContext
    ) => {
      const user = requireAuth(context);
      return createOrGetConversation(user.userId, user.role, args.input);
    },

    /**
     * Send a message
     */
    sendMessage: async (
      _: unknown,
      args: {
        input: {
          conversationId: string;
          content: string;
          attachments?: string[];
          replyToId?: string;
        };
      },
      context: GraphQLContext
    ) => {
      const user = requireAuth(context);
      return sendMessage(user.userId, user.role, args.input);
    },

    /**
     * Mark messages as read
     */
    markMessagesAsRead: async (
      _: unknown,
      args: { conversationId: string; messageIds?: string[] },
      context: GraphQLContext
    ) => {
      const user = requireAuth(context);
      return markMessagesAsRead(user.userId, args.conversationId, args.messageIds);
    },

    /**
     * Archive a conversation for the signed-in user only
     */
    archiveConversation: async (
      _: unknown,
      args: { conversationId: string },
      context: GraphQLContext
    ) => {
      const user = requireAuth(context);
      return archiveConversation(user.userId, args.conversationId);
    },

    /**
     * Bring a conversation the signed-in user archived back into their inbox
     */
    unarchiveConversation: async (
      _: unknown,
      args: { conversationId: string },
      context: GraphQLContext
    ) => {
      const user = requireAuth(context);
      return unarchiveConversation(user.userId, args.conversationId);
    },

    /**
     * Delete a message
     */
    deleteMessage: async (
      _: unknown,
      args: { messageId: string },
      context: GraphQLContext
    ) => {
      const user = requireAuth(context);
      return deleteMessage(user.userId, args.messageId);
    },

    /**
     * Start support chat with admin
     */
    startSupportChat: async (
      _: unknown,
      args: { input: { subject: string; initialMessage: string } },
      context: GraphQLContext
    ) => {
      const user = requireAuth(context);
      return startSupportConversation(
        user.userId,
        user.role,
        args.input.subject,
        args.input.initialMessage
      );
    },

    // ==================
    // Safety Mutations
    // ==================

    /**
     * Block a user
     */
    blockUser: async (
      _: unknown,
      args: { userId: string; reason?: string | null },
      context: GraphQLContext
    ) => {
      const user = requireAuth(context);
      return blockUser(user.userId, args.userId, args.reason);
    },

    /**
     * Unblock a user
     */
    unblockUser: async (
      _: unknown,
      args: { userId: string },
      context: GraphQLContext
    ) => {
      const user = requireAuth(context);
      return unblockUser(user.userId, args.userId);
    },

    /**
     * Report a user or their content
     */
    createReport: async (
      _: unknown,
      args: {
        input: {
          targetType: ReportTargetType;
          targetId: string;
          reason: ReportReason;
          details?: string | null;
        };
      },
      context: GraphQLContext
    ) => {
      const user = requireAuth(context);
      return createReport(user.userId, args.input);
    },

    /**
     * Accept the current community terms
     */
    acceptTerms: async (
      _: unknown,
      args: { version: string },
      context: GraphQLContext
    ) => {
      const user = requireAuth(context);
      return acceptTerms(user.userId, args.version);
    },

    /**
     * Decide a report (Admin)
     */
    resolveReport: async (
      _: unknown,
      args: {
        id: string;
        input: { action: ModerationAction; notes: string; durationDays?: number | null };
      },
      context: GraphQLContext
    ) => {
      const admin = requireAdminAuth(context);
      return resolveReport(args.id, { id: admin.userId, role: admin.role }, args.input);
    },

    // ==================
    // Notification Mutations
    // ==================

    /**
     * Mark notification as read
     */
    markNotificationAsRead: async (
      _: unknown,
      args: { notificationId: string },
      context: GraphQLContext
    ) => {
      const user = requireAuth(context);
      return markNotificationAsRead(user.userId, args.notificationId);
    },

    /**
     * Mark all notifications as read
     */
    markAllNotificationsAsRead: async (
      _: unknown,
      __: unknown,
      context: GraphQLContext
    ) => {
      const user = requireAuth(context);
      return markAllNotificationsAsRead(user.userId);
    },

    /**
     * Delete a notification
     */
    deleteNotification: async (
      _: unknown,
      args: { notificationId: string },
      context: GraphQLContext
    ) => {
      const user = requireAuth(context);
      return deleteNotification(user.userId, args.notificationId);
    },

    /**
     * Delete all read notifications
     */
    deleteReadNotifications: async (
      _: unknown,
      __: unknown,
      context: GraphQLContext
    ) => {
      const user = requireAuth(context);
      return deleteReadNotifications(user.userId);
    },

    /**
     * Send system announcement (Admin only). The same role rules, checks and
     * shared daily cap as the broadcast mutations.
     */
    sendSystemAnnouncement: async (
      _: unknown,
      args: { input: { title: string; message: string; targetRoles?: string[] | null } },
      context: GraphQLContext
    ) => {
      const admin = requireAdminAuth(context);
      await sendAdminAnnouncement(admin.userId, admin.role, args.input);
      return {
        success: true,
        message: 'Announcement sent successfully',
      };
    },

    // ==================
    // Push Notifications
    // ==================

    /**
     * Register push token for notifications
     */
    registerPushToken: async (
      _: unknown,
      args: { playerId: string },
      context: GraphQLContext
    ) => {
      const user = requireAuth(context);
      return registerPushToken(user.userId, args.playerId);
    },

    /**
     * Unregister push token: one device with playerId, otherwise every device
     */
    unregisterPushToken: async (
      _: unknown,
      args: { playerId?: string | null },
      context: GraphQLContext
    ) => {
      const user = requireAuth(context);
      return unregisterPushToken(user.userId, args.playerId);
    },

    /**
     * Update push notification settings
     */
    updatePushPreference: async (
      _: unknown,
      args: { enabled: boolean },
      context: GraphQLContext
    ) => {
      const user = requireAuth(context);
      return updatePushPreference(user.userId, args.enabled);
    },

    // ==================
    // Push Controls (convenience wrappers)
    // ==================

    /**
     * Enable push notifications — registers the device player ID
     */
    enablePushNotifications: async (
      _: unknown,
      args: { playerId: string },
      context: GraphQLContext
    ) => {
      const user = requireAuth(context);
      return enablePushNotifications(user.userId, args.playerId);
    },

    /**
     * Disable push notifications — removes device token
     */
    disablePushNotifications: async (
      _: unknown,
      __: unknown,
      context: GraphQLContext
    ) => {
      const user = requireAuth(context);
      return disablePushNotifications(user.userId);
    },

    /**
     * Toggle push on/off without touching the registered device
     */
    togglePushNotifications: async (
      _: unknown,
      args: { enabled: boolean },
      context: GraphQLContext
    ) => {
      const user = requireAuth(context);
      return togglePushNotifications(user.userId, args.enabled);
    },

    // ==================
    // Settings Mutations
    // ==================

    /**
     * Update account settings
     */
    updateMySettings: async (
      _: unknown,
      args: { input: any },
      context: GraphQLContext
    ) => {
      const user = requireAuth(context);
      return updateMySettings(user.userId, args.input);
    },

    /**
     * Reset all settings to defaults
     */
    resetMySettings: async (
      _: unknown,
      __: unknown,
      context: GraphQLContext
    ) => {
      const user = requireAuth(context);
      return resetMySettings(user.userId);
    },

    /**
     * Deactivate own account (soft-disable)
     */
    deactivateMyAccount: async (
      _: unknown,
      args: { reason?: string },
      context: GraphQLContext
    ) => {
      const user = requireAuth(context);
      return deactivateMyAccount(user.userId, args.reason);
    },

    /**
     * Reactivate a deactivated account
     */
    reactivateMyAccount: async (
      _: unknown,
      __: unknown,
      context: GraphQLContext
    ) => {
      const user = requireAuth(context);
      return reactivateMyAccount(user.userId);
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
    adminLogout: async (
      _: unknown,
      args: { refreshToken?: string | null },
      context: GraphQLContext
    ) => {
      const admin = requireAdminAuth(context);
      return adminLogout(args.refreshToken, {
        payload: admin,
        accessToken: getBearerToken(context.request),
      });
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
          phone?: string;
          profilePhoto?: string;
        };
      },
      context: GraphQLContext
    ) => {
      const admin = requireAdminAuth(context);
      return updateAdminProfile(admin.userId, args.input);
    },

    /**
     * Admin: Request email change — sends OTP to the new email
     */
    adminRequestEmailChange: async (
      _: unknown,
      args: { input: { newEmail: string } },
      context: GraphQLContext
    ) => {
      const admin = requireAdminAuth(context);
      return adminRequestEmailChange(admin.userId, args.input.newEmail);
    },

    /**
     * Admin: Confirm email change — verifies OTP and commits the new email
     */
    adminConfirmEmailChange: async (
      _: unknown,
      args: { input: { otp: string } },
      context: GraphQLContext
    ) => {
      const admin = requireAdminAuth(context);
      return adminConfirmEmailChange(admin.userId, args.input.otp);
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
      const clientIp = context.request ? getClientIp(context.request) : undefined;
      return createAdmin(args.input, admin.userId, admin.role, clientIp);
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
      const clientIp = context.request ? getClientIp(context.request) : undefined;
      return suspendAdmin(args.adminId, args.reason, admin.userId, admin.role, clientIp);
    },

    /**
     * Activate admin
     */
    activateAdmin: async (
      _: unknown,
      args: { adminId: string },
      context: GraphQLContext
    ) => {
      const admin = requireRole(context, UserRole.SUPER_ADMIN);
      const clientIp = context.request ? getClientIp(context.request) : undefined;
      return activateAdmin(args.adminId, admin.userId, admin.role, clientIp);
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
      const clientIp = context.request ? getClientIp(context.request) : undefined;
      return updateAdminRole(args.adminId, args.role, admin.userId, admin.role, clientIp);
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
      const clientIp = context.request ? getClientIp(context.request) : undefined;
      return deleteAdmin(args.adminId, admin.userId, admin.role, clientIp);
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
      const admin = requireRole(context, UserRole.ADMIN);
      const clientIp = context.request ? getClientIp(context.request) : undefined;
      return suspendUser(args.userId, args.reason, admin.userId, admin.role, clientIp);
    },

    /**
     * Activate user
     */
    activateUser: async (
      _: unknown,
      args: { userId: string },
      context: GraphQLContext
    ) => {
      const admin = requireRole(context, UserRole.ADMIN);
      const clientIp = context.request ? getClientIp(context.request) : undefined;
      return activateUser(args.userId, admin.userId, admin.role, clientIp);
    },

    /**
     * Delete user (Admin)
     */
    deleteUser: async (
      _: unknown,
      args: { id: string },
      context: GraphQLContext
    ) => {
      const admin = requireRole(context, UserRole.ADMIN);
      const clientIp = context.request ? getClientIp(context.request) : undefined;
      return deleteUser(args.id, admin.userId, admin.role, clientIp);
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
      const admin = requireRole(context, UserRole.ADMIN);
      return approveProvider(args.providerId, moderationActor(admin, context));
    },

    /**
     * Reject provider
     */
    rejectProvider: async (
      _: unknown,
      args: { providerId: string; reason: string },
      context: GraphQLContext
    ) => {
      const admin = requireRole(context, UserRole.ADMIN);
      return rejectProvider(args.providerId, args.reason, moderationActor(admin, context));
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
      const admin = requireRole(context, UserRole.ADMIN);
      return approveService(args.serviceId, moderationActor(admin, context));
    },

    /**
     * Reject service
     */
    rejectService: async (
      _: unknown,
      args: { serviceId: string; reason: string },
      context: GraphQLContext
    ) => {
      const admin = requireRole(context, UserRole.ADMIN);
      return rejectService(args.serviceId, args.reason, moderationActor(admin, context));
    },

    /**
     * Suspend service
     */
    suspendService: async (
      _: unknown,
      args: { serviceId: string; reason: string },
      context: GraphQLContext
    ) => {
      const admin = requireRole(context, UserRole.ADMIN);
      return suspendService(args.serviceId, args.reason, moderationActor(admin, context));
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
    // The customer's email and phone go only to the customer and admins; the
    // booking's provider sees their name and photo
    user: (
      parent: {
        user?: { id: string; email?: string | null; phone?: string | null; lastLoginAt?: Date | string | null } | null;
      },
      _: unknown,
      context: GraphQLContext
    ) => {
      const customer = parent.user;
      if (!customer) return customer;
      const viewer = context.user;
      const isAdmin = viewer?.role === UserRole.ADMIN || viewer?.role === UserRole.SUPER_ADMIN;
      if (isAdmin || viewer?.userId === customer.id) return customer;
      return { ...customer, email: '', phone: null, lastLoginAt: null };
    },
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
   * Withdrawal field resolvers
   */
  Withdrawal: {
    // Admin lists load it with the withdrawal. Everywhere else the caller is
    // the withdrawal's own provider or a super admin, so it's looked up.
    provider: (parent: { providerId?: string | null; provider?: WithdrawalProviderSummary | null }) => {
      if (parent.provider !== undefined) return parent.provider;
      return parent.providerId ? getWithdrawalProviderSummary(parent.providerId) : null;
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
    // Reviews reach this type from several services, so moderation is applied here
    isHidden: (parent: ModeratedReview) => Boolean(parent.isHidden),
    comment: (parent: ModeratedReview) => (parent.isHidden ? null : parent.comment),
    response: (parent: ModeratedReview) => (parent.isHidden ? null : parent.response),
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
   * Favourite field resolvers
   */
  Favourite: {
    service: (parent: any) => parent.service,
    createdAt: (parent: any) => {
      if (parent.createdAt instanceof Date) {
        return parent.createdAt.toISOString();
      }
      return parent.createdAt;
    },
  },

  /**
   * Dispute field resolvers
   */
  Dispute: {
    booking: (parent: any) => parent.booking,
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
    resolvedAt: (parent: any) => {
      if (parent.resolvedAt instanceof Date) {
        return parent.resolvedAt.toISOString();
      }
      return parent.resolvedAt || null;
    },
    // Which admin took the dispute is shown to admins only
    reviewedBy: (parent: { reviewedBy?: string | null }, _: unknown, context: GraphQLContext) => {
      const role = context.user?.role;
      const isAdmin = role === UserRole.ADMIN || role === UserRole.SUPER_ADMIN;
      return isAdmin ? parent.reviewedBy ?? null : null;
    },
  },

  /**
   * Messages reach this type from several services. Ones saved before
   * moderation existed have no isHidden.
   */
  Message: {
    isHidden: (parent: { isHidden?: boolean | null }) => parent.isHidden ?? false,
  },

  /**
   * Users reach this type from many services. Accounts that never switched role
   * have no stored activeRole, and older records have no pushEnabled.
   */
  User: {
    activeRole: (parent: { role: string; activeRole?: string | null }) => parent.activeRole ?? parent.role,
    pushEnabled: (parent: { pushEnabled?: boolean | null }) => parent.pushEnabled ?? true,
  },

  /**
   * Provider verification documents (ID, CAC) are private: only the provider
   * and admins receive them. Everyone else gets an empty list. Private files
   * come back as download links that expire; older public URLs are unchanged.
   */
  ServiceProviderProfile: {
    images: (parent: { images?: string[] | null }) => parent.images ?? [],
    documents: (
      parent: { userId?: string; documents?: string[] },
      _: unknown,
      context: GraphQLContext
    ) => {
      const viewer = context.user;
      if (!viewer) return [];
      const isAdmin = viewer.role === UserRole.ADMIN || viewer.role === UserRole.SUPER_ADMIN;
      const isOwner = Boolean(parent.userId) && parent.userId === viewer.userId;
      return isAdmin || isOwner ? (parent.documents ?? []).map((url) => getDocumentViewUrl(url)) : [];
    },
    rejectionReason: (
      parent: { userId?: string; rejectionReason?: string | null },
      _: unknown,
      context: GraphQLContext
    ) => (isProviderOrAdmin(parent.userId, context) ? parent.rejectionReason ?? null : null),
  },

  /**
   * Why an admin rejected or suspended a service is only returned to its
   * provider and admins
   */
  Service: {
    rejectionReason: (
      parent: { provider?: { userId?: string } | null; rejectionReason?: string | null },
      _: unknown,
      context: GraphQLContext
    ) => (isProviderOrAdmin(parent.provider?.userId, context) ? parent.rejectionReason ?? null : null),
    suspensionReason: (
      parent: { provider?: { userId?: string } | null; suspensionReason?: string | null },
      _: unknown,
      context: GraphQLContext
    ) => (isProviderOrAdmin(parent.provider?.userId, context) ? parent.suspensionReason ?? null : null),
  },

  /**
   * Reviews are public; the reviewer's email is only returned to the reviewer
   * and admins.
   */
  ReviewUser: {
    email: (
      parent: { id: string; email?: string | null },
      _: unknown,
      context: GraphQLContext
    ) => {
      const viewer = context.user;
      if (!viewer) return null;
      const isAdmin = viewer.role === UserRole.ADMIN || viewer.role === UserRole.SUPER_ADMIN;
      return isAdmin || viewer.userId === parent.id ? parent.email ?? null : null;
    },
  },
};
