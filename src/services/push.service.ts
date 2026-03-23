/**
 * Push Notification Service (OneSignal)
 * Handles sending push notifications to mobile devices
 * 
 * OneSignal API Documentation: https://documentation.onesignal.com/reference
 */

import { GraphQLError } from 'graphql';
import prisma from '@/lib/prisma';
import { config } from '@/config';

// ==================
// Types
// ==================

interface SendPushOptions {
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
}

interface PushResult {
  success: boolean;
  messageId?: string;
  errors?: string[];
}

// ==================
// OneSignal API Helper
// ==================

// Note: Server-side supports iOS-specific payload fields (content_available, ios_badgeCount, ios_sound, etc.).
// To deliver iOS push to real devices via APNs, you must upload an APNs authentication key/certificate
// to OneSignal (or configure your OneSignal app with the iOS credentials). This requires an Apple
// Developer account (generate .p8 key, Key ID, Team ID) and is performed in the OneSignal dashboard.
// Until those credentials are provided, the server can still build and queue iOS-ready payloads.

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

  const response = await fetch(`${apiUrl}${endpoint}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Basic ${restApiKey}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ errors: ['Unknown error'] }));
    console.error('❌ OneSignal API error:', error);
    throw new Error(error.errors?.[0] || 'OneSignal API request failed');
  }

  return response.json();
};

// ==================
// Player ID Management
// ==================

/**
 * Register a OneSignal Player ID for a user
 * Called when user logs in or enables push notifications
 */
export const registerPushToken = async (userId: string, playerId: string) => {
  if (!playerId || playerId.trim() === '') {
    throw new GraphQLError('Player ID is required', {
      extensions: { code: 'VALIDATION_ERROR' },
    });
  }

  // Check if this player ID is already registered to another user
  const existingUser = await prisma.user.findFirst({
    where: {
      oneSignalPlayerId: playerId,
      id: { not: userId },
    },
  });

  // If another user has this player ID, remove it from them
  // (device can only belong to one user at a time)
  if (existingUser) {
    await prisma.user.update({
      where: { id: existingUser.id },
      data: { oneSignalPlayerId: null },
    });
  }

  // Update the current user with the player ID
  const user = await prisma.user.update({
    where: { id: userId },
    data: {
      oneSignalPlayerId: playerId,
      pushEnabled: true,
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
    await setExternalUserId(playerId, userId);
  } catch (error) {
    console.error('Failed to set external user ID in OneSignal:', error);
    // Don't fail the request - the player ID is still registered locally
  }

  return {
    success: true,
    message: 'Push notifications enabled successfully',
    pushEnabled: user.pushEnabled,
  };
};

/**
 * Unregister push notifications for a user
 * Called when user logs out or disables push notifications
 */
export const unregisterPushToken = async (userId: string) => {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { oneSignalPlayerId: true },
  });

  if (user?.oneSignalPlayerId) {
    // Remove external user ID from OneSignal
    try {
      await removeExternalUserId(user.oneSignalPlayerId);
    } catch (error) {
      console.error('Failed to remove external user ID from OneSignal:', error);
    }
  }

  await prisma.user.update({
    where: { id: userId },
    data: {
      oneSignalPlayerId: null,
      pushEnabled: false,
    },
  });

  return {
    success: true,
    message: 'Push notifications disabled successfully',
    pushEnabled: false,
  };
};

/**
 * Update push notification preference
 */
export const updatePushPreference = async (userId: string, enabled: boolean) => {
  const user = await prisma.user.update({
    where: { id: userId },
    data: { pushEnabled: enabled },
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
 * Send push notification to a single user
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
      oneSignalPlayerId: true,
      pushEnabled: true,
    },
  });

  if (!user?.oneSignalPlayerId) {
    return { success: false, errors: ['User has no registered device'] };
  }

  if (!user.pushEnabled) {
    return { success: false, errors: ['User has disabled push notifications'] };
  }

  try {
    const payload = buildNotificationPayload(appId, options);
    payload.include_player_ids = [user.oneSignalPlayerId];

    const result = await oneSignalRequest('/notifications', 'POST', payload);

    return {
      success: true,
      messageId: result.id,
    };
  } catch (error: any) {
    return {
      success: false,
      errors: [error.message],
    };
  }
};

/**
 * Send push notification to multiple users
 */
export const sendPushToUsers = async (
  userIds: string[],
  options: SendPushOptions
): Promise<PushResult> => {
  const { appId } = config.oneSignal;

  if (!appId) {
    return { success: false, errors: ['OneSignal not configured'] };
  }

  // Get all users with push enabled and valid player IDs
  const users = await prisma.user.findMany({
    where: {
      id: { in: userIds },
      pushEnabled: true,
      oneSignalPlayerId: { not: null },
    },
    select: {
      oneSignalPlayerId: true,
    },
  });

  const playerIds = users
    .map(u => u.oneSignalPlayerId)
    .filter((id): id is string => id !== null);

  if (playerIds.length === 0) {
    return { success: false, errors: ['No users with push notifications enabled'] };
  }

  try {
    const payload = buildNotificationPayload(appId, options);
    payload.include_player_ids = playerIds;

    const result = await oneSignalRequest('/notifications', 'POST', payload);

    return {
      success: true,
      messageId: result.id,
    };
  } catch (error: any) {
    return {
      success: false,
      errors: [error.message],
    };
  }
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
  } catch (error: any) {
    return {
      success: false,
      errors: [error.message],
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
  } catch (error: any) {
    return {
      success: false,
      errors: [error.message],
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
    select: { oneSignalPlayerId: true, pushEnabled: true },
  });

  if (!user?.oneSignalPlayerId) {
    return { success: false, errors: ['User has no registered device'] };
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

    const payload = buildNotificationPayload(appId, options);
    payload.include_player_ids = [user.oneSignalPlayerId];

    const result = await oneSignalRequest('/notifications', 'POST', payload);

    return {
      success: true,
      messageId: result.id,
    };
  } catch (error: any) {
    return {
      success: false,
      errors: [error.message],
    };
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

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      oneSignalPlayerId: true,
      pushEnabled: true,
    },
  });

  if (!user?.oneSignalPlayerId) {
    return { success: false, errors: ['User has no registered device'] };
  }

  try {
    const result = await oneSignalRequest('/notifications', 'POST', {
      app_id: appId,
      include_player_ids: [user.oneSignalPlayerId],
      content_available: true, // iOS background push
      data: data,
      // No headings or contents for silent push
    });

    return {
      success: true,
      messageId: result.id,
    };
  } catch (error: any) {
    return {
      success: false,
      errors: [error.message],
    };
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

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      oneSignalPlayerId: true,
    },
  });

  if (!user?.oneSignalPlayerId) {
    return { success: false, errors: ['User has no registered device'] };
  }

  try {
    const result = await oneSignalRequest('/notifications', 'POST', {
      app_id: appId,
      include_player_ids: [user.oneSignalPlayerId],
      content_available: true,
      ios_badgeType: 'SetTo',
      ios_badgeCount: count,
      // Silent notification just to update badge
    });

    return {
      success: true,
      messageId: result.id,
    };
  } catch (error: any) {
    return {
      success: false,
      errors: [error.message],
    };
  }
};

// ==================
// Notification Type Helpers
// ==================

/**
 * Send booking notification push
 */
export const sendBookingPush = async (
  userId: string,
  type: 'new' | 'accepted' | 'rejected' | 'completed' | 'cancelled',
  bookingId: string,
  serviceName: string
) => {
  const titles: Record<string, string> = {
    new: 'New Booking Request',
    accepted: 'Booking Accepted! 🎉',
    rejected: 'Booking Update',
    completed: 'Booking Completed',
    cancelled: 'Booking Cancelled',
  };

  const messages: Record<string, string> = {
    new: `You have a new booking request for ${serviceName}`,
    accepted: `Your booking for ${serviceName} has been accepted`,
    rejected: `Your booking for ${serviceName} was not accepted`,
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
  });
};

/**
 * Send message notification push
 */
export const sendMessagePush = async (
  userId: string,
  senderName: string,
  messagePreview: string,
  conversationId: string
) => {
  return sendPushToUser(userId, {
    title: `New message from ${senderName}`,
    message: messagePreview.length > 50 ? messagePreview.substring(0, 50) + '...' : messagePreview,
    data: {
      type: 'MESSAGE',
      conversationId,
    },
  });
};

/**
 * Send review notification push
 */
export const sendReviewPush = async (
  userId: string,
  reviewerName: string,
  rating: number,
  serviceName: string
) => {
  return sendPushToUser(userId, {
    title: 'New Review Received ⭐',
    message: `${reviewerName} left a ${rating}-star review for ${serviceName}`,
    data: {
      type: 'REVIEW',
    },
  });
};

/**
 * Send provider verification push
 */
export const sendVerificationPush = async (
  userId: string,
  status: 'approved' | 'rejected',
  reason?: string
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
  });
};

export default {
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
  sendVerificationPush,
};