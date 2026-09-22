/**
 * Push Notification Service (OneSignal)
 * Handles sending push notifications to mobile devices
 *
 * - An account can have several devices (up to MAX_DEVICES_PER_USER), and
 *   pushes go to all of them. oneSignalPlayerId is the most recent device, set
 *   whenever the account has one; oneSignalPlayerIds lists them all.
 * - pushEnabled is the account's push switch. Switching it off with
 *   updatePushPreference records pushOptedOutAt, and registering a device
 *   afterwards leaves push off.
 * - Every push to a user is checked against their per-category notification
 *   settings (notifyMessages, notifyBookingUpdates, ...), by the notification
 *   type it's for. In-app notifications are created whatever the settings.
 * - A push sent for an in-app notification marks it isPushed / pushedAt.
 *
 * OneSignal API Documentation: https://documentation.onesignal.com/reference
 */

import { GraphQLError } from 'graphql';
import prisma from '@/lib/prisma';
import { config } from '@/config';
import { NotificationType } from '@/constants';

// ==================
// Types
// ==================

export interface SendPushOptions {
  title: string;
  message: string;
  data?: Record<string, any>;
  url?: string;
  buttons?: Array<{ id: string; text: string; url?: string }>;
  // iOS-specific options
  ios?: {
    badgeType?: 'None' | 'SetTo' | 'Increase';
    badgeCount?: number;
    sound?: string;
    category?: string;
    contentAvailable?: boolean; // For silent/background push
    mutableContent?: boolean; // For notification service extensions
    threadId?: string; // For grouping notifications
    targetContentId?: string; // For notification content extensions
  };
  // Android-specific options
  android?: {
    channelId?: string;
    smallIcon?: string;
    largeIcon?: string;
    priority?: number; // 1-10
    sound?: string;
    ledColor?: string;
    accentColor?: string;
    visibility?: 0 | 1 | -1; // 0=Private, 1=Public, -1=Secret
    groupKey?: string;
    groupMessage?: string;
  };
  // Common options
  ttl?: number; // Time to live in seconds
  priority?: 'normal' | 'high';
  collapseId?: string; // For replacing notifications
  /**
   * The notification type this push is for, checked against the user's
   * notification settings. Defaults to data.type.
   */
  notificationType?: string;
  /** sendPushToUser: the in-app notification this push is for, marked as pushed once sent */
  notificationId?: string;
  /** sendPushToUsers: each recipient's in-app notification ID, by user ID */
  notificationIds?: Record<string, string>;
}

interface PushResult {
  success: boolean;
  messageId?: string;
  errors?: string[];
  /** Nothing failed, but none of the users had a device OneSignal could reach */
  noRecipients?: boolean;
}

/** Links a push to the in-app notification created for the same event */
export interface PushLinkOptions {
  /** The in-app notification this push is for; marked as pushed once sent */
  notificationId?: string;
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

// ==================
// Notification Preferences
// ==================

/**
 * The groups of notifications users can switch off in their settings
 */
export type NotificationCategory =
  | 'messages'
  | 'bookingUpdates'
  | 'reviews'
  | 'disputeUpdates'
  | 'providerVerification';

export type NotificationChannel = 'push' | 'email';

// Notification types, and the type values push data uses, by category. Types
// not listed (payments, refunds, account status, SERVICE_SUSPENDED and system
// announcements) can't be switched off.
const CATEGORY_TYPES: Record<NotificationCategory, string[]> = {
  messages: [NotificationType.NEW_MESSAGE, 'MESSAGE'],
  bookingUpdates: [
    'BOOKING',
    NotificationType.BOOKING_CREATED,
    NotificationType.BOOKING_ACCEPTED,
    NotificationType.BOOKING_REJECTED,
    NotificationType.BOOKING_CANCELLED,
    NotificationType.BOOKING_STARTED,
    NotificationType.BOOKING_COMPLETED,
  ],
  reviews: ['REVIEW', NotificationType.REVIEW_RECEIVED, NotificationType.REVIEW_RESPONSE],
  disputeUpdates: [
    'DISPUTE',
    NotificationType.DISPUTE_OPENED,
    NotificationType.DISPUTE_UPDATED,
    NotificationType.DISPUTE_RESOLVED,
  ],
  providerVerification: [
    'VERIFICATION',
    NotificationType.VERIFICATION_APPROVED,
    NotificationType.VERIFICATION_REJECTED,
    NotificationType.SERVICE_APPROVED,
    NotificationType.SERVICE_REJECTED,
  ],
};

// What an account without a settings record gets (the UserSettings defaults)
const DEFAULT_PREFERENCES = {
  notifyMessages: true,
  notifyBookingUpdates: true,
  notifyReviews: true,
  notifyDisputeUpdates: true,
  notifyProviderVerification: true,
  emailMessages: false,
  emailBookingUpdates: true,
  emailReviews: true,
};

type PreferenceKey = keyof typeof DEFAULT_PREFERENCES;

export type NotificationPreferences = Partial<Record<PreferenceKey, boolean | null>>;

// The setting for each category and channel. Categories without an email
// setting always get email.
const SETTING_BY_CATEGORY: Record<
  NotificationCategory,
  Partial<Record<NotificationChannel, PreferenceKey>>
> = {
  messages: { push: 'notifyMessages', email: 'emailMessages' },
  bookingUpdates: { push: 'notifyBookingUpdates', email: 'emailBookingUpdates' },
  reviews: { push: 'notifyReviews', email: 'emailReviews' },
  disputeUpdates: { push: 'notifyDisputeUpdates' },
  providerVerification: { push: 'notifyProviderVerification' },
};

const PREFERENCES_SELECT = {
  notifyMessages: true,
  notifyBookingUpdates: true,
  notifyReviews: true,
  notifyDisputeUpdates: true,
  notifyProviderVerification: true,
  emailMessages: true,
  emailBookingUpdates: true,
  emailReviews: true,
} as const;

/**
 * The settings category a notification type belongs to, or null when users
 * can't switch it off
 */
export const notificationCategoryFor = (type?: string | null): NotificationCategory | null => {
  if (!type) return null;
  const match = (Object.keys(CATEGORY_TYPES) as NotificationCategory[]).find((category) =>
    CATEGORY_TYPES[category].includes(type)
  );
  return match ?? null;
};

/**
 * Whether a user's settings allow a notification of this type on this channel
 */
export const isNotificationAllowed = (
  preferences: NotificationPreferences | null | undefined,
  type: string | null | undefined,
  channel: NotificationChannel = 'push'
): boolean => {
  const category = notificationCategoryFor(type);
  if (!category) return true;

  const key = SETTING_BY_CATEGORY[category][channel];
  if (!key) return true;

  return preferences?.[key] ?? DEFAULT_PREFERENCES[key];
};

/**
 * Whether to send a user a push or email of this notification type, by their
 * settings. For senders outside this service, such as emails.
 */
export const shouldNotifyUser = async (
  userId: string,
  type: string,
  channel: NotificationChannel = 'push'
): Promise<boolean> => {
  if (!notificationCategoryFor(type)) return true;

  const settings = await prisma.userSettings.findUnique({
    where: { userId },
    select: PREFERENCES_SELECT,
  });

  return isNotificationAllowed(settings, type, channel);
};

/**
 * The notification type a push is for: notificationType, otherwise data.type.
 * Service decision pushes share the type SERVICE, so their action (or status)
 * says which decision it was; only approvals and rejections can be switched off.
 */
const pushTypeOf = (options: SendPushOptions): string | undefined => {
  if (options.notificationType) return options.notificationType;

  const data = options.data ?? {};
  if (typeof data.type !== 'string') return undefined;

  if (data.type === 'SERVICE') {
    const decision = data.action ?? data.status;
    if (decision === 'approved') return NotificationType.SERVICE_APPROVED;
    if (decision === 'rejected') return NotificationType.SERVICE_REJECTED;
    return NotificationType.SERVICE_SUSPENDED;
  }

  return data.type;
};

// ==================
// Devices
// ==================

// Devices kept per account; registering another drops the oldest
export const MAX_DEVICES_PER_USER = 10;

const DEVICE_SELECT = { oneSignalPlayerId: true, oneSignalPlayerIds: true } as const;

type DeviceFields = { oneSignalPlayerId?: string | null; oneSignalPlayerIds?: string[] | null };

/**
 * Every device registered on an account, oldest first. Accounts registered
 * before several devices were supported only have oneSignalPlayerId.
 */
const devicesOf = (user: DeviceFields | null | undefined): string[] => {
  if (!user) return [];
  const devices = [...(user.oneSignalPlayerIds ?? [])];
  if (user.oneSignalPlayerId && !devices.includes(user.oneSignalPlayerId)) {
    devices.push(user.oneSignalPlayerId);
  }
  return devices;
};

/**
 * The device fields once some devices are removed. oneSignalPlayerId stays the
 * most recent device left, so it's set whenever the account has one.
 */
const deviceFieldsWithout = (user: DeviceFields | null | undefined, removed: string[]) => {
  const remaining = devicesOf(user).filter((id) => !removed.includes(id));
  return {
    oneSignalPlayerId: remaining[remaining.length - 1] ?? null,
    oneSignalPlayerIds: remaining,
  };
};

/**
 * Record on in-app notifications that their push went out. Best effort: the
 * push has already been sent.
 */
const markNotificationsPushed = async (notificationIds: string[]) => {
  if (notificationIds.length === 0) return;

  try {
    await prisma.notification.updateMany({
      where: { id: { in: notificationIds } },
      data: { isPushed: true, pushedAt: new Date() },
    });
  } catch (error) {
    console.error('Failed to record push delivery on notifications:', error);
  }
};

// ==================
// OneSignal API Helper
// ==================

// Note: Server-side supports iOS-specific payload fields (content_available, ios_badgeCount, ios_sound, etc.).
// To deliver iOS push to real devices via APNs, you must upload an APNs authentication key/certificate
// to OneSignal (or configure your OneSignal app with the iOS credentials). This requires an Apple
// Developer account (generate .p8 key, Key ID, Team ID) and is performed in the OneSignal dashboard.
// Until those credentials are provided, the server can still build and queue iOS-ready payloads.

const LEGACY_API_URL = 'https://onesignal.com/api/v1';
const API_URL = 'https://api.onesignal.com';
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * App API keys (`os_v2_app_…`) only work against api.onesignal.com with the
 * `Key` auth scheme and the current targeting fields. Legacy REST API keys
 * keep using `Basic` on the v1 URL.
 */
const usesAppApiKey = (restApiKey: string) => restApiKey.startsWith('os_v2_');

const getBaseUrl = (restApiKey: string, apiUrl?: string) => {
  if (!usesAppApiKey(restApiKey)) return apiUrl || LEGACY_API_URL;
  if (!apiUrl || apiUrl.startsWith(LEGACY_API_URL)) return API_URL;
  return apiUrl.replace(/\/+$/, '');
};

/**
 * Translate legacy targeting fields to the current API. Player IDs are
 * subscription IDs in OneSignal's current user model.
 */
const toCurrentApiBody = (body: Record<string, unknown>): Record<string, unknown> => {
  const { include_player_ids, include_external_user_ids, channel_for_external_user_ids, ...rest } = body;
  if (include_player_ids) rest.include_subscription_ids = include_player_ids;
  if (include_external_user_ids) {
    rest.include_aliases = { external_id: include_external_user_ids };
    rest.target_channel = channel_for_external_user_ids ?? 'push';
  }
  return rest;
};

const describeErrors = (errors: unknown): string => {
  if (Array.isArray(errors)) {
    return errors.map((e) => (typeof e === 'string' ? e : JSON.stringify(e))).join('; ');
  }
  return errors ? JSON.stringify(errors) : '';
};

/**
 * OneSignal accepted the notification but had no subscribed device to send it
 * to (HTTP 200 with an empty id, e.g. "All included players are not
 * subscribed"). Not a fault: the users simply have no reachable device.
 */
export class NoPushRecipientsError extends Error {}

/**
 * Address a notification to users by their EasyKonnet user id. The app links
 * every device to the signed-in user with OneSignal.login(userId), so
 * OneSignal delivers to the devices each user has now, in the configured app.
 * Stored device ids can belong to an earlier OneSignal app or an old install.
 */
const targetUsers = <T extends object>(payload: T, userIds: string[]) =>
  Object.assign(payload, { include_external_user_ids: userIds, channel_for_external_user_ids: 'push' });

/**
 * The result for a push that didn't go out
 */
const failedPush = (error: unknown): PushResult =>
  error instanceof NoPushRecipientsError
    ? { success: false, noRecipients: true, errors: [error.message] }
    : { success: false, errors: [errorMessage(error)] };

/**
 * Make a request to OneSignal API
 */
const oneSignalRequest = async (
  endpoint: string,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  body?: Record<string, any>
): Promise<any> => {
  const { appId, restApiKey, apiUrl } = config.oneSignal;

  if (!appId || !restApiKey) {
    console.warn('⚠️ OneSignal not configured - push notifications disabled');
    return null;
  }

  const appApiKey = usesAppApiKey(restApiKey);

  // The legacy device endpoint doesn't accept App API keys; the mobile SDK
  // links the device to the user itself via OneSignal.login(userId).
  if (appApiKey && endpoint.startsWith('/players')) {
    return null;
  }

  const response = await fetch(`${getBaseUrl(restApiKey, apiUrl)}${endpoint}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `${appApiKey ? 'Key' : 'Basic'} ${restApiKey}`,
    },
    body: body ? JSON.stringify(appApiKey ? toCurrentApiBody(body) : body) : undefined,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  // Node's fetch types `json()` as `unknown`. OneSignal returns `{ errors }` on
  // failure, and also on HTTP 200 when no recipient could be targeted (`id` empty).
  const data = (await response
    .json()
    .catch(() => ({ errors: ['Unknown error'] }))) as { id?: string; errors?: unknown };

  if (!response.ok) {
    console.error(`❌ OneSignal API error (HTTP ${response.status}):`, data);
    throw new Error(
      describeErrors(data.errors) || `OneSignal API request failed (HTTP ${response.status})`
    );
  }

  if (endpoint === '/notifications' && !data.id) {
    throw new NoPushRecipientsError(describeErrors(data.errors) || 'No subscribed devices');
  }

  return data;
};

// ==================
// Player ID Management
// ==================

/**
 * Register a OneSignal Player ID for a user
 * Called when user logs in or enables push notifications.
 *
 * Adds the device to the account, keeping its other devices, and removes it
 * from any other account. Push is switched on, unless the user switched it off
 * themselves with updatePushPreference; `enable` switches it on regardless.
 */
export const registerPushToken = async (
  userId: string,
  playerId: string,
  options: { enable?: boolean } = {}
) => {
  const deviceId = typeof playerId === 'string' ? playerId.trim() : '';

  if (!deviceId) {
    throw new GraphQLError('Player ID is required', {
      extensions: { code: 'VALIDATION_ERROR' },
    });
  }

  // A device belongs to one account at a time
  const previousOwners = await prisma.user.findMany({
    where: {
      id: { not: userId },
      OR: [{ oneSignalPlayerId: deviceId }, { oneSignalPlayerIds: { has: deviceId } }],
    },
    select: { id: true, ...DEVICE_SELECT },
  });

  for (const owner of previousOwners) {
    await prisma.user.update({
      where: { id: owner.id },
      data: deviceFieldsWithout(owner, [deviceId]),
    });
  }

  const current = await prisma.user.findUnique({
    where: { id: userId },
    select: { ...DEVICE_SELECT, pushEnabled: true, pushOptedOutAt: true },
  });

  if (!current) {
    throw new GraphQLError('User not found', {
      extensions: { code: 'NOT_FOUND' },
    });
  }

  // This device becomes the most recent; the oldest drop off past the limit
  const devices = [...devicesOf(current).filter((id) => id !== deviceId), deviceId].slice(
    -MAX_DEVICES_PER_USER
  );
  const pushEnabled = options.enable || !current.pushOptedOutAt ? true : current.pushEnabled;

  const user = await prisma.user.update({
    where: { id: userId },
    data: {
      oneSignalPlayerId: deviceId,
      oneSignalPlayerIds: devices,
      pushEnabled,
      ...(options.enable ? { pushOptedOutAt: null } : {}),
    },
    select: {
      id: true,
      email: true,
      oneSignalPlayerId: true,
      pushEnabled: true,
    },
  });

  // Set external user ID in OneSignal (links player to your user ID)
  try {
    await setExternalUserId(deviceId, userId);
  } catch (error) {
    console.error('Failed to set external user ID in OneSignal:', error);
    // Don't fail the request - the player ID is still registered locally
  }

  return {
    success: true,
    message: user.pushEnabled
      ? 'Push notifications enabled successfully'
      : 'Device registered. Push notifications stay off until you turn them on',
    pushEnabled: user.pushEnabled,
  };
};

/**
 * Unregister push notifications for a user
 * Called when user logs out or disables push notifications.
 *
 * With a playerId, removes only that device, and push stays as it is while
 * other devices remain. Without one, removes every device and switches push
 * off; registering a device again switches it back on, unless the user
 * switched push off themselves.
 */
export const unregisterPushToken = async (userId: string, playerId?: string | null) => {
  const deviceId = typeof playerId === 'string' ? playerId.trim() : '';

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { ...DEVICE_SELECT, pushEnabled: true },
  });

  const devices = devicesOf(user);
  const removed = deviceId ? devices.filter((id) => id === deviceId) : devices;

  for (const device of removed) {
    // Remove external user ID from OneSignal
    try {
      await removeExternalUserId(device);
    } catch (error) {
      console.error('Failed to remove external user ID from OneSignal:', error);
    }
  }

  const fields = deviceFieldsWithout(user, deviceId ? [deviceId] : devices);
  const devicesLeft = fields.oneSignalPlayerIds.length > 0;

  await prisma.user.update({
    where: { id: userId },
    data: {
      ...fields,
      ...(devicesLeft ? {} : { pushEnabled: false }),
    },
  });

  if (devicesLeft) {
    return {
      success: true,
      message: 'Device unregistered',
      pushEnabled: user?.pushEnabled ?? false,
    };
  }

  return {
    success: true,
    message: 'Push notifications disabled successfully',
    pushEnabled: false,
  };
};

/**
 * Update push notification preference. Switching push off is remembered, so
 * registering a device later doesn't switch it back on.
 */
export const updatePushPreference = async (userId: string, enabled: boolean) => {
  const user = await prisma.user.update({
    where: { id: userId },
    data: { pushEnabled: enabled, pushOptedOutAt: enabled ? null : new Date() },
    select: {
      id: true,
      pushEnabled: true,
      oneSignalPlayerId: true,
    },
  });

  return {
    success: true,
    message: enabled ? 'Push notifications enabled' : 'Push notifications disabled',
    pushEnabled: user.pushEnabled,
  };
};

// ==================
// OneSignal External User ID
// ==================

/**
 * Set external user ID in OneSignal
 * Links OneSignal player to your app's user ID
 */
const setExternalUserId = async (playerId: string, userId: string) => {
  const { appId } = config.oneSignal;

  await oneSignalRequest(`/players/${playerId}`, 'PUT', {
    app_id: appId,
    external_user_id: userId,
  });
};

/**
 * Remove external user ID from OneSignal
 */
const removeExternalUserId = async (playerId: string) => {
  const { appId } = config.oneSignal;

  await oneSignalRequest(`/players/${playerId}`, 'PUT', {
    app_id: appId,
    external_user_id: '',
  });
};

// ==================
// Send Push Notifications
// ==================

/**
 * Build OneSignal notification payload with iOS and Android options
 */
const buildNotificationPayload = (
  appId: string,
  options: SendPushOptions
): Record<string, any> => {
  const payload: Record<string, any> = {
    app_id: appId,
    headings: { en: options.title },
    contents: { en: options.message },
    data: options.data,
    url: options.url,
    buttons: options.buttons,
  };

  // Common options
  if (options.ttl) {
    payload.ttl = options.ttl;
  }
  if (options.priority) {
    payload.priority = options.priority === 'high' ? 10 : 5;
  }
  if (options.collapseId) {
    payload.collapse_id = options.collapseId;
  }

  // iOS-specific options
  if (options.ios) {
    if (options.ios.badgeType) {
      payload.ios_badgeType = options.ios.badgeType;
    }
    if (options.ios.badgeCount !== undefined) {
      payload.ios_badgeCount = options.ios.badgeCount;
    }
    if (options.ios.sound) {
      payload.ios_sound = options.ios.sound;
    }
    if (options.ios.category) {
      payload.ios_category = options.ios.category;
    }
    if (options.ios.contentAvailable) {
      payload.content_available = true;
    }
    if (options.ios.mutableContent) {
      payload.mutable_content = true;
    }
    if (options.ios.threadId) {
      payload.thread_id = options.ios.threadId;
    }
    if (options.ios.targetContentId) {
      payload.target_content_id = options.ios.targetContentId;
    }
  }

  // Android-specific options
  if (options.android) {
    if (options.android.channelId) {
      payload.android_channel_id = options.android.channelId;
    }
    if (options.android.smallIcon) {
      payload.small_icon = options.android.smallIcon;
    }
    if (options.android.largeIcon) {
      payload.large_icon = options.android.largeIcon;
    }
    if (options.android.priority !== undefined) {
      payload.priority = options.android.priority;
    }
    if (options.android.sound) {
      payload.android_sound = options.android.sound;
    }
    if (options.android.ledColor) {
      payload.android_led_color = options.android.ledColor;
    }
    if (options.android.accentColor) {
      payload.android_accent_color = options.android.accentColor;
    }
    if (options.android.visibility !== undefined) {
      payload.android_visibility = options.android.visibility;
    }
    if (options.android.groupKey) {
      payload.android_group = options.android.groupKey;
    }
    if (options.android.groupMessage) {
      payload.android_group_message = { en: options.android.groupMessage };
    }
  }

  return payload;
};

/**
 * Send push notification to a single user, on all their devices, when push is
 * on and their settings allow this type of notification
 */
export const sendPushToUser = async (
  userId: string,
  options: SendPushOptions
): Promise<PushResult> => {
  const { appId } = config.oneSignal;

  if (!appId) {
    return { success: false, errors: ['OneSignal not configured'] };
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      pushEnabled: true,
      settings: { select: PREFERENCES_SELECT },
    },
  });

  if (!user) {
    return { success: false, errors: ['User not found'] };
  }

  if (!user.pushEnabled) {
    return { success: false, errors: ['User has disabled push notifications'] };
  }

  if (!isNotificationAllowed(user.settings, pushTypeOf(options))) {
    return { success: false, errors: ['User has turned off this type of notification'] };
  }

  try {
    const payload = targetUsers(buildNotificationPayload(appId, options), [userId]);

    const result = await oneSignalRequest('/notifications', 'POST', payload);
    const messageId: string | undefined = result.id;

    if (options.notificationId) {
      await markNotificationsPushed([options.notificationId]);
    }

    return {
      success: true,
      messageId,
    };
  } catch (error) {
    return failedPush(error);
  }
};

// Users per OneSignal request (OneSignal caps a request at 2,000 external ids)
const PUSH_BATCH_SIZE = 2000;

/**
 * Send push notification to multiple users, in batches, addressed by user id.
 * Users with push off or this type of notification switched off are skipped.
 * Succeeds when at least one batch reached a device; `noRecipients` when none
 * of the users had a device OneSignal could reach.
 */
export const sendPushToUsers = async (
  userIds: string[],
  options: SendPushOptions
): Promise<PushResult> => {
  const { appId } = config.oneSignal;

  if (!appId) {
    return { success: false, errors: ['OneSignal not configured'] };
  }

  const type = pushTypeOf(options);
  let targeted = 0;
  let messageId: string | undefined;
  const errors: string[] = [];
  const unreachable: string[] = [];

  for (let i = 0; i < userIds.length; i += PUSH_BATCH_SIZE) {
    const users = await prisma.user.findMany({
      where: {
        id: { in: userIds.slice(i, i + PUSH_BATCH_SIZE) },
        pushEnabled: true,
      },
      select: {
        id: true,
        settings: { select: PREFERENCES_SELECT },
      },
    });

    const batch = users
      .filter((user) => isNotificationAllowed(user.settings, type))
      .map((user) => user.id);
    if (batch.length === 0) continue;
    targeted += batch.length;

    try {
      const payload = targetUsers(buildNotificationPayload(appId, options), batch);

      const result = await oneSignalRequest('/notifications', 'POST', payload);
      if (!messageId) messageId = result?.id;

      await markNotificationsPushed(
        batch
          .map((id) => options.notificationIds?.[id])
          .filter((id): id is string => Boolean(id))
      );
    } catch (error) {
      if (error instanceof NoPushRecipientsError) unreachable.push(error.message);
      else errors.push(errorMessage(error));
    }
  }

  // Delivered to at least one device: sent, even if another batch failed
  if (messageId) {
    return errors.length > 0 ? { success: true, messageId, errors } : { success: true, messageId };
  }

  if (errors.length > 0) {
    return { success: false, errors };
  }

  return {
    success: false,
    noRecipients: true,
    errors: targeted === 0 ? ['No users with push notifications enabled'] : unreachable,
  };
};

/**
 * Send push notification using external user IDs (your app's user IDs)
 * This is useful when you don't have the player IDs cached
 */
export const sendPushByExternalIds = async (
  externalUserIds: string[],
  options: SendPushOptions
): Promise<PushResult> => {
  const { appId } = config.oneSignal;

  if (!appId) {
    return { success: false, errors: ['OneSignal not configured'] };
  }

  try {
    const payload = buildNotificationPayload(appId, options);
    payload.include_external_user_ids = externalUserIds;
    payload.channel_for_external_user_ids = 'push';

    const result = await oneSignalRequest('/notifications', 'POST', payload);

    return {
      success: true,
      messageId: result.id,
    };
  } catch (error) {
    return {
      success: false,
      errors: [errorMessage(error)],
    };
  }
};

/**
 * Send push notification to all users (broadcast)
 * Use with caution!
 */
export const sendPushToAll = async (
  options: SendPushOptions
): Promise<PushResult> => {
  const { appId } = config.oneSignal;

  if (!appId) {
    return { success: false, errors: ['OneSignal not configured'] };
  }

  try {
    const payload = buildNotificationPayload(appId, options);
    payload.included_segments = ['All'];

    const result = await oneSignalRequest('/notifications', 'POST', payload);

    return {
      success: true,
      messageId: result.id,
    };
  } catch (error) {
    return {
      success: false,
      errors: [errorMessage(error)],
    };
  }
};

/**
 * Send a silent/background push to a single user (iOS content-available)
 * Useful for background updates (requires app-side handling)
 */
export const sendSilentPushToUser = async (
  userId: string,
  data: Record<string, any> = {}
): Promise<PushResult> => {
  const { appId } = config.oneSignal;

  if (!appId) {
    return { success: false, errors: ['OneSignal not configured'] };
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { pushEnabled: true },
  });

  if (!user) {
    return { success: false, errors: ['User not found'] };
  }

  if (!user.pushEnabled) {
    return { success: false, errors: ['User has disabled push notifications'] };
  }

  try {
    const options: SendPushOptions = {
      title: '',
      message: '',
      data,
      ios: { contentAvailable: true },
    };

    const payload = targetUsers(buildNotificationPayload(appId, options), [userId]);

    const result = await oneSignalRequest('/notifications', 'POST', payload);

    return {
      success: true,
      messageId: result.id,
    };
  } catch (error) {
    return failedPush(error);
  }
};

/**
 * Send silent/background push notification (iOS content-available)
 * Used to wake up the app in background to sync data
 */
export const sendSilentPush = async (
  userId: string,
  data: Record<string, any>
): Promise<PushResult> => {
  const { appId } = config.oneSignal;

  if (!appId) {
    return { success: false, errors: ['OneSignal not configured'] };
  }

  try {
    const result = await oneSignalRequest(
      '/notifications',
      'POST',
      targetUsers(
        {
          app_id: appId,
          content_available: true, // iOS background push
          data: data,
          // No headings or contents for silent push
        },
        [userId]
      )
    );

    return {
      success: true,
      messageId: result.id,
    };
  } catch (error) {
    return failedPush(error);
  }
};

/**
 * Update iOS badge count for a user
 */
export const updateBadgeCount = async (
  userId: string,
  count: number
): Promise<PushResult> => {
  const { appId } = config.oneSignal;

  if (!appId) {
    return { success: false, errors: ['OneSignal not configured'] };
  }

  try {
    const result = await oneSignalRequest(
      '/notifications',
      'POST',
      targetUsers(
        {
          app_id: appId,
          content_available: true,
          ios_badgeType: 'SetTo',
          ios_badgeCount: count,
          // Silent notification just to update badge
        },
        [userId]
      )
    );

    return {
      success: true,
      messageId: result.id,
    };
  } catch (error) {
    return failedPush(error);
  }
};

// ==================
// Notification Type Helpers
// ==================

/**
 * Send booking notification push. Respects the user's notifyBookingUpdates setting.
 */
export const sendBookingPush = async (
  userId: string,
  type: 'new' | 'accepted' | 'rejected' | 'started' | 'completed' | 'cancelled',
  bookingId: string,
  serviceName: string,
  options: PushLinkOptions = {}
) => {
  const titles: Record<string, string> = {
    new: 'New Booking Request',
    accepted: 'Booking Accepted! 🎉',
    rejected: 'Booking Update',
    started: 'Service Started',
    completed: 'Booking Completed',
    cancelled: 'Booking Cancelled',
  };

  const messages: Record<string, string> = {
    new: `You have a new booking request for ${serviceName}`,
    accepted: `Your booking for ${serviceName} has been accepted`,
    rejected: `Your booking for ${serviceName} was not accepted`,
    started: `Your service ${serviceName} has started`,
    completed: `Your booking for ${serviceName} is complete. Leave a review!`,
    cancelled: `The booking for ${serviceName} has been cancelled`,
  };

  return sendPushToUser(userId, {
    title: titles[type],
    message: messages[type],
    data: {
      type: 'BOOKING',
      bookingId,
      action: type,
    },
    notificationId: options.notificationId,
  });
};

/**
 * Send message notification push. Respects the user's notifyMessages setting.
 */
export const sendMessagePush = async (
  userId: string,
  senderName: string,
  messagePreview: string,
  conversationId: string,
  options: PushLinkOptions = {}
) => {
  // A message with only attachments has no text to preview, and a push needs a body
  const preview = messagePreview.trim() || 'Sent an attachment';

  return sendPushToUser(userId, {
    title: `New message from ${senderName}`,
    message: preview.length > 50 ? preview.substring(0, 50) + '...' : preview,
    data: {
      type: 'MESSAGE',
      conversationId,
    },
    notificationId: options.notificationId,
  });
};

/**
 * Send review notification push. Respects the user's notifyReviews setting.
 */
export const sendReviewPush = async (
  userId: string,
  reviewerName: string,
  rating: number,
  serviceName: string,
  options: PushLinkOptions & { reviewId?: string } = {}
) => {
  return sendPushToUser(userId, {
    title: 'New Review Received ⭐',
    message: `${reviewerName} left a ${rating}-star review for ${serviceName}`,
    data: {
      type: 'REVIEW',
      ...(options.reviewId ? { reviewId: options.reviewId } : {}),
    },
    notificationType: NotificationType.REVIEW_RECEIVED,
    notificationId: options.notificationId,
  });
};

/**
 * Send a push when a provider responds to a review. Respects the user's
 * notifyReviews setting.
 */
export const sendReviewResponsePush = async (
  userId: string,
  providerName: string,
  reviewId: string,
  options: PushLinkOptions = {}
) => {
  return sendPushToUser(userId, {
    title: 'Provider Responded to Your Review',
    message: `${providerName} has responded to your review`,
    data: {
      type: 'REVIEW',
      reviewId,
      action: 'response',
    },
    notificationType: NotificationType.REVIEW_RESPONSE,
    notificationId: options.notificationId,
  });
};

/**
 * Send provider verification push. Respects the user's
 * notifyProviderVerification setting.
 */
export const sendVerificationPush = async (
  userId: string,
  status: 'approved' | 'rejected',
  reason?: string,
  options: PushLinkOptions = {}
) => {
  const title = status === 'approved'
    ? 'Verification Approved! 🎉'
    : 'Verification Update';

  const message = status === 'approved'
    ? 'Congratulations! Your provider account has been verified. You can now offer services.'
    : `Your verification was not approved. ${reason || 'Please check the app for details.'}`;

  return sendPushToUser(userId, {
    title,
    message,
    data: {
      type: 'VERIFICATION',
      status,
    },
    notificationType:
      status === 'approved'
        ? NotificationType.VERIFICATION_APPROVED
        : NotificationType.VERIFICATION_REJECTED,
    notificationId: options.notificationId,
  });
};

/**
 * Send a push about an admin's decision on a service. Approvals and
 * rejections respect the notifyProviderVerification setting; suspensions are
 * always sent.
 */
export const sendServicePush = async (
  userId: string,
  status: 'approved' | 'rejected' | 'suspended',
  serviceId: string,
  serviceName: string,
  reason?: string,
  options: PushLinkOptions = {}
) => {
  const titles = {
    approved: 'Service Approved',
    rejected: 'Service Update',
    suspended: 'Service Suspended',
  };

  const details = reason || 'Please check the app for details.';
  const messages = {
    approved: `Your service "${serviceName}" has been approved and is now live`,
    rejected: `Your service "${serviceName}" was not approved. ${details}`,
    suspended: `Your service "${serviceName}" has been suspended. ${details}`,
  };

  const types = {
    approved: NotificationType.SERVICE_APPROVED,
    rejected: NotificationType.SERVICE_REJECTED,
    suspended: NotificationType.SERVICE_SUSPENDED,
  };

  return sendPushToUser(userId, {
    title: titles[status],
    message: messages[status],
    data: {
      type: 'SERVICE',
      serviceId,
      status,
    },
    notificationType: types[status],
    notificationId: options.notificationId,
  });
};

const pushService = {
  registerPushToken,
  unregisterPushToken,
  updatePushPreference,
  sendPushToUser,
  sendPushToUsers,
  sendPushByExternalIds,
  sendPushToAll,
  // Silent/background pushes
  sendSilentPush,
  sendSilentPushToUser,
  // Badge helpers
  updateBadgeCount,
  sendBookingPush,
  sendMessagePush,
  sendReviewPush,
  sendReviewResponsePush,
  sendVerificationPush,
  sendServicePush,
  // Notification settings
  shouldNotifyUser,
  isNotificationAllowed,
  notificationCategoryFor,
};

export default pushService;
