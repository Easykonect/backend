/**
 * Push Notification Service Tests
 * Tests OneSignal push notification functionality
 *
 * Also covers:
 *   - several devices per account: registering adds a trimmed device and
 *     moves it off other accounts; pushes go to every device
 *   - a user's own "push off" survives registering a device again
 *   - per-category notification settings decide which pushes go out
 *   - a push sent for an in-app notification marks it as pushed
 */

import { GraphQLError } from 'graphql';

// Mock prisma before importing the service
jest.mock('@/lib/prisma', () => ({
  __esModule: true,
  default: {
    user: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
    },
    userSettings: {
      findUnique: jest.fn(),
    },
    notification: {
      updateMany: jest.fn(),
    },
  },
}));

// Mock config
jest.mock('@/config', () => ({
  config: {
    oneSignal: {
      appId: 'test-app-id',
      restApiKey: 'test-rest-api-key',
      apiUrl: 'https://onesignal.com/api/v1',
    },
  },
}));

// Mock fetch globally
const mockFetch = jest.fn();
global.fetch = mockFetch;

import prisma from '@/lib/prisma';
import {
  registerPushToken,
  unregisterPushToken,
  updatePushPreference,
  sendPushToUser,
  sendPushToUsers,
  sendPushByExternalIds,
  sendPushToAll,
  sendBookingPush,
  sendMessagePush,
  sendReviewPush,
  sendReviewResponsePush,
  sendServicePush,
  sendVerificationPush,
  isNotificationAllowed,
  notificationCategoryFor,
  shouldNotifyUser,
} from '@/services/push.service';

// ==================
// Test Data
// ==================

const mockUserId = '507f1f77bcf86cd799439011';
const otherUserId = '507f1f77bcf86cd799439022';
const mockPlayerId = 'onesignal-player-id-123';
const mockUser = {
  id: mockUserId,
  email: 'test@example.com',
  oneSignalPlayerId: mockPlayerId,
  pushEnabled: true,
};

const db = prisma as unknown as Record<string, Record<string, jest.Mock>>;

// ==================
// Helper Functions
// ==================

const mockSuccessResponse = (data: Record<string, unknown> = { id: 'notification-id-123' }) => {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => data,
  });
};

const mockErrorResponse = (errors: string[] = ['API Error']) => {
  mockFetch.mockResolvedValueOnce({
    ok: false,
    json: async () => ({ errors }),
  });
};

const sentBody = (call = 0) => JSON.parse(mockFetch.mock.calls[call][1].body);

// The account as registerPushToken reads it
const accountWith = (fields: Record<string, unknown> = {}) => ({
  oneSignalPlayerId: null,
  oneSignalPlayerIds: [],
  pushEnabled: true,
  pushOptedOutAt: null,
  ...fields,
});

// A user with one device and push on, as the senders read it
const deviceOwner = (fields: Record<string, unknown> = {}) => ({
  oneSignalPlayerId: mockPlayerId,
  pushEnabled: true,
  ...fields,
});

// ==================
// Test Setup
// ==================

beforeEach(() => {
  jest.clearAllMocks();
  mockFetch.mockReset();
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  db.user.findMany.mockResolvedValue([]);
  db.user.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    ...mockUser,
    ...data,
  }));
  db.notification.updateMany.mockResolvedValue({ count: 1 });
});

// ==================
// registerPushToken Tests
// ==================

describe('registerPushToken', () => {
  it('should register a new push token for a user', async () => {
    db.user.findUnique.mockResolvedValue(accountWith());
    mockSuccessResponse();

    const result = await registerPushToken(mockUserId, mockPlayerId);

    expect(result).toEqual({
      success: true,
      message: 'Push notifications enabled successfully',
      pushEnabled: true,
    });
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: mockUserId },
      data: {
        oneSignalPlayerId: mockPlayerId,
        oneSignalPlayerIds: [mockPlayerId],
        pushEnabled: true,
      },
      select: {
        id: true,
        email: true,
        oneSignalPlayerId: true,
        pushEnabled: true,
      },
    });
  });

  it('should throw error for empty player ID', async () => {
    await expect(registerPushToken(mockUserId, '')).rejects.toThrow(GraphQLError);
    await expect(registerPushToken(mockUserId, '   ')).rejects.toThrow(GraphQLError);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('trims the player ID before storing it and matching other accounts', async () => {
    db.user.findUnique.mockResolvedValue(accountWith());
    mockSuccessResponse();

    await registerPushToken(mockUserId, `  ${mockPlayerId}\n`);

    expect(db.user.findMany).toHaveBeenCalledWith({
      where: {
        id: { not: mockUserId },
        OR: [{ oneSignalPlayerId: mockPlayerId }, { oneSignalPlayerIds: { has: mockPlayerId } }],
      },
      select: { id: true, oneSignalPlayerId: true, oneSignalPlayerIds: true },
    });
    expect(db.user.update.mock.calls[0][0].data).toMatchObject({
      oneSignalPlayerId: mockPlayerId,
      oneSignalPlayerIds: [mockPlayerId],
    });
  });

  it("keeps the account's other devices, with this one as the most recent", async () => {
    db.user.findUnique.mockResolvedValue(
      accountWith({ oneSignalPlayerId: 'phone-b', oneSignalPlayerIds: ['phone-a', mockPlayerId, 'phone-b'] })
    );

    await registerPushToken(mockUserId, mockPlayerId);

    expect(db.user.update.mock.calls[0][0].data).toMatchObject({
      oneSignalPlayerId: mockPlayerId,
      oneSignalPlayerIds: ['phone-a', 'phone-b', mockPlayerId],
    });
  });

  it('adds a device to an account registered before several devices were supported', async () => {
    db.user.findUnique.mockResolvedValue({ oneSignalPlayerId: 'old-phone', pushEnabled: true });

    await registerPushToken(mockUserId, mockPlayerId);

    expect(db.user.update.mock.calls[0][0].data).toMatchObject({
      oneSignalPlayerId: mockPlayerId,
      oneSignalPlayerIds: ['old-phone', mockPlayerId],
    });
  });

  it('keeps at most 10 devices, dropping the oldest', async () => {
    const devices = Array.from({ length: 10 }, (_, i) => `phone-${i}`);
    db.user.findUnique.mockResolvedValue(accountWith({ oneSignalPlayerId: 'phone-9', oneSignalPlayerIds: devices }));

    await registerPushToken(mockUserId, 'phone-new');

    expect(db.user.update.mock.calls[0][0].data.oneSignalPlayerIds).toEqual([...devices.slice(1), 'phone-new']);
  });

  it("should remove player ID from another user if already registered, keeping that user's other devices", async () => {
    db.user.findMany.mockResolvedValue([
      { id: otherUserId, oneSignalPlayerId: mockPlayerId, oneSignalPlayerIds: ['their-tablet', mockPlayerId] },
    ]);
    db.user.findUnique.mockResolvedValue(accountWith());
    mockSuccessResponse();

    const result = await registerPushToken(mockUserId, mockPlayerId);

    expect(result.success).toBe(true);
    expect(prisma.user.update).toHaveBeenCalledTimes(2);
    expect(prisma.user.update).toHaveBeenNthCalledWith(1, {
      where: { id: otherUserId },
      data: { oneSignalPlayerId: 'their-tablet', oneSignalPlayerIds: ['their-tablet'] },
    });
  });

  it('leaves push off when the user switched it off themselves', async () => {
    db.user.findUnique.mockResolvedValue(accountWith({ pushEnabled: false, pushOptedOutAt: new Date() }));

    const result = await registerPushToken(mockUserId, mockPlayerId);

    expect(db.user.update.mock.calls[0][0].data.pushEnabled).toBe(false);
    expect(result).toEqual({
      success: true,
      message: 'Device registered. Push notifications stay off until you turn them on',
      pushEnabled: false,
    });
  });

  it('switches push back on after the device was only unregistered, as on logout', async () => {
    db.user.findUnique.mockResolvedValue(accountWith({ pushEnabled: false }));

    const result = await registerPushToken(mockUserId, mockPlayerId);

    expect(db.user.update.mock.calls[0][0].data.pushEnabled).toBe(true);
    expect(result.pushEnabled).toBe(true);
  });

  it('switches push on and clears the opt-out when asked to enable', async () => {
    db.user.findUnique.mockResolvedValue(accountWith({ pushEnabled: false, pushOptedOutAt: new Date() }));

    await registerPushToken(mockUserId, mockPlayerId, { enable: true });

    expect(db.user.update.mock.calls[0][0].data).toMatchObject({ pushEnabled: true, pushOptedOutAt: null });
  });

  it('returns NOT_FOUND when the account no longer exists', async () => {
    db.user.findUnique.mockResolvedValue(null);

    await expect(registerPushToken(mockUserId, mockPlayerId)).rejects.toMatchObject({
      extensions: { code: 'NOT_FOUND' },
    });
  });

  it('should still succeed if OneSignal API fails', async () => {
    db.user.findUnique.mockResolvedValue(accountWith());
    mockErrorResponse(['OneSignal error']);

    // Should not throw, just log error
    const result = await registerPushToken(mockUserId, mockPlayerId);
    expect(result.success).toBe(true);
  });
});

// ==================
// unregisterPushToken Tests
// ==================

describe('unregisterPushToken', () => {
  it('should unregister every device for a user and switch push off', async () => {
    db.user.findUnique.mockResolvedValue({ oneSignalPlayerId: mockPlayerId, oneSignalPlayerIds: ['tablet', mockPlayerId], pushEnabled: true });
    mockSuccessResponse();
    mockSuccessResponse();

    const result = await unregisterPushToken(mockUserId);

    expect(result).toEqual({
      success: true,
      message: 'Push notifications disabled successfully',
      pushEnabled: false,
    });
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: mockUserId },
      data: {
        oneSignalPlayerId: null,
        oneSignalPlayerIds: [],
        pushEnabled: false,
      },
    });
  });

  it('removes only the given device, keeping push as it was while others remain', async () => {
    db.user.findUnique.mockResolvedValue({ oneSignalPlayerId: mockPlayerId, oneSignalPlayerIds: ['tablet', mockPlayerId], pushEnabled: true });
    mockSuccessResponse();

    const result = await unregisterPushToken(mockUserId, ` ${mockPlayerId} `);

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: mockUserId },
      data: { oneSignalPlayerId: 'tablet', oneSignalPlayerIds: ['tablet'] },
    });
    expect(result).toEqual({ success: true, message: 'Device unregistered', pushEnabled: true });
  });

  it('switches push off when the given device was the last one', async () => {
    db.user.findUnique.mockResolvedValue({ oneSignalPlayerId: mockPlayerId, pushEnabled: true });
    mockSuccessResponse();

    const result = await unregisterPushToken(mockUserId, mockPlayerId);

    expect(db.user.update.mock.calls[0][0].data).toEqual({
      oneSignalPlayerId: null,
      oneSignalPlayerIds: [],
      pushEnabled: false,
    });
    expect(result.pushEnabled).toBe(false);
  });

  it('should still succeed if user has no player ID', async () => {
    db.user.findUnique.mockResolvedValue({ oneSignalPlayerId: null, pushEnabled: true });

    const result = await unregisterPushToken(mockUserId);
    expect(result.success).toBe(true);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('should still succeed if OneSignal API fails', async () => {
    db.user.findUnique.mockResolvedValue({ oneSignalPlayerId: mockPlayerId, pushEnabled: true });
    mockErrorResponse();

    const result = await unregisterPushToken(mockUserId);
    expect(result.success).toBe(true);
  });
});

// ==================
// updatePushPreference Tests
// ==================

describe('updatePushPreference', () => {
  it('should enable push notifications and forget an earlier opt-out', async () => {
    const result = await updatePushPreference(mockUserId, true);

    expect(result).toEqual({
      success: true,
      message: 'Push notifications enabled',
      pushEnabled: true,
    });
    expect(db.user.update.mock.calls[0][0].data).toEqual({ pushEnabled: true, pushOptedOutAt: null });
  });

  it('should disable push notifications and remember that the user chose it', async () => {
    const result = await updatePushPreference(mockUserId, false);

    expect(result).toEqual({
      success: true,
      message: 'Push notifications disabled',
      pushEnabled: false,
    });
    expect(db.user.update.mock.calls[0][0].data).toEqual({
      pushEnabled: false,
      pushOptedOutAt: expect.any(Date),
    });
  });
});

// ==================
// Notification settings
// ==================

describe('notification settings', () => {
  it.each([
    ['NEW_MESSAGE', 'messages'],
    ['MESSAGE', 'messages'],
    ['BOOKING', 'bookingUpdates'],
    ['BOOKING_CREATED', 'bookingUpdates'],
    ['REVIEW_RESPONSE', 'reviews'],
    ['DISPUTE_UPDATED', 'disputeUpdates'],
    ['VERIFICATION_REJECTED', 'providerVerification'],
    ['SERVICE_APPROVED', 'providerVerification'],
  ])('puts %s in the %s category', (type, category) => {
    expect(notificationCategoryFor(type)).toBe(category);
  });

  it.each([
    'PAYMENT_RECEIVED',
    'PAYMENT_FAILED',
    'REFUND_PROCESSED',
    'ACCOUNT_SUSPENDED',
    'ACCOUNT_ACTIVATED',
    'SERVICE_SUSPENDED',
    'SYSTEM_ANNOUNCEMENT',
  ])('lets nobody switch off %s', (type) => {
    expect(notificationCategoryFor(type)).toBeNull();
    expect(
      isNotificationAllowed(
        { notifyMessages: false, notifyBookingUpdates: false, notifyReviews: false, notifyDisputeUpdates: false, notifyProviderVerification: false },
        type
      )
    ).toBe(true);
  });

  it('uses the settings defaults for an account without settings', () => {
    expect(isNotificationAllowed(null, 'NEW_MESSAGE', 'push')).toBe(true);
    expect(isNotificationAllowed(null, 'NEW_MESSAGE', 'email')).toBe(false);
    expect(isNotificationAllowed(null, 'BOOKING_ACCEPTED', 'email')).toBe(true);
    expect(isNotificationAllowed(null, 'DISPUTE_OPENED', 'email')).toBe(true);
  });

  it('checks the stored setting for the channel', async () => {
    db.userSettings.findUnique.mockResolvedValue({ notifyReviews: true, emailReviews: false });

    await expect(shouldNotifyUser(mockUserId, 'REVIEW_RECEIVED', 'push')).resolves.toBe(true);
    await expect(shouldNotifyUser(mockUserId, 'REVIEW_RECEIVED', 'email')).resolves.toBe(false);
    expect(db.userSettings.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: mockUserId } })
    );
  });

  it('does not look up settings for a type nobody can switch off', async () => {
    await expect(shouldNotifyUser(mockUserId, 'PAYMENT_RECEIVED')).resolves.toBe(true);
    expect(db.userSettings.findUnique).not.toHaveBeenCalled();
  });
});

// ==================
// sendPushToUser Tests
// ==================

describe('sendPushToUser', () => {
  const pushOptions = {
    title: 'Test Title',
    message: 'Test Message',
  };

  it('should send push notification to a single user', async () => {
    db.user.findUnique.mockResolvedValue(deviceOwner());
    mockSuccessResponse({ id: 'notification-123' });

    const result = await sendPushToUser(mockUserId, pushOptions);

    expect(result).toEqual({
      success: true,
      messageId: 'notification-123',
    });
    expect(mockFetch).toHaveBeenCalledWith(
      'https://onesignal.com/api/v1/notifications',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          'Authorization': 'Basic test-rest-api-key',
        }),
      })
    );
    expect(sentBody().include_player_ids).toEqual([mockPlayerId]);
  });

  it("sends to every one of the user's devices", async () => {
    db.user.findUnique.mockResolvedValue(
      deviceOwner({ oneSignalPlayerId: 'phone', oneSignalPlayerIds: ['tablet', 'phone'] })
    );
    mockSuccessResponse();

    await sendPushToUser(mockUserId, pushOptions);

    expect(sentBody().include_player_ids).toEqual(['tablet', 'phone']);
  });

  it('should return error if user has no registered device', async () => {
    db.user.findUnique.mockResolvedValue(deviceOwner({ oneSignalPlayerId: null }));

    const result = await sendPushToUser(mockUserId, pushOptions);

    expect(result).toEqual({
      success: false,
      errors: ['User has no registered device'],
    });
  });

  it('should return error if user has push disabled', async () => {
    db.user.findUnique.mockResolvedValue(deviceOwner({ pushEnabled: false }));

    const result = await sendPushToUser(mockUserId, pushOptions);

    expect(result).toEqual({
      success: false,
      errors: ['User has disabled push notifications'],
    });
  });

  it('skips a type of notification the user switched off in their settings', async () => {
    db.user.findUnique.mockResolvedValue(deviceOwner({ settings: { notifyMessages: false } }));

    const result = await sendPushToUser(mockUserId, { ...pushOptions, data: { type: 'MESSAGE' } });

    expect(result).toEqual({ success: false, errors: ['User has turned off this type of notification'] });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('checks notificationType over data.type', async () => {
    db.user.findUnique.mockResolvedValue(deviceOwner({ settings: { notifyReviews: false } }));

    const result = await sendPushToUser(mockUserId, {
      ...pushOptions,
      data: { type: 'SOMETHING_ELSE' },
      notificationType: 'REVIEW_RECEIVED',
    });

    expect(result.success).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("always sends notifications users can't switch off", async () => {
    db.user.findUnique.mockResolvedValue(
      deviceOwner({ settings: { notifyBookingUpdates: false, notifyDisputeUpdates: false } })
    );
    mockSuccessResponse();

    const result = await sendPushToUser(mockUserId, { ...pushOptions, data: { type: 'PAYMENT_RECEIVED' } });

    expect(result.success).toBe(true);
  });

  it.each<[string, boolean]>([
    ['approved', false],
    ['rejected', false],
    ['suspended', true],
  ])('treats a SERVICE push with action %s by its decision', async (action, sent) => {
    db.user.findUnique.mockResolvedValue(deviceOwner({ settings: { notifyProviderVerification: false } }));
    mockSuccessResponse();

    const result = await sendPushToUser(mockUserId, {
      ...pushOptions,
      data: { type: 'SERVICE', serviceId: 'service-1', action },
    });

    expect(result.success).toBe(sent);
  });

  it('marks the in-app notification it was sent for as pushed', async () => {
    db.user.findUnique.mockResolvedValue(deviceOwner());
    mockSuccessResponse();

    await sendPushToUser(mockUserId, { ...pushOptions, notificationId: 'notification-7' });

    expect(db.notification.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['notification-7'] } },
      data: { isPushed: true, pushedAt: expect.any(Date) },
    });
  });

  it('does not mark the notification when the push fails', async () => {
    db.user.findUnique.mockResolvedValue(deviceOwner());
    mockErrorResponse(['All included players are not subscribed']);

    const result = await sendPushToUser(mockUserId, { ...pushOptions, notificationId: 'notification-7' });

    expect(result.success).toBe(false);
    expect(db.notification.updateMany).not.toHaveBeenCalled();
  });

  it('still reports success when recording the push fails', async () => {
    db.user.findUnique.mockResolvedValue(deviceOwner());
    db.notification.updateMany.mockRejectedValue(new Error('write failed'));
    mockSuccessResponse({ id: 'notification-123' });

    await expect(
      sendPushToUser(mockUserId, { ...pushOptions, notificationId: 'notification-7' })
    ).resolves.toEqual({ success: true, messageId: 'notification-123' });
  });

  it('should include optional data in push notification', async () => {
    db.user.findUnique.mockResolvedValue(deviceOwner());
    mockSuccessResponse();

    await sendPushToUser(mockUserId, {
      ...pushOptions,
      data: { key: 'value' },
      url: 'https://example.com',
    });

    const body = sentBody();
    expect(body.data).toEqual({ key: 'value' });
    expect(body.url).toBe('https://example.com');
    expect(body.notificationId).toBeUndefined();
  });
});

// ==================
// sendPushToUsers Tests
// ==================

describe('sendPushToUsers', () => {
  const pushOptions = {
    title: 'Broadcast Title',
    message: 'Broadcast Message',
  };

  it('should send push notification to multiple users', async () => {
    const userIds = ['user1', 'user2', 'user3'];
    db.user.findMany.mockResolvedValue([
      { oneSignalPlayerId: 'player1' },
      { oneSignalPlayerId: 'player2' },
    ]);
    mockSuccessResponse({ id: 'bulk-notification-123' });

    const result = await sendPushToUsers(userIds, pushOptions);

    expect(result).toEqual({
      success: true,
      messageId: 'bulk-notification-123',
    });
  });

  it('should return error if no users have push enabled', async () => {
    db.user.findMany.mockResolvedValue([]);

    const result = await sendPushToUsers(['user1', 'user2'], pushOptions);

    expect(result).toEqual({
      success: false,
      errors: ['No users with push notifications enabled'],
    });
  });

  it('should filter out users without player IDs', async () => {
    db.user.findMany.mockResolvedValue([
      { oneSignalPlayerId: 'player1' },
      { oneSignalPlayerId: null },
    ]);
    mockSuccessResponse();

    await sendPushToUsers(['user1', 'user2'], pushOptions);

    expect(sentBody().include_player_ids).toEqual(['player1']);
  });

  it("leaves out users who switched this type off, and marks only the pushed users' notifications", async () => {
    db.user.findMany.mockResolvedValue([
      { id: 'user1', oneSignalPlayerId: 'player1', oneSignalPlayerIds: ['tablet1', 'player1'] },
      { id: 'user2', oneSignalPlayerId: 'player2', settings: { notifyDisputeUpdates: false } },
    ]);
    mockSuccessResponse();

    await sendPushToUsers(['user1', 'user2'], {
      ...pushOptions,
      data: { type: 'DISPUTE_UPDATED' },
      notificationIds: { user1: 'n1', user2: 'n2' },
    });

    expect(sentBody().include_player_ids).toEqual(['tablet1', 'player1']);
    expect(db.notification.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['n1'] } },
      data: { isPushed: true, pushedAt: expect.any(Date) },
    });
  });

  it("keeps each request within 2,000 devices, with each user's devices together", async () => {
    const devices = (prefix: string) => Array.from({ length: 800 }, (_, i) => `${prefix}-${i}`);
    db.user.findMany.mockResolvedValue([
      { id: 'a', oneSignalPlayerId: 'a-799', oneSignalPlayerIds: devices('a') },
      { id: 'b', oneSignalPlayerId: 'b-799', oneSignalPlayerIds: devices('b') },
      { id: 'c', oneSignalPlayerId: 'c-799', oneSignalPlayerIds: devices('c') },
    ]);
    mockSuccessResponse();
    mockSuccessResponse();

    await sendPushToUsers(['a', 'b', 'c'], pushOptions);

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(sentBody(0).include_player_ids).toEqual([...devices('a'), ...devices('b')]);
    expect(sentBody(1).include_player_ids).toEqual(devices('c'));
  });
});

// ==================
// sendPushByExternalIds Tests
// ==================

describe('sendPushByExternalIds', () => {
  const pushOptions = {
    title: 'External ID Push',
    message: 'Message via external user ID',
  };

  it('should send push notification using external user IDs', async () => {
    mockSuccessResponse({ id: 'external-notification-123' });

    const result = await sendPushByExternalIds(
      ['user-id-1', 'user-id-2'],
      pushOptions
    );

    expect(result).toEqual({
      success: true,
      messageId: 'external-notification-123',
    });

    const body = sentBody();
    expect(body.include_external_user_ids).toEqual(['user-id-1', 'user-id-2']);
    expect(body.channel_for_external_user_ids).toBe('push');
  });

  it('should handle API errors gracefully', async () => {
    mockErrorResponse(['Invalid external user ID']);

    const result = await sendPushByExternalIds(['invalid-id'], pushOptions);

    expect(result.success).toBe(false);
    expect(result.errors).toBeDefined();
  });
});

// ==================
// sendPushToAll Tests
// ==================

describe('sendPushToAll', () => {
  const pushOptions = {
    title: 'Announcement',
    message: 'This is a broadcast to all users',
  };

  it('should send push notification to all users', async () => {
    mockSuccessResponse({ id: 'broadcast-123' });

    const result = await sendPushToAll(pushOptions);

    expect(result).toEqual({
      success: true,
      messageId: 'broadcast-123',
    });

    expect(sentBody().included_segments).toEqual(['All']);
  });

  it('should handle API errors gracefully', async () => {
    mockErrorResponse(['Broadcast failed']);

    const result = await sendPushToAll(pushOptions);

    expect(result.success).toBe(false);
    expect(result.errors).toBeDefined();
  });
});

// ==================
// Notification Type Helper Tests
// ==================

describe('sendBookingPush', () => {
  beforeEach(() => {
    db.user.findUnique.mockResolvedValue(deviceOwner());
    mockSuccessResponse();
  });

  it('should send new booking notification', async () => {
    await sendBookingPush(mockUserId, 'new', 'booking-123', 'House Cleaning');

    const body = sentBody();
    expect(body.headings.en).toBe('New Booking Request');
    expect(body.contents.en).toContain('House Cleaning');
    expect(body.data.type).toBe('BOOKING');
    expect(body.data.bookingId).toBe('booking-123');
    expect(body.data.action).toBe('new');
  });

  it('should send accepted booking notification', async () => {
    await sendBookingPush(mockUserId, 'accepted', 'booking-123', 'Plumbing');

    const body = sentBody();
    expect(body.headings.en).toBe('Booking Accepted! 🎉');
    expect(body.contents.en).toContain('Plumbing');
  });

  it('should send rejected booking notification', async () => {
    await sendBookingPush(mockUserId, 'rejected', 'booking-123', 'Gardening');

    expect(sentBody().headings.en).toBe('Booking Update');
  });

  it('should send started booking notification', async () => {
    await sendBookingPush(mockUserId, 'started', 'booking-123', 'Gardening');

    const body = sentBody();
    expect(body.headings.en).toBe('Service Started');
    expect(body.contents.en).toBe('Your service Gardening has started');
    expect(body.data.action).toBe('started');
  });

  it('should send completed booking notification', async () => {
    await sendBookingPush(mockUserId, 'completed', 'booking-123', 'Electrical');

    const body = sentBody();
    expect(body.headings.en).toBe('Booking Completed');
    expect(body.contents.en).toContain('Leave a review');
  });

  it('should send cancelled booking notification', async () => {
    await sendBookingPush(mockUserId, 'cancelled', 'booking-123', 'Carpentry');

    expect(sentBody().headings.en).toBe('Booking Cancelled');
  });

  it('is skipped when the user switched off booking updates', async () => {
    mockFetch.mockReset();
    db.user.findUnique.mockResolvedValue(deviceOwner({ settings: { notifyBookingUpdates: false } }));

    const result = await sendBookingPush(mockUserId, 'accepted', 'booking-123', 'Plumbing');

    expect(result.success).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('sendMessagePush', () => {
  beforeEach(() => {
    db.user.findUnique.mockResolvedValue(deviceOwner());
    mockSuccessResponse();
  });

  it('should send message notification', async () => {
    await sendMessagePush(mockUserId, 'John Doe', 'Hello!', 'conv-123');

    const body = sentBody();
    expect(body.headings.en).toBe('New message from John Doe');
    expect(body.contents.en).toBe('Hello!');
    expect(body.data.type).toBe('MESSAGE');
    expect(body.data.conversationId).toBe('conv-123');
  });

  it('should truncate long messages', async () => {
    const longMessage = 'A'.repeat(100);
    await sendMessagePush(mockUserId, 'Jane', longMessage, 'conv-456');

    const body = sentBody();
    expect(body.contents.en).toHaveLength(53); // 50 chars + '...'
    expect(body.contents.en.endsWith('...')).toBe(true);
  });

  it('gives a message with only attachments a body, since a push needs one', async () => {
    await sendMessagePush(mockUserId, 'Jane', '', 'conv-456');

    expect(sentBody().contents.en).toBe('Sent an attachment');
  });

  it('marks the message notification as pushed', async () => {
    await sendMessagePush(mockUserId, 'Jane', 'Hi', 'conv-456', { notificationId: 'notification-9' });

    expect(db.notification.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ['notification-9'] } } })
    );
  });
});

describe('sendReviewPush', () => {
  beforeEach(() => {
    db.user.findUnique.mockResolvedValue(deviceOwner());
    mockSuccessResponse();
  });

  it('should send review notification', async () => {
    await sendReviewPush(mockUserId, 'Alice', 5, 'Cleaning Service');

    const body = sentBody();
    expect(body.headings.en).toBe('New Review Received ⭐');
    expect(body.contents.en).toContain('Alice');
    expect(body.contents.en).toContain('5-star');
    expect(body.contents.en).toContain('Cleaning Service');
    expect(body.data).toEqual({ type: 'REVIEW' });
  });

  it('carries the review ID when given', async () => {
    await sendReviewPush(mockUserId, 'Alice', 5, 'Cleaning Service', { reviewId: 'review-1' });

    expect(sentBody().data).toEqual({ type: 'REVIEW', reviewId: 'review-1' });
  });
});

describe('sendReviewResponsePush', () => {
  it("tells the reviewer about the provider's response", async () => {
    db.user.findUnique.mockResolvedValue(deviceOwner());
    mockSuccessResponse();

    await sendReviewResponsePush(mockUserId, 'Ada Cleaning', 'review-1');

    const body = sentBody();
    expect(body.headings.en).toBe('Provider Responded to Your Review');
    expect(body.contents.en).toBe('Ada Cleaning has responded to your review');
    expect(body.data).toEqual({ type: 'REVIEW', reviewId: 'review-1', action: 'response' });
  });
});

describe('sendVerificationPush', () => {
  beforeEach(() => {
    db.user.findUnique.mockResolvedValue(deviceOwner());
    mockSuccessResponse();
  });

  it('should send approved verification notification', async () => {
    await sendVerificationPush(mockUserId, 'approved');

    const body = sentBody();
    expect(body.headings.en).toBe('Verification Approved! 🎉');
    expect(body.contents.en).toContain('verified');
    expect(body.data.type).toBe('VERIFICATION');
    expect(body.data.status).toBe('approved');
  });

  it('should send rejected verification notification', async () => {
    await sendVerificationPush(mockUserId, 'rejected', 'Missing documents');

    const body = sentBody();
    expect(body.headings.en).toBe('Verification Update');
    expect(body.contents.en).toContain('Missing documents');
    expect(body.data.status).toBe('rejected');
  });

  it('should use default message if no reason provided', async () => {
    await sendVerificationPush(mockUserId, 'rejected');

    expect(sentBody().contents.en).toContain('Please check the app for details');
  });
});

describe('sendServicePush', () => {
  it('sends a suspension even when verification updates are switched off', async () => {
    db.user.findUnique.mockResolvedValue(deviceOwner({ settings: { notifyProviderVerification: false } }));
    mockSuccessResponse();

    const result = await sendServicePush(mockUserId, 'suspended', 'service-1', 'Deep Cleaning', 'Reported by customers');

    expect(result.success).toBe(true);
    const body = sentBody();
    expect(body.headings.en).toBe('Service Suspended');
    expect(body.contents.en).toBe('Your service "Deep Cleaning" has been suspended. Reported by customers');
    expect(body.data).toEqual({ type: 'SERVICE', serviceId: 'service-1', status: 'suspended' });
  });

  it('skips an approval when verification updates are switched off', async () => {
    db.user.findUnique.mockResolvedValue(deviceOwner({ settings: { notifyProviderVerification: false } }));

    const result = await sendServicePush(mockUserId, 'approved', 'service-1', 'Deep Cleaning');

    expect(result.success).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ==================
// OneSignal Not Configured Tests
// ==================

describe('OneSignal Not Configured', () => {
  // Temporarily override config
  beforeEach(() => {
    jest.resetModules();
  });

  it('should handle missing OneSignal config gracefully in sendPushToUser', async () => {
    // Re-import with empty config
    jest.doMock('@/config', () => ({
      config: {
        oneSignal: {
          appId: '',
          restApiKey: '',
        },
      },
    }));

    // Need to clear and re-import
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- re-import after jest.resetModules()
    const { sendPushToUser: sendPushNoConfig } = require('@/services/push.service');

    const result = await sendPushNoConfig(mockUserId, {
      title: 'Test',
      message: 'Test',
    });

    expect(result).toEqual({
      success: false,
      errors: ['OneSignal not configured'],
    });
  });
});

// ==================
// App API Key (os_v2_app_…) Tests
// ==================

describe('OneSignal App API key', () => {
  const loadWithAppApiKey = (apiUrl = 'https://onesignal.com/api/v1') => {
    jest.resetModules();
    jest.doMock('@/config', () => ({
      config: {
        oneSignal: {
          appId: 'test-app-id',
          restApiKey: 'os_v2_app_testkey',
          apiUrl,
        },
      },
    }));
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- re-import after jest.resetModules()
    const service = require('@/services/push.service');
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- same module registry as the service
    const moduleDb = require('@/lib/prisma').default;
    return { service, db: moduleDb };
  };

  it('uses the Key scheme on api.onesignal.com even when the env still points at the v1 URL', async () => {
    const { service, db: moduleDb } = loadWithAppApiKey();
    (moduleDb.user.findUnique as jest.Mock).mockResolvedValue(deviceOwner());
    mockSuccessResponse({ id: 'notification-123' });

    const result = await service.sendPushToUser(mockUserId, { title: 'T', message: 'M' });

    expect(result).toEqual({ success: true, messageId: 'notification-123' });
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.onesignal.com/notifications');
    expect(init.headers.Authorization).toBe('Key os_v2_app_testkey');
    const body = JSON.parse(init.body);
    expect(body.include_subscription_ids).toEqual([mockPlayerId]);
    expect(body.include_player_ids).toBeUndefined();
  });

  it('targets external IDs with include_aliases', async () => {
    const { service } = loadWithAppApiKey();
    mockSuccessResponse();

    await service.sendPushByExternalIds(['user-id-1'], { title: 'T', message: 'M' });

    const body = sentBody();
    expect(body.include_aliases).toEqual({ external_id: ['user-id-1'] });
    expect(body.target_channel).toBe('push');
    expect(body.include_external_user_ids).toBeUndefined();
  });

  it('skips the legacy /players call when registering a device', async () => {
    const { service, db: moduleDb } = loadWithAppApiKey();
    (moduleDb.user.findMany as jest.Mock).mockResolvedValue([]);
    (moduleDb.user.findUnique as jest.Mock).mockResolvedValue(accountWith());
    (moduleDb.user.update as jest.Mock).mockResolvedValue({ ...mockUser, pushEnabled: true });

    const result = await service.registerPushToken(mockUserId, mockPlayerId);

    expect(result.success).toBe(true);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('reports failure when OneSignal returns 200 without targeting anyone', async () => {
    const { service, db: moduleDb } = loadWithAppApiKey();
    (moduleDb.user.findUnique as jest.Mock).mockResolvedValue(deviceOwner());
    mockSuccessResponse({ id: '', errors: ['All included players are not subscribed'] });

    const result = await service.sendPushToUser(mockUserId, { title: 'T', message: 'M' });

    expect(result).toEqual({
      success: false,
      errors: ['All included players are not subscribed'],
    });
  });
});
