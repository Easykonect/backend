/**
 * Admin management and customer suspension: who can be acted on, and recording
 * who did what, from where and why
 */

jest.mock('@/lib/prisma', () => ({
  __esModule: true,
  default: { user: { findUnique: jest.fn(), update: jest.fn(), create: jest.fn(), delete: jest.fn() } },
}));
// The Resend client throws at import time without an API key
jest.mock('@/lib/email', () => ({
  sendPasswordResetEmail: jest.fn(),
  sendProfileUpdatedEmail: jest.fn(),
  sendEmailChangeOtpEmail: jest.fn(),
}));
jest.mock('@/lib/redis', () => ({ __esModule: true, default: { getInstance: jest.fn() } }));
jest.mock('@/lib/auth', () => ({ ...jest.requireActual('@/lib/auth'), hashPassword: jest.fn() }));
jest.mock('@/services/audit.service', () => ({ createAuditLog: jest.fn() }));
jest.mock('@/services/user-management.service', () => ({ notifyAndPush: jest.fn() }));

import prisma from '@/lib/prisma';
import { hashPassword } from '@/lib/auth';
import { createAuditLog } from '@/services/audit.service';
import { notifyAndPush } from '@/services/user-management.service';
import {
  suspendAdmin,
  createAdmin,
  activateAdmin,
  updateAdminRole,
  deleteAdmin,
  suspendUser,
  activateUser,
} from '@/services/admin.service';

const db = prisma as unknown as { user: Record<string, jest.Mock> };

const SUPER_ADMIN_ID = '66e2b4c1f0a9d83b5c7e1a01';
const ADMIN_ID = '66e2b4c1f0a9d83b5c7e1a02';
const USER_ID = '66e2b4c1f0a9d83b5c7e1a03';
const IP = '102.89.4.7';

const adminRecord = (overrides: Partial<{ id: string; role: string; status: string }> = {}) => ({
  id: ADMIN_ID,
  email: 'ops@easykonnet.com',
  firstName: 'Emeka',
  lastName: 'Obi',
  role: 'ADMIN',
  status: 'ACTIVE',
  lastLoginAt: null,
  createdAt: new Date('2026-09-01T11:20:00Z'),
  updatedAt: new Date('2026-09-01T11:20:00Z'),
  ...overrides,
});

const customerRecord = (overrides: Partial<{ role: string; status: string; deletedAt: Date | null }> = {}) => ({
  id: USER_ID,
  email: 'ifeanyi.chukwu@example.com',
  role: 'SERVICE_USER',
  status: 'ACTIVE',
  ...overrides,
});

beforeEach(() => {
  jest.resetAllMocks();
});

describe('suspendAdmin', () => {
  it('suspends the admin and records who suspended them, why and from where', async () => {
    db.user.findUnique.mockResolvedValue(adminRecord());

    const result = await suspendAdmin(ADMIN_ID, 'Shared their login with a contractor', SUPER_ADMIN_ID, 'SUPER_ADMIN', IP);

    expect(result.success).toBe(true);
    expect(db.user.update).toHaveBeenCalledWith({
      where: { id: ADMIN_ID },
      data: { status: 'SUSPENDED' },
    });
    expect(createAuditLog).toHaveBeenCalledWith({
      action: 'SUSPEND_USER',
      targetType: 'User',
      targetId: ADMIN_ID,
      performedBy: SUPER_ADMIN_ID,
      performedByRole: 'SUPER_ADMIN',
      previousValue: { status: 'ACTIVE' },
      newValue: { status: 'SUSPENDED' },
      reason: 'Shared their login with a contractor',
      ipAddress: IP,
    });
  });

  it('still reports the suspension when the audit log fails', async () => {
    db.user.findUnique.mockResolvedValue(adminRecord());
    (createAuditLog as jest.Mock).mockRejectedValue(new Error('database unavailable'));
    jest.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(
      suspendAdmin(ADMIN_ID, 'Shared their login with a contractor', SUPER_ADMIN_ID, 'SUPER_ADMIN')
    ).resolves.toMatchObject({ success: true });
    expect(db.user.update).toHaveBeenCalled();
  });

  it.each([
    ['their own account', adminRecord({ id: SUPER_ADMIN_ID }), 'FORBIDDEN'],
    ['a Super Admin', adminRecord({ role: 'SUPER_ADMIN' }), 'FORBIDDEN'],
    ['someone who is not an admin', adminRecord({ role: 'SERVICE_USER' }), 'NOT_FOUND'],
  ])('refuses to suspend %s', async (_label, record, code) => {
    db.user.findUnique.mockResolvedValue(record);

    await expect(suspendAdmin(record.id, 'No longer on the team', SUPER_ADMIN_ID, 'SUPER_ADMIN')).rejects.toMatchObject({
      extensions: { code },
    });
    expect(db.user.update).not.toHaveBeenCalled();
    expect(createAuditLog).not.toHaveBeenCalled();
  });
});

describe('createAdmin', () => {
  const input = {
    email: ' Ngozi.Eze@Example.com ',
    password: 'Welc0me!Abuja',
    firstName: ' Ngozi ',
    lastName: 'Eze',
    role: 'ADMIN' as const,
  };

  it('saves the cleaned details and records who created the admin, and from where', async () => {
    db.user.findUnique.mockResolvedValue(null);
    (hashPassword as jest.Mock).mockResolvedValue('hashed');
    db.user.create.mockResolvedValue({ id: ADMIN_ID });

    const result = await createAdmin(input, SUPER_ADMIN_ID, 'SUPER_ADMIN', IP);

    expect(result).toEqual({
      success: true,
      message: 'ADMIN account created successfully for ngozi.eze@example.com',
      requiresVerification: false,
    });
    expect(db.user.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ email: 'ngozi.eze@example.com', firstName: 'Ngozi', lastName: 'Eze', role: 'ADMIN', status: 'ACTIVE' }),
    });
    expect(createAuditLog).toHaveBeenCalledWith({
      action: 'CREATE_ADMIN',
      targetType: 'User',
      targetId: ADMIN_ID,
      performedBy: SUPER_ADMIN_ID,
      performedByRole: 'SUPER_ADMIN',
      newValue: { email: 'ngozi.eze@example.com', role: 'ADMIN', status: 'ACTIVE' },
      ipAddress: IP,
    });
  });

  it('still reports the new admin when the audit log fails', async () => {
    db.user.findUnique.mockResolvedValue(null);
    db.user.create.mockResolvedValue({ id: ADMIN_ID });
    (createAuditLog as jest.Mock).mockRejectedValue(new Error('database unavailable'));
    jest.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(createAdmin(input, SUPER_ADMIN_ID, 'SUPER_ADMIN')).resolves.toMatchObject({ success: true });
  });
});

describe('activateAdmin', () => {
  it('records the activation with the previous status', async () => {
    db.user.findUnique.mockResolvedValue(adminRecord({ status: 'SUSPENDED' }));

    await expect(activateAdmin(ADMIN_ID, SUPER_ADMIN_ID, 'SUPER_ADMIN', IP)).resolves.toEqual({
      success: true,
      message: 'Admin ops@easykonnet.com has been activated.',
    });
    expect(createAuditLog).toHaveBeenCalledWith({
      action: 'ACTIVATE_USER',
      targetType: 'User',
      targetId: ADMIN_ID,
      performedBy: SUPER_ADMIN_ID,
      performedByRole: 'SUPER_ADMIN',
      previousValue: { status: 'SUSPENDED' },
      newValue: { status: 'ACTIVE' },
      ipAddress: IP,
    });
  });
});

describe('updateAdminRole', () => {
  it('promotes an ADMIN and records the change', async () => {
    db.user.findUnique.mockResolvedValue(adminRecord());
    db.user.update.mockResolvedValue(adminRecord({ role: 'SUPER_ADMIN' }));

    const result = await updateAdminRole(ADMIN_ID, 'SUPER_ADMIN', SUPER_ADMIN_ID, 'SUPER_ADMIN', IP);

    expect(result).toMatchObject({ id: ADMIN_ID, role: 'SUPER_ADMIN' });
    expect(db.user.update).toHaveBeenCalledWith({ where: { id: ADMIN_ID }, data: { role: 'SUPER_ADMIN' } });
    expect(createAuditLog).toHaveBeenCalledWith({
      action: 'UPDATE_USER_ROLE',
      targetType: 'User',
      targetId: ADMIN_ID,
      performedBy: SUPER_ADMIN_ID,
      performedByRole: 'SUPER_ADMIN',
      previousValue: { role: 'ADMIN' },
      newValue: { role: 'SUPER_ADMIN' },
      ipAddress: IP,
    });
  });

  it.each(['ADMIN', 'SUPER_ADMIN'] as const)("refuses to change a Super Admin's role to %s", async (role) => {
    db.user.findUnique.mockResolvedValue(adminRecord({ role: 'SUPER_ADMIN' }));

    await expect(updateAdminRole(ADMIN_ID, role, SUPER_ADMIN_ID)).rejects.toMatchObject({
      message: 'Cannot change the role of a Super Admin',
      extensions: { code: 'FORBIDDEN' },
    });
    expect(db.user.update).not.toHaveBeenCalled();
    expect(createAuditLog).not.toHaveBeenCalled();
  });

  it('refuses to change your own role', async () => {
    db.user.findUnique.mockResolvedValue(adminRecord({ id: SUPER_ADMIN_ID, role: 'SUPER_ADMIN' }));

    await expect(updateAdminRole(SUPER_ADMIN_ID, 'ADMIN', SUPER_ADMIN_ID)).rejects.toMatchObject({
      message: 'You cannot change your own role',
      extensions: { code: 'FORBIDDEN' },
    });
  });

  it('saves and records nothing when the role is unchanged', async () => {
    db.user.findUnique.mockResolvedValue(adminRecord());

    await expect(updateAdminRole(ADMIN_ID, 'ADMIN', SUPER_ADMIN_ID)).resolves.toMatchObject({ role: 'ADMIN' });
    expect(db.user.update).not.toHaveBeenCalled();
    expect(createAuditLog).not.toHaveBeenCalled();
  });
});

describe('deleteAdmin', () => {
  it('deletes the admin and records who they were', async () => {
    db.user.findUnique.mockResolvedValue(adminRecord({ status: 'SUSPENDED' }));

    await expect(deleteAdmin(ADMIN_ID, SUPER_ADMIN_ID, 'SUPER_ADMIN', IP)).resolves.toMatchObject({ success: true });
    expect(db.user.delete).toHaveBeenCalledWith({ where: { id: ADMIN_ID } });
    expect(createAuditLog).toHaveBeenCalledWith({
      action: 'DELETE_USER',
      targetType: 'User',
      targetId: ADMIN_ID,
      performedBy: SUPER_ADMIN_ID,
      performedByRole: 'SUPER_ADMIN',
      previousValue: { email: 'ops@easykonnet.com', role: 'ADMIN', status: 'SUSPENDED' },
      ipAddress: IP,
    });
  });
});

describe('suspendUser', () => {
  it('suspends the account, records the reason, and tells the user', async () => {
    db.user.findUnique.mockResolvedValue(customerRecord());

    await expect(suspendUser(USER_ID, 'Identity documents under review', ADMIN_ID, 'ADMIN', IP)).resolves.toEqual({
      success: true,
      message: 'User ifeanyi.chukwu@example.com has been suspended.',
    });
    expect(db.user.update).toHaveBeenCalledWith({ where: { id: USER_ID }, data: { status: 'SUSPENDED' } });
    expect(createAuditLog).toHaveBeenCalledWith({
      action: 'SUSPEND_USER',
      targetType: 'User',
      targetId: USER_ID,
      performedBy: ADMIN_ID,
      performedByRole: 'ADMIN',
      previousValue: { status: 'ACTIVE' },
      newValue: { status: 'SUSPENDED' },
      reason: 'Identity documents under review',
      ipAddress: IP,
    });
    expect(notifyAndPush).toHaveBeenCalledWith(
      USER_ID,
      'ACCOUNT_SUSPENDED',
      'Account Suspended',
      'Your account has been suspended. Reason: Identity documents under review',
      { reason: 'Identity documents under review' }
    );
  });

  it('asks the user to contact support when no reason was given', async () => {
    db.user.findUnique.mockResolvedValue(customerRecord({ role: 'SERVICE_PROVIDER' }));

    await suspendUser(USER_ID, '  ', ADMIN_ID, 'ADMIN');

    expect(notifyAndPush).toHaveBeenCalledWith(
      USER_ID,
      'ACCOUNT_SUSPENDED',
      'Account Suspended',
      'Your account has been suspended. Please contact support.',
      { reason: '' }
    );
  });

  it("records a repeat suspension but doesn't notify the user again", async () => {
    db.user.findUnique.mockResolvedValue(customerRecord({ status: 'SUSPENDED' }));

    await suspendUser(USER_ID, 'Still under review', ADMIN_ID, 'ADMIN');

    expect(createAuditLog).toHaveBeenCalledWith(expect.objectContaining({ previousValue: { status: 'SUSPENDED' } }));
    expect(notifyAndPush).not.toHaveBeenCalled();
  });

  it('treats a deleted account as not found', async () => {
    db.user.findUnique.mockResolvedValue(customerRecord({ deletedAt: new Date('2026-09-01T10:00:00.000Z') }));

    await expect(suspendUser(USER_ID, 'Fraud', ADMIN_ID, 'ADMIN')).rejects.toMatchObject({
      message: 'User not found',
      extensions: { code: 'NOT_FOUND' },
    });
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it.each(['ADMIN', 'SUPER_ADMIN'])('refuses a %s account', async (role) => {
    db.user.findUnique.mockResolvedValue(customerRecord({ role }));

    await expect(suspendUser(USER_ID, 'Review', ADMIN_ID, 'ADMIN')).rejects.toMatchObject({
      message: 'Use admin management endpoints for admin accounts',
      extensions: { code: 'FORBIDDEN' },
    });
    expect(db.user.update).not.toHaveBeenCalled();
    expect(createAuditLog).not.toHaveBeenCalled();
    expect(notifyAndPush).not.toHaveBeenCalled();
  });
});

describe('activateUser', () => {
  it.each(['SUSPENDED', 'DEACTIVATED'])('reactivates a %s account, records it, and tells the user', async (status) => {
    db.user.findUnique.mockResolvedValue(customerRecord({ status }));

    await expect(activateUser(USER_ID, ADMIN_ID, 'ADMIN', IP)).resolves.toEqual({
      success: true,
      message: 'User ifeanyi.chukwu@example.com has been activated.',
    });
    expect(createAuditLog).toHaveBeenCalledWith({
      action: 'ACTIVATE_USER',
      targetType: 'User',
      targetId: USER_ID,
      performedBy: ADMIN_ID,
      performedByRole: 'ADMIN',
      previousValue: { status },
      newValue: { status: 'ACTIVE' },
      ipAddress: IP,
    });
    expect(notifyAndPush).toHaveBeenCalledWith(
      USER_ID,
      'ACCOUNT_ACTIVATED',
      'Account Reactivated',
      'Your account has been reactivated. You can now access your account.'
    );
  });

  it.each(['ACTIVE', 'PENDING'])("records activating a %s account without notifying the user", async (status) => {
    db.user.findUnique.mockResolvedValue(customerRecord({ status }));

    await activateUser(USER_ID, ADMIN_ID, 'ADMIN');

    expect(createAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'ACTIVATE_USER', previousValue: { status } }));
    expect(notifyAndPush).not.toHaveBeenCalled();
  });

  it('refuses an account that has been deleted', async () => {
    db.user.findUnique.mockResolvedValue({ ...customerRecord({ status: 'DEACTIVATED' }), deletedAt: new Date('2026-09-11T10:00:00Z') });

    await expect(activateUser(USER_ID, ADMIN_ID, 'ADMIN', IP)).rejects.toMatchObject({
      message: 'This account has been deleted and cannot be reactivated',
      extensions: { code: 'ACCOUNT_DELETED' },
    });
    expect(db.user.update).not.toHaveBeenCalled();
    expect(createAuditLog).not.toHaveBeenCalled();
    expect(notifyAndPush).not.toHaveBeenCalled();
  });
});
