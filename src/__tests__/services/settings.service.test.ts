/**
 * Settings Service Tests
 * Tests for push notification controls and account settings management
 */

import { GraphQLError } from 'graphql';

// ==================
// Mocks
// ==================

jest.mock('@/lib/prisma', () => ({
  __esModule: true,
  default: {
    user: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
    },
    userSettings: {
      upsert: jest.fn(),
    },
  },
}));

// Mock push.service — settings.service delegates to it
jest.mock('@/services/push.service', () => ({
  registerPushToken: jest.fn(),
  unregisterPushToken: jest.fn(),
  updatePushPreference: jest.fn(),
}));

import prisma from '@/lib/prisma';
import {
  registerPushToken,
  unregisterPushToken,
  updatePushPreference,
} from '@/services/push.service';

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

// ==================
// Test Data
// ==================

const userId = '507f1f77bcf86cd799439011';
const playerId = 'onesignal-player-abc123';

const mockUser = {
  id: userId,
  pushEnabled: true,
  oneSignalPlayerId: playerId,
  status: 'ACTIVE',
};

const mockUserNoPush = {
  ...mockUser,
  pushEnabled: false,
  oneSignalPlayerId: null,
};

const mockSettings = {
  id: 'settings1',
  userId,
  notifyBookingUpdates: true,
  notifyMessages: true,
  notifyReviews: true,
  notifyPromotions: false,
  notifyDisputeUpdates: true,
  notifyProviderVerification: true,
  emailBookingUpdates: true,
  emailMessages: false,
  emailReviews: true,
  emailPromotions: false,
  emailNewsletters: false,
  language: 'en',
  timezone: 'Africa/Lagos',
  currency: 'NGN',
  showProfileToPublic: true,
  showPhoneToProviders: false,
  createdAt: new Date('2025-01-01T00:00:00.000Z'),
  updatedAt: new Date('2025-01-15T10:00:00.000Z'),
};

const pushResult = {
  success: true,
  message: 'Push notifications enabled successfully',
  pushEnabled: true,
};

// ==================
// getPushStatus
// ==================

describe('getPushStatus', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns pushEnabled true and hasDeviceRegistered true when registered', async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(mockUser);

    const result = await getPushStatus(userId);

    expect(result.pushEnabled).toBe(true);
    expect(result.hasDeviceRegistered).toBe(true);
    expect(result.playerId).toBe(playerId);
  });

  it('returns hasDeviceRegistered false when no player ID', async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(mockUserNoPush);

    const result = await getPushStatus(userId);

    expect(result.pushEnabled).toBe(false);
    expect(result.hasDeviceRegistered).toBe(false);
    expect(result.playerId).toBeNull();
  });

  it('throws NOT_FOUND when user does not exist', async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(null);

    await expect(getPushStatus('nonexistent')).rejects.toThrow(GraphQLError);
    await expect(getPushStatus('nonexistent')).rejects.toMatchObject({
      extensions: { code: 'NOT_FOUND' },
    });
  });
});

// ==================
// enablePushNotifications
// ==================

describe('enablePushNotifications', () => {
  beforeEach(() => jest.clearAllMocks());

  it('calls registerPushToken with userId and playerId', async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(mockUser);
    (registerPushToken as jest.Mock).mockResolvedValue(pushResult);

    const result = await enablePushNotifications(userId, playerId);

    expect(registerPushToken).toHaveBeenCalledWith(userId, playerId);
    expect(result.success).toBe(true);
    expect(result.pushEnabled).toBe(true);
  });

  it('throws NOT_FOUND when user does not exist', async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(null);

    await expect(enablePushNotifications('bad-id', playerId)).rejects.toMatchObject({
      extensions: { code: 'NOT_FOUND' },
    });
    expect(registerPushToken).not.toHaveBeenCalled();
  });
});

// ==================
// disablePushNotifications
// ==================

describe('disablePushNotifications', () => {
  beforeEach(() => jest.clearAllMocks());

  it('calls unregisterPushToken with userId', async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(mockUser);
    (unregisterPushToken as jest.Mock).mockResolvedValue({
      success: true,
      message: 'Push notifications disabled successfully',
      pushEnabled: false,
    });

    const result = await disablePushNotifications(userId);

    expect(unregisterPushToken).toHaveBeenCalledWith(userId);
    expect(result.success).toBe(true);
    expect(result.pushEnabled).toBe(false);
  });

  it('throws NOT_FOUND when user does not exist', async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(null);

    await expect(disablePushNotifications('bad-id')).rejects.toMatchObject({
      extensions: { code: 'NOT_FOUND' },
    });
    expect(unregisterPushToken).not.toHaveBeenCalled();
  });
});

// ==================
// togglePushNotifications
// ==================

describe('togglePushNotifications', () => {
  beforeEach(() => jest.clearAllMocks());

  it('calls updatePushPreference with enabled=true', async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(mockUser);
    (updatePushPreference as jest.Mock).mockResolvedValue({
      success: true,
      message: 'Push notifications enabled',
      pushEnabled: true,
    });

    const result = await togglePushNotifications(userId, true);

    expect(updatePushPreference).toHaveBeenCalledWith(userId, true);
    expect(result.pushEnabled).toBe(true);
  });

  it('calls updatePushPreference with enabled=false', async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(mockUser);
    (updatePushPreference as jest.Mock).mockResolvedValue({
      success: true,
      message: 'Push notifications disabled',
      pushEnabled: false,
    });

    const result = await togglePushNotifications(userId, false);

    expect(updatePushPreference).toHaveBeenCalledWith(userId, false);
    expect(result.pushEnabled).toBe(false);
  });
});

// ==================
// getMySettings
// ==================

describe('getMySettings', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns settings with defaults on first access', async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(mockUser);
    (prisma.userSettings.upsert as jest.Mock).mockResolvedValue(mockSettings);

    const result = await getMySettings(userId);

    expect(result.language).toBe('en');
    expect(result.timezone).toBe('Africa/Lagos');
    expect(result.currency).toBe('NGN');
    expect(result.notifyBookingUpdates).toBe(true);
    expect(result.notifyPromotions).toBe(false);
    expect(result.emailNewsletters).toBe(false);
  });

  it('upserts (creates if missing) settings record', async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(mockUser);
    (prisma.userSettings.upsert as jest.Mock).mockResolvedValue(mockSettings);

    await getMySettings(userId);

    expect(prisma.userSettings.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId } })
    );
  });

  it('throws NOT_FOUND when user does not exist', async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(null);

    await expect(getMySettings(userId)).rejects.toMatchObject({
      extensions: { code: 'NOT_FOUND' },
    });
  });

  it('returns updatedAt as ISO string', async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(mockUser);
    (prisma.userSettings.upsert as jest.Mock).mockResolvedValue(mockSettings);

    const result = await getMySettings(userId);

    expect(result.updatedAt).toBe('2025-01-15T10:00:00.000Z');
  });
});

// ==================
// updateMySettings
// ==================

describe('updateMySettings', () => {
  beforeEach(() => jest.clearAllMocks());

  it('updates provided settings fields', async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(mockUser);
    const updatedSettings = { ...mockSettings, language: 'fr', notifyPromotions: true };
    (prisma.userSettings.upsert as jest.Mock).mockResolvedValue(updatedSettings);

    const result = await updateMySettings(userId, { language: 'fr', notifyPromotions: true });

    expect(result.success).toBe(true);
    expect(result.settings.language).toBe('fr');
    expect(result.settings.notifyPromotions).toBe(true);
  });

  it('returns success message on update', async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(mockUser);
    (prisma.userSettings.upsert as jest.Mock).mockResolvedValue(mockSettings);

    const result = await updateMySettings(userId, { notifyMessages: false });

    expect(result.message).toBe('Settings updated successfully');
  });

  it('rejects invalid language code', async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(mockUser);

    await expect(
      updateMySettings(userId, { language: 'INVALID_LANG' })
    ).rejects.toThrow(GraphQLError);

    await expect(
      updateMySettings(userId, { language: 'INVALID_LANG' })
    ).rejects.toMatchObject({ extensions: { code: 'VALIDATION_ERROR' } });
  });

  it('rejects invalid currency code', async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(mockUser);

    await expect(
      updateMySettings(userId, { currency: 'dollar' })
    ).rejects.toMatchObject({ extensions: { code: 'VALIDATION_ERROR' } });
  });

  it('accepts valid ISO 639-1 language codes', async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(mockUser);
    (prisma.userSettings.upsert as jest.Mock).mockResolvedValue({ ...mockSettings, language: 'fr' });

    // Should not throw
    await expect(updateMySettings(userId, { language: 'fr' })).resolves.toBeTruthy();
  });

  it('accepts valid ISO 4217 currency codes', async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(mockUser);
    (prisma.userSettings.upsert as jest.Mock).mockResolvedValue({ ...mockSettings, currency: 'USD' });

    await expect(updateMySettings(userId, { currency: 'USD' })).resolves.toBeTruthy();
  });

  it('only updates provided fields (strips undefined)', async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(mockUser);
    (prisma.userSettings.upsert as jest.Mock).mockResolvedValue(mockSettings);

    await updateMySettings(userId, { timezone: 'Europe/London' });

    const upsertCall = (prisma.userSettings.upsert as jest.Mock).mock.calls[0][0];
    expect(upsertCall.update).toEqual({ timezone: 'Europe/London' });
    expect(upsertCall.update).not.toHaveProperty('language');
  });

  it('throws NOT_FOUND when user does not exist', async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(null);

    await expect(updateMySettings(userId, {})).rejects.toMatchObject({
      extensions: { code: 'NOT_FOUND' },
    });
  });
});

// ==================
// resetMySettings
// ==================

describe('resetMySettings', () => {
  beforeEach(() => jest.clearAllMocks());

  it('resets all settings to defaults', async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(mockUser);
    (prisma.userSettings.upsert as jest.Mock).mockResolvedValue(mockSettings);

    const result = await resetMySettings(userId);

    expect(result.success).toBe(true);
    expect(result.message).toContain('defaults');
  });

  it('calls upsert with default values', async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(mockUser);
    (prisma.userSettings.upsert as jest.Mock).mockResolvedValue(mockSettings);

    await resetMySettings(userId);

    const upsertCall = (prisma.userSettings.upsert as jest.Mock).mock.calls[0][0];
    expect(upsertCall.update).toMatchObject({
      language: 'en',
      timezone: 'Africa/Lagos',
      currency: 'NGN',
      notifyPromotions: false,
      emailNewsletters: false,
    });
  });
});

// ==================
// deactivateMyAccount
// ==================

describe('deactivateMyAccount', () => {
  beforeEach(() => jest.clearAllMocks());

  it('sets user status to DEACTIVATED', async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(mockUser);
    (prisma.user.update as jest.Mock).mockResolvedValue({ ...mockUser, status: 'DEACTIVATED' });
    (unregisterPushToken as jest.Mock).mockResolvedValue({ success: true, pushEnabled: false });

    const result = await deactivateMyAccount(userId);

    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'DEACTIVATED' } })
    );
    expect(result.success).toBe(true);
  });

  it('also removes push token on deactivation', async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(mockUser);
    (prisma.user.update as jest.Mock).mockResolvedValue({ ...mockUser, status: 'DEACTIVATED' });
    (unregisterPushToken as jest.Mock).mockResolvedValue({ success: true, pushEnabled: false });

    await deactivateMyAccount(userId);

    expect(unregisterPushToken).toHaveBeenCalledWith(userId);
  });

  it('does not fail if push cleanup throws', async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(mockUser);
    (prisma.user.update as jest.Mock).mockResolvedValue({ ...mockUser, status: 'DEACTIVATED' });
    (unregisterPushToken as jest.Mock).mockRejectedValue(new Error('OneSignal down'));

    // Should still resolve successfully
    await expect(deactivateMyAccount(userId)).resolves.toMatchObject({ success: true });
  });

  it('throws NOT_FOUND when user does not exist', async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(null);

    await expect(deactivateMyAccount(userId)).rejects.toMatchObject({
      extensions: { code: 'NOT_FOUND' },
    });
  });
});

// ==================
// reactivateMyAccount
// ==================

describe('reactivateMyAccount', () => {
  beforeEach(() => jest.clearAllMocks());

  it('sets user status back to ACTIVE', async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue({ ...mockUser, status: 'DEACTIVATED' });
    (prisma.user.update as jest.Mock).mockResolvedValue({ ...mockUser, status: 'ACTIVE' });

    const result = await reactivateMyAccount(userId);

    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'ACTIVE' } })
    );
    expect(result.success).toBe(true);
  });

  it('throws BAD_REQUEST if account is not deactivated', async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue({ ...mockUser, status: 'ACTIVE' });

    await expect(reactivateMyAccount(userId)).rejects.toThrow(GraphQLError);
    await expect(reactivateMyAccount(userId)).rejects.toMatchObject({
      extensions: { code: 'BAD_REQUEST' },
    });
  });

  it('throws NOT_FOUND when user does not exist', async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(null);

    await expect(reactivateMyAccount(userId)).rejects.toMatchObject({
      extensions: { code: 'NOT_FOUND' },
    });
  });
});
