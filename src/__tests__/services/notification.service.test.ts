/**
 * Notification Service Tests
 *
 * Covers:
 *   - every notification created, alone or in bulk, reaches its user's socket
 *     as notification:new, and a failed emit doesn't lose the notification
 *   - bulk notifications get their IDs up front and return them by user
 *   - a helper exists for every notification type other areas create
 *   - broadcasts and announcements are checked before the shared daily cap
 *     is counted: text, target, metadata, unknown roles and roles the admin
 *     can't reach
 *   - announcements reach only the roles the admin can reach, never banned
 *     accounts
 */

jest.mock('@/lib/prisma', () => ({
  __esModule: true,
  default: {
    notification: { create: jest.fn(), createMany: jest.fn() },
    user: { findMany: jest.fn() },
    serviceProvider: { findMany: jest.fn() },
  },
}));

jest.mock('@/lib/socket', () => ({ emitToUser: jest.fn() }));
jest.mock('@/services/push.service', () => ({ sendPushToUsers: jest.fn() }));
jest.mock('@/lib/redis', () => ({ rateLimit: { check: jest.fn() } }));

import prisma from '@/lib/prisma';
import { emitToUser } from '@/lib/socket';
import { sendPushToUsers } from '@/services/push.service';
import { rateLimit } from '@/lib/redis';
import {
  createBulkNotifications,
  createNotification,
  notifyBookingCreated,
  notifyDisputeUpdated,
  notifyReviewReceived,
  notifyReviewResponse,
  notifyServiceApproved,
  notifyServiceRejected,
  notifyServiceSuspended,
  notifyVerificationApproved,
  notifyVerificationRejected,
  prepareBroadcast,
  sendAdminAnnouncement,
  sendAdminBroadcast,
  sendSystemAnnouncement,
  type BroadcastInput,
} from '@/services/notification.service';

const db = prisma as unknown as Record<string, Record<string, jest.Mock>>;
const checkRateLimit = rateLimit.check as jest.Mock;

const now = new Date('2026-09-12T10:00:00.000Z');
const USERS_AND_PROVIDERS = ['SERVICE_USER', 'SERVICE_PROVIDER'];
const notBannedFilter = {
  OR: [
    { bannedAt: null },
    { bannedAt: { isSet: false } },
    { bannedUntil: { isSet: true, not: null, lte: expect.any(Date) } },
  ],
};

beforeEach(() => {
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  db.notification.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: '66e2a0c0f0a9d83b5c7e0a01',
    createdAt: now,
    entityType: null,
    entityId: null,
    ...data,
  }));
  db.notification.createMany.mockImplementation(async ({ data }: { data: unknown[] }) => ({
    count: data.length,
  }));
  db.user.findMany.mockResolvedValue([]);
  db.serviceProvider.findMany.mockResolvedValue([]);
  (emitToUser as jest.Mock).mockResolvedValue(undefined);
  (sendPushToUsers as jest.Mock).mockResolvedValue({ success: true, messageId: 'push-1' });
  checkRateLimit.mockResolvedValue({ allowed: true, remaining: 49, resetIn: 86400 });
});

// ==================
// Real-time delivery
// ==================

describe('createNotification', () => {
  it('saves the notification and sends it to the user as notification:new', async () => {
    const result = await createNotification({
      userId: 'user-1',
      type: 'BOOKING_ACCEPTED',
      title: 'Booking Accepted',
      message: 'Ada has accepted your booking for Deep Cleaning',
      entityType: 'booking',
      entityId: '66e2a0c0f0a9d83b5c7e0b01',
      metadata: { bookingId: '66e2a0c0f0a9d83b5c7e0b01' },
    });

    expect(result).toMatchObject({ id: '66e2a0c0f0a9d83b5c7e0a01' });
    expect(emitToUser).toHaveBeenCalledTimes(1);
    expect(emitToUser).toHaveBeenCalledWith('user-1', 'notification:new', {
      id: '66e2a0c0f0a9d83b5c7e0a01',
      type: 'BOOKING_ACCEPTED',
      title: 'Booking Accepted',
      message: 'Ada has accepted your booking for Deep Cleaning',
      entityType: 'booking',
      entityId: '66e2a0c0f0a9d83b5c7e0b01',
      metadata: { bookingId: '66e2a0c0f0a9d83b5c7e0b01' },
      createdAt: '2026-09-12T10:00:00.000Z',
    });
  });

  it('sends null entity and metadata when the notification has none', async () => {
    await createNotification({ userId: 'user-1', type: 'ACCOUNT_ACTIVATED', title: 'T', message: 'M' });

    expect(emitToUser).toHaveBeenCalledWith(
      'user-1',
      'notification:new',
      expect.objectContaining({ entityType: null, entityId: null, metadata: null })
    );
  });

  it('still returns the notification when the socket emit fails', async () => {
    (emitToUser as jest.Mock).mockRejectedValue(new Error('Redis unavailable'));

    await expect(
      createNotification({ userId: 'user-1', type: 'NEW_MESSAGE', title: 'New Message', message: 'Hi' })
    ).resolves.toMatchObject({ id: '66e2a0c0f0a9d83b5c7e0a01' });
  });
});

describe('createBulkNotifications', () => {
  it('gives each notification an ObjectId, returns them by user and emits each one', async () => {
    const result = await createBulkNotifications(
      ['user-1', 'user-2'],
      'SYSTEM_ANNOUNCEMENT',
      'Update on your report',
      "We've reviewed your report and taken action.",
      'report',
      '66e2a0c0f0a9d83b5c7e0c01',
      { reportId: '66e2a0c0f0a9d83b5c7e0c01' }
    );

    const rows = db.notification.createMany.mock.calls[0][0].data as { id: string; createdAt: Date }[];
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.id).toMatch(/^[0-9a-f]{24}$/);
    expect(rows[0].id).not.toBe(rows[1].id);

    expect(result).toEqual({
      count: 2,
      notificationIds: { 'user-1': rows[0].id, 'user-2': rows[1].id },
    });

    expect(emitToUser).toHaveBeenCalledTimes(2);
    expect(emitToUser).toHaveBeenCalledWith('user-2', 'notification:new', {
      id: rows[1].id,
      type: 'SYSTEM_ANNOUNCEMENT',
      title: 'Update on your report',
      message: "We've reviewed your report and taken action.",
      entityType: 'report',
      entityId: '66e2a0c0f0a9d83b5c7e0c01',
      metadata: { reportId: '66e2a0c0f0a9d83b5c7e0c01' },
      createdAt: rows[1].createdAt.toISOString(),
    });
  });

  it('writes and sends nothing for an empty list', async () => {
    await expect(createBulkNotifications([], 'SYSTEM_ANNOUNCEMENT', 'T', 'M')).resolves.toEqual({
      count: 0,
      notificationIds: {},
    });
    expect(db.notification.createMany).not.toHaveBeenCalled();
    expect(emitToUser).not.toHaveBeenCalled();
  });
});

// ==================
// Helpers for each notification type
// ==================

describe('notification helpers', () => {
  it.each<[string, () => Promise<unknown>, Record<string, unknown>]>([
    [
      'notifyBookingCreated',
      () => notifyBookingCreated('user-1', 'booking-1', 'Deep Cleaning', 'Chi Eze'),
      { type: 'BOOKING_CREATED', entityType: 'booking', entityId: 'booking-1' },
    ],
    [
      'notifyReviewReceived',
      () => notifyReviewReceived('user-1', 'review-1', 5, 'Chi Eze'),
      { type: 'REVIEW_RECEIVED', entityType: 'review', entityId: 'review-1' },
    ],
    [
      'notifyReviewResponse',
      () => notifyReviewResponse('user-1', 'review-1', 'Ada Cleaning'),
      { type: 'REVIEW_RESPONSE', entityType: 'review', entityId: 'review-1' },
    ],
    [
      'notifyVerificationApproved',
      () => notifyVerificationApproved('user-1', 'provider-1'),
      { type: 'VERIFICATION_APPROVED', entityType: 'provider', entityId: 'provider-1' },
    ],
    [
      'notifyVerificationRejected',
      () => notifyVerificationRejected('user-1', 'The ID photo is unreadable', 'provider-1'),
      {
        type: 'VERIFICATION_REJECTED',
        entityType: 'provider',
        entityId: 'provider-1',
        message: 'Your verification was rejected: The ID photo is unreadable',
      },
    ],
    [
      'notifyServiceApproved',
      () => notifyServiceApproved('user-1', 'service-1', 'Deep Cleaning'),
      { type: 'SERVICE_APPROVED', entityType: 'service', entityId: 'service-1' },
    ],
    [
      'notifyServiceRejected',
      () => notifyServiceRejected('user-1', 'service-1', 'Deep Cleaning', 'Add photos'),
      { type: 'SERVICE_REJECTED', entityType: 'service', entityId: 'service-1' },
    ],
    [
      'notifyServiceSuspended',
      () => notifyServiceSuspended('user-1', 'service-1', 'Deep Cleaning', 'Reported by customers'),
      {
        type: 'SERVICE_SUSPENDED',
        entityType: 'service',
        entityId: 'service-1',
        message: 'Your service "Deep Cleaning" has been suspended: Reported by customers',
      },
    ],
    [
      'notifyDisputeUpdated',
      () => notifyDisputeUpdated('user-1', 'dispute-1', 'An admin is now reviewing your dispute', 'booking-1'),
      {
        type: 'DISPUTE_UPDATED',
        title: 'Dispute Updated',
        message: 'An admin is now reviewing your dispute',
        entityType: 'dispute',
        entityId: 'dispute-1',
        metadata: JSON.stringify({ bookingId: 'booking-1' }),
      },
    ],
  ])('%s creates the notification for its type', async (_name, notify, expected) => {
    await notify();

    expect(db.notification.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ userId: 'user-1', ...expected }),
    });
    expect(emitToUser).toHaveBeenCalledWith('user-1', 'notification:new', expect.objectContaining({ type: expected.type }));
  });
});

// ==================
// Broadcast checks and the shared daily cap
// ==================

const broadcastInput = (overrides: Partial<BroadcastInput> = {}): BroadcastInput => ({
  title: 'Scheduled maintenance',
  message: 'Easykonnet will be unavailable on Sunday from 1am to 3am.',
  target: { mode: 'ALL' },
  ...overrides,
});

describe('prepareBroadcast', () => {
  it('returns the trimmed text, the target and the parsed metadata', () => {
    expect(
      prepareBroadcast(
        broadcastInput({
          title: '  Scheduled maintenance ',
          target: { mode: 'ROLE', roles: ['SERVICE_PROVIDER'] },
          metadataJson: '{"screen":"status"}',
        }),
        USERS_AND_PROVIDERS
      )
    ).toEqual({
      title: 'Scheduled maintenance',
      message: 'Easykonnet will be unavailable on Sunday from 1am to 3am.',
      target: { mode: 'ROLE', roles: ['SERVICE_PROVIDER'] },
      metadata: { screen: 'status' },
    });
  });

  it.each<[string, Partial<BroadcastInput>, string, string]>([
    ['a blank title', { title: '   ' }, 'INVALID_INPUT', 'Title is required'],
    ['a long title', { title: 'a'.repeat(101) }, 'INVALID_INPUT', 'Title can be at most 100 characters'],
    ['a blank message', { message: '' }, 'INVALID_INPUT', 'Message is required'],
    ['a long message', { message: 'a'.repeat(1001) }, 'INVALID_INPUT', 'Message can be at most 1000 characters'],
    [
      'an empty userIds list',
      { target: { mode: 'USER_IDS', userIds: [] } },
      'INVALID_INPUT',
      'USER_IDS target requires a non-empty userIds list',
    ],
    [
      'a misspelt role',
      { target: { mode: 'ROLE', roles: ['SERVICE_USER', 'PROVIDERS'] } },
      'INVALID_INPUT',
      'Unknown role(s): PROVIDERS. Use SERVICE_USER, SERVICE_PROVIDER, ADMIN or SUPER_ADMIN',
    ],
    [
      'a role the admin cannot reach',
      { target: { mode: 'ROLE', roles: ['ADMIN'] } },
      'FORBIDDEN',
      'You are not authorised to broadcast to role(s): ADMIN',
    ],
    [
      'metadata that is not an object',
      { metadataJson: '[1, 2]' },
      'INVALID_INPUT',
      'metadataJson is not valid JSON: metadataJson must encode a JSON object',
    ],
  ])('refuses %s', (_name, overrides, code, message) => {
    expect(() => prepareBroadcast(broadcastInput(overrides), USERS_AND_PROVIDERS)).toThrow(
      expect.objectContaining({ message, extensions: expect.objectContaining({ code }) })
    );
  });
});

describe('sendAdminBroadcast', () => {
  it('checks the input before anything counts towards the cap', async () => {
    await expect(
      sendAdminBroadcast('admin-1', broadcastInput({ title: '' }), USERS_AND_PROVIDERS)
    ).rejects.toMatchObject({ extensions: { code: 'INVALID_INPUT' } });

    expect(checkRateLimit).not.toHaveBeenCalled();
    expect(db.user.findMany).not.toHaveBeenCalled();
  });

  it('counts both broadcast mutations against one cap per admin', async () => {
    await sendAdminBroadcast('admin-1', broadcastInput(), USERS_AND_PROVIDERS);
    await sendAdminBroadcast('admin-1', broadcastInput(), [...USERS_AND_PROVIDERS, 'ADMIN']);

    expect(checkRateLimit).toHaveBeenCalledTimes(2);
    expect(checkRateLimit).toHaveBeenNthCalledWith(1, 'broadcast:admin-1', 50, 86400);
    expect(checkRateLimit).toHaveBeenNthCalledWith(2, 'broadcast:admin-1', 50, 86400);
  });

  it('refuses with RATE_LIMITED once the cap is reached, sending nothing', async () => {
    checkRateLimit.mockResolvedValue({ allowed: false, remaining: 0, resetIn: 120 });

    await expect(
      sendAdminBroadcast('admin-1', broadcastInput(), USERS_AND_PROVIDERS)
    ).rejects.toMatchObject({
      message: 'Broadcast rate limit reached (50/day). Resets in 120s.',
      extensions: { code: 'RATE_LIMITED' },
    });
    expect(db.user.findMany).not.toHaveBeenCalled();
    expect(db.notification.createMany).not.toHaveBeenCalled();
    expect(sendPushToUsers).not.toHaveBeenCalled();
  });

  it('sends the trimmed text to the resolved recipients', async () => {
    db.user.findMany.mockResolvedValue([{ id: 'user-1' }]);

    await expect(
      sendAdminBroadcast('admin-1', broadcastInput({ title: ' Maintenance ' }), USERS_AND_PROVIDERS)
    ).resolves.toMatchObject({ recipientCount: 1, inAppCreated: 1, pushDelivery: 'sent' });

    expect(db.notification.createMany.mock.calls[0][0].data[0]).toMatchObject({ title: 'Maintenance' });
  });
});

describe('announcements', () => {
  it('reach active, unbanned customers and providers when an admin names no roles', async () => {
    db.user.findMany.mockResolvedValue([{ id: 'user-1' }, { id: 'user-2' }]);

    await expect(
      sendAdminAnnouncement('admin-1', 'ADMIN', { title: 'Maintenance', message: 'Down on Sunday' })
    ).resolves.toMatchObject({ count: 2 });

    expect(checkRateLimit).toHaveBeenCalledWith('broadcast:admin-1', 50, 86400);
    expect(db.user.findMany).toHaveBeenCalledWith({
      where: { status: 'ACTIVE', role: { in: USERS_AND_PROVIDERS }, ...notBannedFilter },
      select: { id: true },
    });
    expect(db.notification.createMany.mock.calls[0][0].data[0]).toMatchObject({
      userId: 'user-1',
      type: 'SYSTEM_ANNOUNCEMENT',
      title: 'Maintenance',
      message: 'Down on Sunday',
    });
  });

  it.each([['ADMIN'], ['SUPER_ADMIN']])(
    'refuses an admin targeting %s accounts, before counting it',
    async (role) => {
      await expect(
        sendAdminAnnouncement('admin-1', 'ADMIN', { title: 'T', message: 'M', targetRoles: [role] })
      ).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });

      expect(checkRateLimit).not.toHaveBeenCalled();
      expect(db.user.findMany).not.toHaveBeenCalled();
    }
  );

  it('lets a super admin reach admins, but not super admins', async () => {
    await sendAdminAnnouncement('super-1', 'SUPER_ADMIN', { title: 'T', message: 'M', targetRoles: ['ADMIN'] });
    expect(db.user.findMany.mock.calls[0][0].where.role).toEqual({ in: ['ADMIN'] });

    await expect(
      sendAdminAnnouncement('super-1', 'SUPER_ADMIN', { title: 'T', message: 'M', targetRoles: ['SUPER_ADMIN'] })
    ).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
  });

  it('refuses blank text before counting it', async () => {
    await expect(
      sendAdminAnnouncement('admin-1', 'ADMIN', { title: 'Maintenance', message: '  ' })
    ).rejects.toMatchObject({ message: 'Message is required', extensions: { code: 'INVALID_INPUT' } });
    expect(checkRateLimit).not.toHaveBeenCalled();
  });

  it('writes nothing when no account matches', async () => {
    await expect(sendSystemAnnouncement('T', 'M', ['SERVICE_PROVIDER'])).resolves.toEqual({
      count: 0,
      notificationIds: {},
    });
    expect(db.notification.createMany).not.toHaveBeenCalled();
  });
});
