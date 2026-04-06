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
  getCurrentUser,
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
  getUserById,
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
  removeProviderDocument,
  generateSignedUploadParams,
  getUploadStats,
} from '@/services/upload.service';

import {
  createOrGetConversation,
  getConversationById,
  getMyConversations,
  archiveConversation,
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
  sendSystemAnnouncement,
} from '@/services/notification.service';

import {
  registerPushToken,
  unregisterPushToken,
  updatePushPreference,
} from '@/services/push.service';

import {
  initializePayment,
  verifyPayment,
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
  getOrCreateWallet,
  getWalletTransactions,
  payWithWallet,
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
  getPendingWithdrawalsCount,
  processWithdrawal,
  rejectWithdrawal,
  retryWithdrawal,
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
} from '@/services/payment-analytics.service';

import {
  setPayoutSchedule,
  getPayoutSchedule,
  pausePayoutSchedule,
  getProviderPendingEarnings,
  getScheduledPayoutHistory,
} from '@/services/payout.service';

import {
  getAuditLogs,
  getAuditLogsForTarget,
} from '@/services/audit.service';

import { requireAuth, requireRole, requireAnyRole, type GraphQLContext } from '@/middleware';
import { UserRole, ServiceStatus, type ServiceStatusType } from '@/constants';

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

    /**
     * Get provider verification status
     */
    myVerificationStatus: async (
      _: unknown,
      __: unknown,
      context: GraphQLContext
    ) => {
      const user = requireAuth(context);
      requireRole(context, UserRole.SERVICE_PROVIDER);
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
      const user = requireRole(context, UserRole.SERVICE_PROVIDER);
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
      context: GraphQLContext
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
      context: GraphQLContext
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
      context: GraphQLContext
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
      context: GraphQLContext
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
      args: { input?: { filters?: any; sortBy?: string; pagination?: { page: number; limit: number } } }
    ) => {
      const { filters, sortBy, pagination } = args.input ?? {};
      return browseProviders({
        filters: filters ?? {},
        sortBy: (sortBy as any) ?? 'NEWEST',
        pagination: pagination ?? { page: 1, limit: 10 },
      });
    },

    /**
     * Get a provider's full public profile by ID
     */
    providerProfile: async (
      _: unknown,
      args: { providerId: string }
    ) => {
      return getProviderPublicProfile(args.providerId);
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
      }
    ) => {
      const { latitude, longitude, radiusKm, filters, sortBy, pagination } = args.input;
      return getNearbyProviders({
        latitude,
        longitude,
        radiusKm,
        filters: filters ?? {},
        sortBy: (sortBy as any) ?? 'RATING_DESC',
        pagination: pagination ?? { page: 1, limit: 10 },
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
      const user = requireRole(context, UserRole.SERVICE_PROVIDER);
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
      const user = requireRole(context, UserRole.SERVICE_PROVIDER);
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
      args: { pagination?: { page?: number; limit?: number } },
      context: GraphQLContext
    ) => {
      const user = requireAuth(context);
      return getMyConversations(user.userId, args.pagination);
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
      return getPaymentById(args.id, user.userId);
    },

    /**
     * Get payment by booking ID
     */
    paymentByBooking: async (
      _: unknown,
      args: { bookingId: string },
      context: GraphQLContext
    ) => {
      requireAuth(context);
      return getPaymentByBookingId(args.bookingId);
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
      const user = requireRole(context, UserRole.SERVICE_PROVIDER);
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
      const user = requireRole(context, UserRole.SERVICE_PROVIDER);
      return getProviderEarnings(user.userId);
    },

    /**
     * Get all payments (Admin)
     */
    allPayments: async (
      _: unknown,
      args: {
        filters?: { status?: string; startDate?: string; endDate?: string };
        pagination?: { page?: number; limit?: number };
      },
      context: GraphQLContext
    ) => {
      requireAdminAuth(context);
      return getAllPayments(
        args.filters || {},
        { page: args.pagination?.page || 1, limit: args.pagination?.limit || 10 }
      );
    },

    /**
     * Get payment statistics (Admin)
     */
    paymentStats: async (
      _: unknown,
      __: unknown,
      context: GraphQLContext
    ) => {
      requireAdminAuth(context);
      return getPaymentStats();
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
      return getWalletTransactions(
        user.userId,
        args.filters as Parameters<typeof getWalletTransactions>[1],
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
      const user = requireRole(context, UserRole.SERVICE_PROVIDER);
      const provider = await prisma.serviceProvider.findUnique({
        where: { userId: user.userId },
      });
      if (!provider) {
        throw new Error('Provider profile not found');
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
      const user = requireRole(context, UserRole.SERVICE_PROVIDER);
      const provider = await prisma.serviceProvider.findUnique({
        where: { userId: user.userId },
      });
      if (!provider) {
        throw new Error('Provider profile not found');
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
      const user = requireRole(context, UserRole.SERVICE_PROVIDER);
      const provider = await prisma.serviceProvider.findUnique({
        where: { userId: user.userId },
      });
      if (!provider) {
        throw new Error('Provider profile not found');
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
      const user = requireRole(context, UserRole.SERVICE_PROVIDER);
      const provider = await prisma.serviceProvider.findUnique({
        where: { userId: user.userId },
      });
      if (!provider) {
        throw new Error('Provider profile not found');
      }
      // Get withdrawal directly from prisma since getWithdrawalById doesn't exist
      const withdrawal = await prisma.withdrawal.findFirst({
        where: { id: args.id, providerId: provider.id },
      });
      return withdrawal;
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
      const user = requireRole(context, UserRole.SERVICE_PROVIDER);
      const provider = await prisma.serviceProvider.findUnique({
        where: { userId: user.userId },
      });
      if (!provider) {
        throw new Error('Provider profile not found');
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
      const user = requireRole(context, UserRole.SERVICE_PROVIDER);
      const provider = await prisma.serviceProvider.findUnique({
        where: { userId: user.userId },
      });
      if (!provider) {
        throw new Error('Provider profile not found');
      }
      return getProviderPendingEarnings(provider.id);
    },

    /**
     * Get scheduled payouts
     */
    myScheduledPayouts: async (
      _: unknown,
      args: { pagination?: { page?: number; limit?: number } },
      context: GraphQLContext
    ) => {
      const user = requireRole(context, UserRole.SERVICE_PROVIDER);
      const provider = await prisma.serviceProvider.findUnique({
        where: { userId: user.userId },
      });
      if (!provider) {
        throw new Error('Provider profile not found');
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
      const user = requireRole(context, UserRole.SERVICE_PROVIDER);
      const provider = await prisma.serviceProvider.findUnique({
        where: { userId: user.userId },
      });
      if (!provider) {
        throw new Error('Provider profile not found');
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
     * Get top earning providers - using payment analytics with filtering
     */
    topEarningProviders: async (
      _: unknown,
      args: { limit?: number; period?: string },
      context: GraphQLContext
    ) => {
      requireAdminAuth(context);
      // TODO: Implement getTopEarningProviders in payment-analytics.service.ts
      // For now return empty array
      return [];
    },

    /**
     * Get refund statistics
     */
    refundStats: async (
      _: unknown,
      args: { period?: string },
      context: GraphQLContext
    ) => {
      requireAdminAuth(context);
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
      const admin = requireAdminAuth(context);
      return getAuditLogsForTarget(
        admin.userId,
        args.targetId,
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
      args: { refreshToken?: string }, 
      context: GraphQLContext
    ) => {
      requireAuth(context);
      return logout(args.refreshToken);
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

    /**
     * Submit provider profile for verification
     */
    submitProviderForVerification: async (
      _: unknown,
      __: unknown,
      context: GraphQLContext
    ) => {
      const user = requireAuth(context);
      requireRole(context, UserRole.SERVICE_PROVIDER);
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
    // Payment Mutations
    // ==================

    /**
     * Initialize payment for a booking
     */
    initializePayment: async (
      _: unknown,
      args: { input: { bookingId: string; callbackUrl?: string } },
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
      requireAuth(context);
      return verifyPayment(args.transactionRef);
    },

    /**
     * Process refund (Admin only)
     */
    processRefund: async (
      _: unknown,
      args: { input: { paymentId: string; amount?: number; reason: string } },
      context: GraphQLContext
    ) => {
      const admin = requireAdminAuth(context);
      return processRefund(admin.userId, args.input);
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
      // Get the booking amount first
      const booking = await prisma.booking.findUnique({
        where: { id: args.input.bookingId },
      });
      if (!booking) {
        throw new Error('Booking not found');
      }
      return payWithWallet(user.userId, args.input.bookingId, booking.totalAmount);
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
      const user = requireRole(context, UserRole.SERVICE_PROVIDER);
      const provider = await prisma.serviceProvider.findUnique({
        where: { userId: user.userId },
      });
      if (!provider) {
        throw new Error('Provider profile not found');
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
      const user = requireRole(context, UserRole.SERVICE_PROVIDER);
      const provider = await prisma.serviceProvider.findUnique({
        where: { userId: user.userId },
      });
      if (!provider) {
        throw new Error('Provider profile not found');
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
      const user = requireRole(context, UserRole.SERVICE_PROVIDER);
      const provider = await prisma.serviceProvider.findUnique({
        where: { userId: user.userId },
      });
      if (!provider) {
        throw new Error('Provider profile not found');
      }
      await deleteBankAccount(args.id, provider.id);
      return { message: 'Bank account removed successfully' };
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
      const user = requireRole(context, UserRole.SERVICE_PROVIDER);
      const provider = await prisma.serviceProvider.findUnique({
        where: { userId: user.userId },
      });
      if (!provider) {
        throw new Error('Provider profile not found');
      }
      return requestWithdrawal(
        provider.id,
        user.userId,
        args.input
      );
    },

    /**
     * Cancel a pending withdrawal
     */
    cancelWithdrawal: async (
      _: unknown,
      args: { id: string },
      context: GraphQLContext
    ) => {
      const user = requireRole(context, UserRole.SERVICE_PROVIDER);
      const provider = await prisma.serviceProvider.findUnique({
        where: { userId: user.userId },
      });
      if (!provider) {
        throw new Error('Provider profile not found');
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
      args: { input: { frequency: string; minimumAmount?: number } },
      context: GraphQLContext
    ) => {
      const user = requireRole(context, UserRole.SERVICE_PROVIDER);
      const provider = await prisma.serviceProvider.findUnique({
        where: { userId: user.userId },
      });
      if (!provider) {
        throw new Error('Provider profile not found');
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
      const user = requireRole(context, UserRole.SERVICE_PROVIDER);
      const provider = await prisma.serviceProvider.findUnique({
        where: { userId: user.userId },
      });
      if (!provider) {
        throw new Error('Provider profile not found');
      }
      await pausePayoutSchedule(provider.id);
      return { message: 'Payout schedule disabled' };
    },

    // ==================
    // Withdrawal Mutations (Admin)
    // ==================

    /**
     * Process a pending withdrawal
     */
    processWithdrawal: async (
      _: unknown,
      args: { id: string },
      context: GraphQLContext
    ) => {
      const admin = requireAdminAuth(context);
      return processWithdrawal(args.id, admin.userId, admin.role);
    },

    /**
     * Reject a withdrawal
     */
    rejectWithdrawal: async (
      _: unknown,
      args: { id: string; reason: string },
      context: GraphQLContext
    ) => {
      const admin = requireAdminAuth(context);
      return rejectWithdrawal(args.id, admin.userId, admin.role, args.reason);
    },

    /**
     * Retry a failed withdrawal
     */
    retryWithdrawal: async (
      _: unknown,
      args: { id: string },
      context: GraphQLContext
    ) => {
      const admin = requireAdminAuth(context);
      return retryWithdrawal(args.id, admin.userId, admin.role);
    },

    // ==================
    // User Management Mutations (Admin)
    // ==================

    /**
     * Ban a user/provider
     */
    banUser: async (
      _: unknown,
      args: { input: { userId: string; reason: string; durationDays?: number } },
      context: GraphQLContext
    ) => {
      const admin = requireAdminAuth(context);
      return banUser(
        { userId: args.input.userId, reason: args.input.reason, days: args.input.durationDays },
        admin.userId,
        admin.role
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
      return unbanUser(args.userId, admin.userId, admin.role);
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
      return restrictUser(
        { userId: args.input.userId, reason: args.input.reason, days: args.input.durationDays },
        admin.userId,
        admin.role
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
      return removeRestriction(args.userId, admin.userId, admin.role);
    },

    /**
     * Adjust wallet balance (Admin)
     * SECURITY: Role-based limits enforced in service
     * - Regular Admin: max ₦100,000
     * - Super Admin: max ₦1,000,000
     */
    adjustWalletBalance: async (
      _: unknown,
      args: { userId: string; amount: number; reason: string },
      context: GraphQLContext
    ) => {
      const admin = requireAdminAuth(context);
      // Determine CREDIT or DEBIT based on amount sign
      const type = args.amount >= 0 ? 'CREDIT' : 'DEBIT';
      const amountKobo = Math.abs(args.amount * 100); // Convert to kobo
      // Pass admin role for limit enforcement
      return adjustWalletBalance(args.userId, amountKobo, type, args.reason, admin.userId, admin.role);
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
      requireRole(context, UserRole.SERVICE_PROVIDER);
      
      // Get provider ID
      const provider = await prisma.serviceProvider.findUnique({
        where: { userId: user.userId },
      });
      
      if (!provider) {
        throw new Error('Provider profile not found');
      }
      
      return respondToReview(provider.id, args.reviewId, args.response);
    },

    /**
     * Delete a review (Admin only)
     */
    deleteReview: async (
      _: unknown,
      args: { id: string },
      context: GraphQLContext
    ) => {
      requireAdminAuth(context);
      return deleteReview(args.id);
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
      return resolveDispute(args.disputeId, admin.userId, args.input);
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
      return closeDispute(args.disputeId, admin.userId, args.reason);
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
      const user = requireRole(context, UserRole.SERVICE_PROVIDER);
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
      const user = requireRole(context, UserRole.SERVICE_PROVIDER);
      await removeProviderImage(user.userId, args.imageUrl);
      return { message: 'Image removed successfully' };
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
      const user = requireRole(context, UserRole.SERVICE_PROVIDER);
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
      const user = requireRole(context, UserRole.SERVICE_PROVIDER);
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
      const user = requireRole(context, UserRole.SERVICE_PROVIDER);
      const urls = await uploadProviderDocuments(user.userId, args.files);
      return {
        success: true,
        urls,
        message: `${urls.length} document(s) uploaded successfully`,
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
      const user = requireRole(context, UserRole.SERVICE_PROVIDER);
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
     * Archive a conversation
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
     * Send system announcement (Admin only)
     */
    sendSystemAnnouncement: async (
      _: unknown,
      args: { input: { title: string; message: string; targetRoles?: string[] } },
      context: GraphQLContext
    ) => {
      requireAdminAuth(context);
      await sendSystemAnnouncement(
        args.input.title,
        args.input.message,
        args.input.targetRoles
      );
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
     * Unregister push token
     */
    unregisterPushToken: async (
      _: unknown,
      __: unknown,
      context: GraphQLContext
    ) => {
      const user = requireAuth(context);
      return unregisterPushToken(user.userId);
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
      args: { refreshToken?: string }, 
      context: GraphQLContext
    ) => {
      requireAdminAuth(context);
      if (args.refreshToken) {
        await adminLogout(args.refreshToken);
      }
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
  },
};
