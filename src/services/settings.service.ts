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
 * - Deactivating and reactivating the account
 */

import { GraphQLError } from 'graphql';
import prisma from '@/lib/prisma';
import { validateText } from '@/utils/security';
import {
  registerPushToken,
  unregisterPushToken,
  updatePushPreference,
} from '@/services/push.service';
import { endAllSessions } from '@/services/token.service';

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

type SettingsValues = {
  -readonly [K in keyof typeof DEFAULT_SETTINGS]: (typeof DEFAULT_SETTINGS)[K] extends boolean
    ? boolean
    : string;
};

/**
 * Fields for updateMySettings. A missing or null field keeps its current value.
 */
export type UpdateSettingsInput = {
  [K in keyof SettingsValues]?: SettingsValues[K] | null;
};

const LANGUAGE_PATTERN = /^[a-z]{2}(-[A-Z]{2})?$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const TIMEZONE_PATTERN = /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/;
const MAX_TIMEZONE_LENGTH = 64;
const MAX_DEACTIVATION_REASON_LENGTH = 500;

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

const validationError = (message: string) =>
  new GraphQLError(message, { extensions: { code: 'VALIDATION_ERROR' } });

/**
 * Whether this is an IANA time zone name the server can use (payout scheduling
 * reads it)
 */
const isValidTimeZone = (timeZone: string): boolean => {
  if (timeZone.length > MAX_TIMEZONE_LENGTH || !TIMEZONE_PATTERN.test(timeZone)) {
    return false;
  }
  try {
    Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
};

type SettingsRecord = SettingsValues & { id: string; updatedAt: Date };

const formatSettings = (settings: SettingsRecord) => ({
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
});

// ==================
// Push Controls
// ==================

/**
 * Enable push notifications for the current device
 * Requires a OneSignal Player ID (from the mobile SDK). This is the user turning
 * push on, so it also undoes an earlier switch-off.
 */
export const enablePushNotifications = async (
  userId: string,
  playerId: string
) => {
  await assertUserExists(userId);
  return registerPushToken(userId, playerId, { enable: true });
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

  return formatSettings(settings);
};

/**
 * Update notification and account settings
 */
export const updateMySettings = async (userId: string, input: UpdateSettingsInput) => {
  await assertUserExists(userId);

  // Only known fields that were sent with a value; null keeps the current value
  const data = Object.fromEntries(
    Object.entries(input).filter(
      ([key, value]) => key in DEFAULT_SETTINGS && value !== undefined && value !== null
    )
  ) as Partial<SettingsValues>;

  if (data.language !== undefined && !LANGUAGE_PATTERN.test(data.language)) {
    throw validationError('Invalid language code. Use ISO 639-1 format (e.g. "en", "fr")');
  }

  if (data.timezone !== undefined && !isValidTimeZone(data.timezone)) {
    throw validationError('Invalid timezone. Use an IANA time zone name (e.g. "Africa/Lagos")');
  }

  if (data.currency !== undefined && !CURRENCY_PATTERN.test(data.currency)) {
    throw validationError('Invalid currency code. Use ISO 4217 format (e.g. "NGN", "USD")');
  }

  const settings = await prisma.userSettings.upsert({
    where: { userId },
    update: data,
    create: { userId, ...DEFAULT_SETTINGS, ...data },
  });

  return {
    success: true,
    message: 'Settings updated successfully',
    settings: formatSettings(settings),
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
    settings: formatSettings(settings),
  };
};

// ==================
// Account Controls
// ==================

/**
 * Deactivate account (soft-disable — keeps data). Every session ends, and
 * signing in again with the password reactivates the account. Different from
 * deleteOwnAccount, which removes the account's personal data.
 */
export const deactivateMyAccount = async (userId: string, reason?: string | null) => {
  const deactivationReason = reason?.trim()
    ? validateText(reason, 'Reason', 0, MAX_DEACTIVATION_REASON_LENGTH) || null
    : null;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { status: true },
  });

  if (!user) {
    throw new GraphQLError('User not found', { extensions: { code: 'NOT_FOUND' } });
  }

  // Only active accounts can deactivate. Otherwise a suspended user could
  // deactivate and then reactivate themselves.
  if (user.status !== 'ACTIVE') {
    throw new GraphQLError('Only active accounts can be deactivated', {
      extensions: { code: 'BAD_REQUEST' },
    });
  }

  const deactivatedAt = new Date();

  await prisma.user.update({
    where: { id: userId },
    data: {
      status: 'DEACTIVATED',
      deactivatedAt,
      deactivationReason,
      // Ends every session, including ones Redis can't reach right now
      tokenInvalidatedAt: deactivatedAt,
    },
  });

  // Remove push token so no more notifications are delivered
  try {
    await unregisterPushToken(userId);
  } catch {
    // Non-critical — continue even if push cleanup fails
  }

  // Revoke stored refresh tokens and reject earlier access tokens
  await endAllSessions(userId);

  return {
    success: true,
    message: 'Your account has been deactivated. Sign in again to reactivate it.',
  };
};

/**
 * Reactivate a deactivated account (self-service). Deactivation ends every
 * session, so in practice signing in (which reactivates the account) is the way
 * back; this stays for sessions that are still valid.
 */
export const reactivateMyAccount = async (userId: string) => {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, status: true, deletedAt: true },
  });

  if (!user || user.deletedAt) {
    throw new GraphQLError('User not found', { extensions: { code: 'NOT_FOUND' } });
  }

  if (user.status !== 'DEACTIVATED') {
    throw new GraphQLError('Account is not deactivated', {
      extensions: { code: 'BAD_REQUEST' },
    });
  }

  await prisma.user.update({
    where: { id: userId },
    data: { status: 'ACTIVE', deactivatedAt: null, deactivationReason: null },
  });

  return {
    success: true,
    message: 'Your account has been reactivated.',
  };
};
