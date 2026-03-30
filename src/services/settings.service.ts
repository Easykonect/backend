/**
 * Settings Service
 * Manages user account settings, notification preferences, and push controls
 *
 * Sections:
 * - Push notification enable/disable (dedicated mutations)
 * - Push status query
 * - In-app notification preferences (per category)
 * - Email notification preferences
 * - Locale settings (language, timezone, currency)
 * - Privacy settings
 */

import { GraphQLError } from 'graphql';
import prisma from '@/lib/prisma';
import {
  registerPushToken,
  unregisterPushToken,
  updatePushPreference,
} from '@/services/push.service';

// ==================
// Default settings shape
// ==================

const DEFAULT_SETTINGS = {
  // In-app / push preferences
  notifyBookingUpdates: true,
  notifyMessages: true,
  notifyReviews: true,
  notifyPromotions: false,
  notifyDisputeUpdates: true,
  notifyProviderVerification: true,
  // Email preferences
  emailBookingUpdates: true,
  emailMessages: false,
  emailReviews: true,
  emailPromotions: false,
  emailNewsletters: false,
  // Locale
  language: 'en',
  timezone: 'Africa/Lagos',
  currency: 'NGN',
  // Privacy
  showProfileToPublic: true,
  showPhoneToProviders: false,
} as const;

// ==================
// Helpers
// ==================

const assertUserExists = async (userId: string) => {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, pushEnabled: true, oneSignalPlayerId: true },
  });
  if (!user) {
    throw new GraphQLError('User not found', {
      extensions: { code: 'NOT_FOUND' },
    });
  }
  return user;
};

/**
 * Upsert — returns existing settings or creates defaults
 */
const upsertSettings = async (userId: string) => {
  return prisma.userSettings.upsert({
    where: { userId },
    update: {},
    create: { userId, ...DEFAULT_SETTINGS },
  });
};

// ==================
// Push Controls
// ==================

/**
 * Enable push notifications for the current device
 * Requires a OneSignal Player ID (from the mobile SDK)
 */
export const enablePushNotifications = async (
  userId: string,
  playerId: string
) => {
  await assertUserExists(userId);
  return registerPushToken(userId, playerId);
};

/**
 * Disable push notifications — removes device token and turns off push
 */
export const disablePushNotifications = async (userId: string) => {
  await assertUserExists(userId);
  return unregisterPushToken(userId);
};

/**
 * Toggle push notifications on/off without changing the registered device
 * Useful when the user already has a device registered
 */
export const togglePushNotifications = async (
  userId: string,
  enabled: boolean
) => {
  await assertUserExists(userId);
  return updatePushPreference(userId, enabled);
};

/**
 * Get current push notification status for the user
 */
export const getPushStatus = async (userId: string) => {
  const user = await assertUserExists(userId);
  return {
    pushEnabled: user.pushEnabled,
    hasDeviceRegistered: !!user.oneSignalPlayerId,
    playerId: user.oneSignalPlayerId ?? null,
  };
};

// ==================
// Settings
// ==================

/**
 * Get the authenticated user's full settings (creates defaults if none exist)
 */
export const getMySettings = async (userId: string) => {
  await assertUserExists(userId);
  const settings = await upsertSettings(userId);

  return {
    id: settings.id,
    // Push / in-app
    notifyBookingUpdates: settings.notifyBookingUpdates,
    notifyMessages: settings.notifyMessages,
    notifyReviews: settings.notifyReviews,
    notifyPromotions: settings.notifyPromotions,
    notifyDisputeUpdates: settings.notifyDisputeUpdates,
    notifyProviderVerification: settings.notifyProviderVerification,
    // Email
    emailBookingUpdates: settings.emailBookingUpdates,
    emailMessages: settings.emailMessages,
    emailReviews: settings.emailReviews,
    emailPromotions: settings.emailPromotions,
    emailNewsletters: settings.emailNewsletters,
    // Locale
    language: settings.language,
    timezone: settings.timezone,
    currency: settings.currency,
    // Privacy
    showProfileToPublic: settings.showProfileToPublic,
    showPhoneToProviders: settings.showPhoneToProviders,
    updatedAt: settings.updatedAt.toISOString(),
  };
};

/**
 * Update notification and account settings
 */
export const updateMySettings = async (
  userId: string,
  input: {
    // Push / in-app
    notifyBookingUpdates?: boolean;
    notifyMessages?: boolean;
    notifyReviews?: boolean;
    notifyPromotions?: boolean;
    notifyDisputeUpdates?: boolean;
    notifyProviderVerification?: boolean;
    // Email
    emailBookingUpdates?: boolean;
    emailMessages?: boolean;
    emailReviews?: boolean;
    emailPromotions?: boolean;
    emailNewsletters?: boolean;
    // Locale
    language?: string;
    timezone?: string;
    currency?: string;
    // Privacy
    showProfileToPublic?: boolean;
    showPhoneToProviders?: boolean;
  }
) => {
  await assertUserExists(userId);

  // Validate language if provided
  if (input.language && !/^[a-z]{2}(-[A-Z]{2})?$/.test(input.language)) {
    throw new GraphQLError('Invalid language code. Use ISO 639-1 format (e.g. "en", "fr")', {
      extensions: { code: 'VALIDATION_ERROR' },
    });
  }

  // Validate currency if provided (ISO 4217 — 3 uppercase letters)
  if (input.currency && !/^[A-Z]{3}$/.test(input.currency)) {
    throw new GraphQLError('Invalid currency code. Use ISO 4217 format (e.g. "NGN", "USD")', {
      extensions: { code: 'VALIDATION_ERROR' },
    });
  }

  // Strip undefined keys so we only update what was passed
  const data = Object.fromEntries(
    Object.entries(input).filter(([, v]) => v !== undefined)
  );

  const settings = await prisma.userSettings.upsert({
    where: { userId },
    update: data,
    create: { userId, ...DEFAULT_SETTINGS, ...data },
  });

  return {
    success: true,
    message: 'Settings updated successfully',
    settings: {
      id: settings.id,
      notifyBookingUpdates: settings.notifyBookingUpdates,
      notifyMessages: settings.notifyMessages,
      notifyReviews: settings.notifyReviews,
      notifyPromotions: settings.notifyPromotions,
      notifyDisputeUpdates: settings.notifyDisputeUpdates,
      notifyProviderVerification: settings.notifyProviderVerification,
      emailBookingUpdates: settings.emailBookingUpdates,
      emailMessages: settings.emailMessages,
      emailReviews: settings.emailReviews,
      emailPromotions: settings.emailPromotions,
      emailNewsletters: settings.emailNewsletters,
      language: settings.language,
      timezone: settings.timezone,
      currency: settings.currency,
      showProfileToPublic: settings.showProfileToPublic,
      showPhoneToProviders: settings.showPhoneToProviders,
      updatedAt: settings.updatedAt.toISOString(),
    },
  };
};

/**
 * Reset settings to defaults
 */
export const resetMySettings = async (userId: string) => {
  await assertUserExists(userId);

  const settings = await prisma.userSettings.upsert({
    where: { userId },
    update: { ...DEFAULT_SETTINGS },
    create: { userId, ...DEFAULT_SETTINGS },
  });

  return {
    success: true,
    message: 'Settings reset to defaults',
    settings: {
      id: settings.id,
      notifyBookingUpdates: settings.notifyBookingUpdates,
      notifyMessages: settings.notifyMessages,
      notifyReviews: settings.notifyReviews,
      notifyPromotions: settings.notifyPromotions,
      notifyDisputeUpdates: settings.notifyDisputeUpdates,
      notifyProviderVerification: settings.notifyProviderVerification,
      emailBookingUpdates: settings.emailBookingUpdates,
      emailMessages: settings.emailMessages,
      emailReviews: settings.emailReviews,
      emailPromotions: settings.emailPromotions,
      emailNewsletters: settings.emailNewsletters,
      language: settings.language,
      timezone: settings.timezone,
      currency: settings.currency,
      showProfileToPublic: settings.showProfileToPublic,
      showPhoneToProviders: settings.showPhoneToProviders,
      updatedAt: settings.updatedAt.toISOString(),
    },
  };
};

// ==================
// Account Controls
// ==================

/**
 * Deactivate account (soft-disable — keeps data, blocks login)
 * Different from deleteOwnAccount which purges all data
 */
export const deactivateMyAccount = async (userId: string, reason?: string) => {
  await assertUserExists(userId);

  await prisma.user.update({
    where: { id: userId },
    data: { status: 'DEACTIVATED' },
  });

  // Remove push token so no more notifications are delivered
  try {
    await unregisterPushToken(userId);
  } catch {
    // Non-critical — continue even if push cleanup fails
  }

  return {
    success: true,
    message: 'Your account has been deactivated. Contact support to reactivate.',
  };
};

/**
 * Reactivate a deactivated account (self-service)
 */
export const reactivateMyAccount = async (userId: string) => {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, status: true },
  });

  if (!user) {
    throw new GraphQLError('User not found', { extensions: { code: 'NOT_FOUND' } });
  }

  if (user.status !== 'DEACTIVATED') {
    throw new GraphQLError('Account is not deactivated', {
      extensions: { code: 'BAD_REQUEST' },
    });
  }

  await prisma.user.update({
    where: { id: userId },
    data: { status: 'ACTIVE' },
  });

  return {
    success: true,
    message: 'Your account has been reactivated.',
  };
};
