/**
 * Push Notification Service Tests
 * Tests OneSignal push notification functionality
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
  sendVerificationPush,
} from '@/services/push.service';

// ==================
// Test Data
// ==================

const mockUserId = '507f1f77bcf86cd799439011';
const mockPlayerId = 'onesignal-player-id-123';
const mockUser = {
  id: mockUserId,
  email: 'test@example.com',
  oneSignalPlayerId: mockPlayerId,
  pushEnabled: true,
};

// ==================
// Helper Functions
// ==================

const mockSuccessResponse = (data: any = { id: 'notification-id-123' }) => {
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

// ==================
// Test Setup
// ==================

beforeEach(() => {
  jest.clearAllMocks();
  mockFetch.mockClear();
});

// ==================
// registerPushToken Tests
// ==================

describe('registerPushToken', () => {
  it('should register a new push token for a user', async () => {
    (prisma.user.findFirst as jest.Mock).mockResolvedValue(null);
    (prisma.user.update as jest.Mock).mockResolvedValue({
      ...mockUser,
      oneSignalPlayerId: mockPlayerId,
      pushEnabled: true,
    });
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
  });

  it('should remove player ID from another user if already registered', async () => {
    const otherUserId = '507f1f77bcf86cd799439022';
    (prisma.user.findFirst as jest.Mock).mockResolvedValue({
      id: otherUserId,
      oneSignalPlayerId: mockPlayerId,
    });
    (prisma.user.update as jest.Mock)
      .mockResolvedValueOnce({ id: otherUserId }) // First call to remove from other user
      .mockResolvedValueOnce({ // Second call to add to current user
        ...mockUser,
        oneSignalPlayerId: mockPlayerId,
        pushEnabled: true,
      });
    mockSuccessResponse();

    const result = await registerPushToken(mockUserId, mockPlayerId);

    expect(result.success).toBe(true);
    expect(prisma.user.update).toHaveBeenCalledTimes(2);
    // First call removes from other user
    expect(prisma.user.update).toHaveBeenNthCalledWith(1, {
      where: { id: otherUserId },
      data: { oneSignalPlayerId: null },
    });
  });

  it('should still succeed if OneSignal API fails', async () => {
    (prisma.user.findFirst as jest.Mock).mockResolvedValue(null);
    (prisma.user.update as jest.Mock).mockResolvedValue({
      ...mockUser,
      pushEnabled: true,
    });
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
  it('should unregister push token for a user', async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue({
      oneSignalPlayerId: mockPlayerId,
    });
    (prisma.user.update as jest.Mock).mockResolvedValue({
      ...mockUser,
      oneSignalPlayerId: null,
      pushEnabled: false,
    });
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
        pushEnabled: false,
      },
    });
  });

  it('should still succeed if user has no player ID', async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue({
      oneSignalPlayerId: null,
    });
    (prisma.user.update as jest.Mock).mockResolvedValue({
      ...mockUser,
      oneSignalPlayerId: null,
      pushEnabled: false,
    });

    const result = await unregisterPushToken(mockUserId);
    expect(result.success).toBe(true);
  });

  it('should still succeed if OneSignal API fails', async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue({
      oneSignalPlayerId: mockPlayerId,
    });
    (prisma.user.update as jest.Mock).mockResolvedValue({
      oneSignalPlayerId: null,
      pushEnabled: false,
    });
    mockErrorResponse();

    const result = await unregisterPushToken(mockUserId);
    expect(result.success).toBe(true);
  });
});

// ==================
// updatePushPreference Tests
// ==================

describe('updatePushPreference', () => {
  it('should enable push notifications', async () => {
    (prisma.user.update as jest.Mock).mockResolvedValue({
      ...mockUser,
      pushEnabled: true,
    });

    const result = await updatePushPreference(mockUserId, true);

    expect(result).toEqual({
      success: true,
      message: 'Push notifications enabled',
      pushEnabled: true,
    });
  });

  it('should disable push notifications', async () => {
    (prisma.user.update as jest.Mock).mockResolvedValue({
      ...mockUser,
      pushEnabled: false,
    });

    const result = await updatePushPreference(mockUserId, false);

    expect(result).toEqual({
      success: true,
      message: 'Push notifications disabled',
      pushEnabled: false,
    });
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
    (prisma.user.findUnique as jest.Mock).mockResolvedValue({
      oneSignalPlayerId: mockPlayerId,
      pushEnabled: true,
    });
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
  });

  it('should return error if user has no registered device', async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue({
      oneSignalPlayerId: null,
      pushEnabled: true,
    });

    const result = await sendPushToUser(mockUserId, pushOptions);

    expect(result).toEqual({
      success: false,
      errors: ['User has no registered device'],
    });
  });

  it('should return error if user has push disabled', async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue({
      oneSignalPlayerId: mockPlayerId,
      pushEnabled: false,
    });

    const result = await sendPushToUser(mockUserId, pushOptions);

    expect(result).toEqual({
      success: false,
      errors: ['User has disabled push notifications'],
    });
  });

  it('should include optional data in push notification', async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue({
      oneSignalPlayerId: mockPlayerId,
      pushEnabled: true,
    });
    mockSuccessResponse();

    await sendPushToUser(mockUserId, {
      ...pushOptions,
      data: { key: 'value' },
      url: 'https://example.com',
    });

    const fetchCall = mockFetch.mock.calls[0];
    const body = JSON.parse(fetchCall[1].body);
    expect(body.data).toEqual({ key: 'value' });
    expect(body.url).toBe('https://example.com');
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
    (prisma.user.findMany as jest.Mock).mockResolvedValue([
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
    (prisma.user.findMany as jest.Mock).mockResolvedValue([]);

    const result = await sendPushToUsers(['user1', 'user2'], pushOptions);

    expect(result).toEqual({
      success: false,
      errors: ['No users with push notifications enabled'],
    });
  });

  it('should filter out users without player IDs', async () => {
    (prisma.user.findMany as jest.Mock).mockResolvedValue([
      { oneSignalPlayerId: 'player1' },
      { oneSignalPlayerId: null },
    ]);
    mockSuccessResponse();

    await sendPushToUsers(['user1', 'user2'], pushOptions);

    const fetchCall = mockFetch.mock.calls[0];
    const body = JSON.parse(fetchCall[1].body);
    expect(body.include_player_ids).toEqual(['player1']);
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

    const fetchCall = mockFetch.mock.calls[0];
    const body = JSON.parse(fetchCall[1].body);
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

    const fetchCall = mockFetch.mock.calls[0];
    const body = JSON.parse(fetchCall[1].body);
    expect(body.included_segments).toEqual(['All']);
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
    (prisma.user.findUnique as jest.Mock).mockResolvedValue({
      oneSignalPlayerId: mockPlayerId,
      pushEnabled: true,
    });
    mockSuccessResponse();
  });

  it('should send new booking notification', async () => {
    await sendBookingPush(mockUserId, 'new', 'booking-123', 'House Cleaning');

    const fetchCall = mockFetch.mock.calls[0];
    const body = JSON.parse(fetchCall[1].body);
    expect(body.headings.en).toBe('New Booking Request');
    expect(body.contents.en).toContain('House Cleaning');
    expect(body.data.type).toBe('BOOKING');
    expect(body.data.bookingId).toBe('booking-123');
    expect(body.data.action).toBe('new');
  });

  it('should send accepted booking notification', async () => {
    await sendBookingPush(mockUserId, 'accepted', 'booking-123', 'Plumbing');

    const fetchCall = mockFetch.mock.calls[0];
    const body = JSON.parse(fetchCall[1].body);
    expect(body.headings.en).toBe('Booking Accepted! 🎉');
    expect(body.contents.en).toContain('Plumbing');
  });

  it('should send rejected booking notification', async () => {
    await sendBookingPush(mockUserId, 'rejected', 'booking-123', 'Gardening');

    const fetchCall = mockFetch.mock.calls[0];
    const body = JSON.parse(fetchCall[1].body);
    expect(body.headings.en).toBe('Booking Update');
  });

  it('should send completed booking notification', async () => {
    await sendBookingPush(mockUserId, 'completed', 'booking-123', 'Electrical');

    const fetchCall = mockFetch.mock.calls[0];
    const body = JSON.parse(fetchCall[1].body);
    expect(body.headings.en).toBe('Booking Completed');
    expect(body.contents.en).toContain('Leave a review');
  });

  it('should send cancelled booking notification', async () => {
    await sendBookingPush(mockUserId, 'cancelled', 'booking-123', 'Carpentry');

    const fetchCall = mockFetch.mock.calls[0];
    const body = JSON.parse(fetchCall[1].body);
    expect(body.headings.en).toBe('Booking Cancelled');
  });
});

describe('sendMessagePush', () => {
  beforeEach(() => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue({
      oneSignalPlayerId: mockPlayerId,
      pushEnabled: true,
    });
    mockSuccessResponse();
  });

  it('should send message notification', async () => {
    await sendMessagePush(mockUserId, 'John Doe', 'Hello!', 'conv-123');

    const fetchCall = mockFetch.mock.calls[0];
    const body = JSON.parse(fetchCall[1].body);
    expect(body.headings.en).toBe('New message from John Doe');
    expect(body.contents.en).toBe('Hello!');
    expect(body.data.type).toBe('MESSAGE');
    expect(body.data.conversationId).toBe('conv-123');
  });

  it('should truncate long messages', async () => {
    const longMessage = 'A'.repeat(100);
    await sendMessagePush(mockUserId, 'Jane', longMessage, 'conv-456');

    const fetchCall = mockFetch.mock.calls[0];
    const body = JSON.parse(fetchCall[1].body);
    expect(body.contents.en).toHaveLength(53); // 50 chars + '...'
    expect(body.contents.en.endsWith('...')).toBe(true);
  });
});

describe('sendReviewPush', () => {
  beforeEach(() => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue({
      oneSignalPlayerId: mockPlayerId,
      pushEnabled: true,
    });
    mockSuccessResponse();
  });

  it('should send review notification', async () => {
    await sendReviewPush(mockUserId, 'Alice', 5, 'Cleaning Service');

    const fetchCall = mockFetch.mock.calls[0];
    const body = JSON.parse(fetchCall[1].body);
    expect(body.headings.en).toBe('New Review Received ⭐');
    expect(body.contents.en).toContain('Alice');
    expect(body.contents.en).toContain('5-star');
    expect(body.contents.en).toContain('Cleaning Service');
    expect(body.data.type).toBe('REVIEW');
  });
});

describe('sendVerificationPush', () => {
  beforeEach(() => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue({
      oneSignalPlayerId: mockPlayerId,
      pushEnabled: true,
    });
    mockSuccessResponse();
  });

  it('should send approved verification notification', async () => {
    await sendVerificationPush(mockUserId, 'approved');

    const fetchCall = mockFetch.mock.calls[0];
    const body = JSON.parse(fetchCall[1].body);
    expect(body.headings.en).toBe('Verification Approved! 🎉');
    expect(body.contents.en).toContain('verified');
    expect(body.data.type).toBe('VERIFICATION');
    expect(body.data.status).toBe('approved');
  });

  it('should send rejected verification notification', async () => {
    await sendVerificationPush(mockUserId, 'rejected', 'Missing documents');

    const fetchCall = mockFetch.mock.calls[0];
    const body = JSON.parse(fetchCall[1].body);
    expect(body.headings.en).toBe('Verification Update');
    expect(body.contents.en).toContain('Missing documents');
    expect(body.data.status).toBe('rejected');
  });

  it('should use default message if no reason provided', async () => {
    await sendVerificationPush(mockUserId, 'rejected');

    const fetchCall = mockFetch.mock.calls[0];
    const body = JSON.parse(fetchCall[1].body);
    expect(body.contents.en).toContain('Please check the app for details');
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
