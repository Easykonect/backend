/**
 * broadcastNotification — targeting + permission + fan-out tests
 *
 * Covers:
 *   - USER_IDS / ROLE / ALL / LOCATION targeting
 *   - allowedRoles gate (ADMIN can't target ADMIN)
 *   - ACTIVE-status filter (banned users not spammed)
 *   - Fan-out: in-app row, socket emit, push are all called
 *   - Empty recipient set short-circuits cleanly
 */

import { GraphQLError } from 'graphql';

// ==================
// Mocks
// ==================

jest.mock('@/lib/prisma', () => ({
  __esModule: true,
  default: {
    user: { findMany: jest.fn() },
    serviceProvider: { findMany: jest.fn() },
    notification: { createMany: jest.fn() },
  },
}));

jest.mock('@/lib/socket', () => ({
  emitToUser: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/services/push.service', () => ({
  sendPushToUsers: jest.fn().mockResolvedValue({ success: true, messageId: 'msg-1' }),
  sendPushToAll: jest.fn().mockResolvedValue({ success: true, messageId: 'msg-all' }),
}));

import prisma from '@/lib/prisma';
import { emitToUser } from '@/lib/socket';
import { sendPushToUsers, sendPushToAll } from '@/services/push.service';
import { broadcastNotification } from '@/services/notification.service';

const ADMIN_ROLES = ['SERVICE_USER', 'SERVICE_PROVIDER'];
const SUPER_ADMIN_ROLES = ['SERVICE_USER', 'SERVICE_PROVIDER', 'ADMIN'];

beforeEach(() => {
  (prisma.user.findMany as jest.Mock).mockReset();
  (prisma.serviceProvider.findMany as jest.Mock).mockReset();
  (prisma.notification.createMany as jest.Mock).mockReset();
  (emitToUser as jest.Mock).mockClear();
  (sendPushToUsers as jest.Mock).mockClear();
  (sendPushToAll as jest.Mock).mockClear();
  (prisma.notification.createMany as jest.Mock).mockResolvedValue({ count: 0 });
});

// ==================
// USER_IDS mode
// ==================

describe('broadcastNotification — USER_IDS target', () => {
  it('only fans out to users that match the allowedRoles + ACTIVE status', async () => {
    (prisma.user.findMany as jest.Mock).mockResolvedValueOnce([
      { id: 'u1' },
      { id: 'u2' },
    ]);
    (prisma.notification.createMany as jest.Mock).mockResolvedValueOnce({ count: 2 });

    const result = await broadcastNotification({
      title: 'Service update',
      message: 'New release rolling out',
      target: { mode: 'USER_IDS', userIds: ['u1', 'u2', 'u3'] },
      allowedRoles: ADMIN_ROLES,
    });

    expect(result.recipientCount).toBe(2);
    expect(result.inAppCreated).toBe(2);
    expect(result.pushDelivery).toBe('sent');

    // Prisma query restricted by role + status
    const userQuery = (prisma.user.findMany as jest.Mock).mock.calls[0][0];
    expect(userQuery.where.status).toBe('ACTIVE');
    expect(userQuery.where.role.in).toEqual(ADMIN_ROLES);
    expect(userQuery.where.id.in).toEqual(['u1', 'u2', 'u3']);

    // All three channels fired
    expect(prisma.notification.createMany).toHaveBeenCalled();
    expect(emitToUser).toHaveBeenCalledTimes(2);
    expect(sendPushToUsers).toHaveBeenCalledWith(
      ['u1', 'u2'],
      expect.objectContaining({ title: 'Service update' })
    );
  });

  it('rejects an empty userIds list', async () => {
    await expect(
      broadcastNotification({
        title: 't',
        message: 'm',
        target: { mode: 'USER_IDS', userIds: [] },
        allowedRoles: ADMIN_ROLES,
      })
    ).rejects.toThrow(/At least one userId is required/);
  });

  it('returns no_recipients when none of the requested IDs match active+role', async () => {
    (prisma.user.findMany as jest.Mock).mockResolvedValueOnce([]);

    const result = await broadcastNotification({
      title: 't',
      message: 'm',
      target: { mode: 'USER_IDS', userIds: ['banned-user-id'] },
      allowedRoles: ADMIN_ROLES,
    });

    expect(result.recipientCount).toBe(0);
    expect(result.pushDelivery).toBe('no_recipients');
    expect(prisma.notification.createMany).not.toHaveBeenCalled();
    expect(emitToUser).not.toHaveBeenCalled();
    expect(sendPushToUsers).not.toHaveBeenCalled();
  });
});

// ==================
// ROLE mode + permission gate
// ==================

describe('broadcastNotification — ROLE target + allowedRoles gate', () => {
  it('allows SUPER_ADMIN to target ADMIN role', async () => {
    (prisma.user.findMany as jest.Mock).mockResolvedValueOnce([{ id: 'a1' }]);
    (prisma.notification.createMany as jest.Mock).mockResolvedValueOnce({ count: 1 });

    const result = await broadcastNotification({
      title: 'Ops update',
      message: 'maintenance window tonight',
      target: { mode: 'ROLE', roles: ['ADMIN'] },
      allowedRoles: SUPER_ADMIN_ROLES,
    });

    expect(result.recipientCount).toBe(1);
    const userQuery = (prisma.user.findMany as jest.Mock).mock.calls[0][0];
    expect(userQuery.where.role.in).toEqual(['ADMIN']);
  });

  it('blocks ADMIN from targeting the ADMIN role', async () => {
    let caught: GraphQLError | undefined;
    await broadcastNotification({
      title: 't',
      message: 'm',
      target: { mode: 'ROLE', roles: ['ADMIN'] },
      allowedRoles: ADMIN_ROLES,
    }).catch((e) => (caught = e));

    expect(caught).toBeInstanceOf(GraphQLError);
    expect(caught!.extensions.code).toBe('FORBIDDEN');
    expect(prisma.user.findMany).not.toHaveBeenCalled();
  });

  it('blocks ADMIN from targeting SUPER_ADMIN even if mixed with allowed roles', async () => {
    let caught: GraphQLError | undefined;
    await broadcastNotification({
      title: 't',
      message: 'm',
      target: { mode: 'ROLE', roles: ['SERVICE_USER', 'SUPER_ADMIN'] },
      allowedRoles: ADMIN_ROLES,
    }).catch((e) => (caught = e));

    expect(caught!.extensions.code).toBe('FORBIDDEN');
    expect(caught!.message).toMatch(/SUPER_ADMIN/);
  });
});

// ==================
// ALL mode
// ==================

describe('broadcastNotification — ALL target', () => {
  it('uses sendPushToAll segment when broadcasting across the full allowedRoles set', async () => {
    (prisma.user.findMany as jest.Mock).mockResolvedValueOnce([
      { id: 'u1' },
      { id: 'u2' },
      { id: 'a1' },
    ]);
    (prisma.notification.createMany as jest.Mock).mockResolvedValueOnce({ count: 3 });

    await broadcastNotification({
      title: 'Announcement',
      message: 'big news',
      target: { mode: 'ALL' },
      allowedRoles: SUPER_ADMIN_ROLES, // length 3 → triggers segment broadcast
    });

    expect(sendPushToAll).toHaveBeenCalled();
    expect(sendPushToUsers).not.toHaveBeenCalled();
  });

  it('uses sendPushToUsers when ADMIN sends ALL (only 2 roles allowed)', async () => {
    (prisma.user.findMany as jest.Mock).mockResolvedValueOnce([
      { id: 'u1' },
      { id: 'u2' },
    ]);
    (prisma.notification.createMany as jest.Mock).mockResolvedValueOnce({ count: 2 });

    await broadcastNotification({
      title: 'Announcement',
      message: 'big news',
      target: { mode: 'ALL' },
      allowedRoles: ADMIN_ROLES, // length 2
    });

    expect(sendPushToUsers).toHaveBeenCalledWith(
      ['u1', 'u2'],
      expect.anything()
    );
    expect(sendPushToAll).not.toHaveBeenCalled();
  });
});

// ==================
// LOCATION mode
// ==================

describe('broadcastNotification — LOCATION target', () => {
  it('rejects when neither city nor state is provided', async () => {
    await expect(
      broadcastNotification({
        title: 't',
        message: 'm',
        target: { mode: 'LOCATION' },
        allowedRoles: ADMIN_ROLES,
      })
    ).rejects.toThrow(/Location target requires city and\/or state/);
  });

  it('queries serviceProvider by city and dispatches to those users', async () => {
    (prisma.serviceProvider.findMany as jest.Mock).mockResolvedValueOnce([
      { userId: 'u1' },
      { userId: 'u2' },
    ]);
    (prisma.notification.createMany as jest.Mock).mockResolvedValueOnce({ count: 2 });

    const result = await broadcastNotification({
      title: 'Lagos meetup',
      message: 'see you Saturday',
      target: { mode: 'LOCATION', city: 'Lagos' },
      allowedRoles: ADMIN_ROLES,
    });

    expect(result.recipientCount).toBe(2);
    const providerQuery = (prisma.serviceProvider.findMany as jest.Mock).mock.calls[0][0];
    expect(providerQuery.where.city.equals).toBe('Lagos');
    expect(providerQuery.where.user.status).toBe('ACTIVE');
  });
});

// ==================
// Fan-out resilience
// ==================

describe('broadcastNotification — fan-out resilience', () => {
  it('reports pushDelivery=failed when OneSignal returns success: false', async () => {
    (prisma.user.findMany as jest.Mock).mockResolvedValueOnce([{ id: 'u1' }]);
    (prisma.notification.createMany as jest.Mock).mockResolvedValueOnce({ count: 1 });
    (sendPushToUsers as jest.Mock).mockResolvedValueOnce({
      success: false,
      errors: ['No subscribers'],
    });

    const result = await broadcastNotification({
      title: 't',
      message: 'm',
      target: { mode: 'USER_IDS', userIds: ['u1'] },
      allowedRoles: ADMIN_ROLES,
    });

    expect(result.pushDelivery).toBe('failed');
    expect(result.pushError).toMatch(/No subscribers/);
    // In-app + socket still fired
    expect(result.inAppCreated).toBe(1);
    expect(emitToUser).toHaveBeenCalled();
  });

  it('reports pushDelivery=failed when sendPushToUsers throws', async () => {
    (prisma.user.findMany as jest.Mock).mockResolvedValueOnce([{ id: 'u1' }]);
    (prisma.notification.createMany as jest.Mock).mockResolvedValueOnce({ count: 1 });
    (sendPushToUsers as jest.Mock).mockRejectedValueOnce(new Error('OneSignal 500'));

    const result = await broadcastNotification({
      title: 't',
      message: 'm',
      target: { mode: 'USER_IDS', userIds: ['u1'] },
      allowedRoles: ADMIN_ROLES,
    });

    expect(result.pushDelivery).toBe('failed');
    expect(result.pushError).toMatch(/OneSignal 500/);
  });
});
