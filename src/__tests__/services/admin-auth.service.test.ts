/**
 * Admin sign-in and sessions: what adminLogin reveals and when, sessions that
 * adminLogout, password changes and bans end, the lockout, and validation of
 * admin contact details
 */

jest.mock('@/lib/prisma', () => ({
  __esModule: true,
  default: { user: { findUnique: jest.fn(), update: jest.fn() } },
}));
// Real tokens need a signing secret, which the test environment doesn't set
jest.mock('@/config', () => {
  const actual = jest.requireActual('@/config');
  return { ...actual, config: { ...actual.config, jwt: { ...actual.config.jwt, secret: 'admin-auth-test-secret' } } };
});
// The Resend client throws at import time without an API key
jest.mock('@/lib/email', () => ({
  sendPasswordResetEmail: jest.fn(),
  sendProfileUpdatedEmail: jest.fn(),
  sendEmailChangeOtpEmail: jest.fn(),
}));
// An in-memory Redis, so the real token helpers store, check and revoke tokens
jest.mock('@/lib/redis', () => ({
  __esModule: true,
  default: { getInstance: () => mockRedis, connect: async () => mockRedis },
}));
jest.mock('@/lib/auth', () => ({
  ...jest.requireActual('@/lib/auth'),
  comparePassword: jest.fn(),
  hashPassword: jest.fn(),
}));
jest.mock('@/lib/otp', () => ({
  ...jest.requireActual('@/lib/otp'),
  verifyOtp: jest.fn(),
  isOtpExpired: jest.fn(),
}));
jest.mock('@/services/audit.service', () => ({ createAuditLog: jest.fn() }));
jest.mock('@/services/user-management.service', () => ({ notifyAndPush: jest.fn() }));

import prisma from '@/lib/prisma';
import { comparePassword, hashPassword, generateRefreshToken, verifyAccessToken } from '@/lib/auth';
import { sendProfileUpdatedEmail } from '@/lib/email';
import { verifyOtp, isOtpExpired } from '@/lib/otp';
import { config } from '@/config';
import { isTokenValid } from '@/utils/security';
import { storeRefreshToken, isAccessTokenRevoked } from '@/services/token.service';
import {
  adminLogin,
  adminRefreshToken,
  adminLogout,
  adminChangePassword,
  adminResetPassword,
  createAdmin,
  adminRequestEmailChange,
  updateAdminProfile,
} from '@/services/admin.service';

const values = new Map<string, string>();
const sets = new Map<string, Set<string>>();
const mockRedis = {
  get: async (key: string) => values.get(key) ?? null,
  setex: async (key: string, _seconds: number, value: string) => {
    values.set(key, String(value));
    return 'OK';
  },
  del: async (key: string) => (values.delete(key) || sets.delete(key) ? 1 : 0),
  exists: async (...keys: string[]) => keys.filter((key) => values.has(key) || sets.has(key)).length,
  sadd: async (key: string, member: string) => {
    sets.set(key, (sets.get(key) ?? new Set<string>()).add(member));
    return 1;
  },
  srem: async (key: string, member: string) => (sets.get(key)?.delete(member) ? 1 : 0),
  smembers: async (key: string) => [...(sets.get(key) ?? [])],
  expire: async () => 1,
  scard: async (key: string) => sets.get(key)?.size ?? 0,
};

const db = prisma as unknown as { user: { findUnique: jest.Mock; update: jest.Mock } };

const ADMIN_ID = '66e2b4c1f0a9d83b5c7e1c01';
const OTHER_ADMIN_ID = '66e2b4c1f0a9d83b5c7e1c02';
const EMAIL = 'ngozi.eze@example.com';
const IP = '102.89.4.7';
const PASSWORD = 'Str0ng!Pass';
const NEW_PASSWORD = 'Lagos#2026Secure';
const PREVIOUS_LOGIN = new Date('2026-09-01T08:00:00Z');
const MINUTE_MS = 60 * 1000;

type Account = Record<string, unknown>;

const adminAccount = (overrides: Account = {}): Account => ({
  id: ADMIN_ID,
  email: EMAIL,
  password: 'stored-hash',
  firstName: 'Ngozi',
  lastName: 'Eze',
  phone: null,
  profilePhoto: null,
  role: 'ADMIN',
  status: 'ACTIVE',
  failedLoginAttempts: 0,
  lockoutUntil: null,
  lastLoginAt: PREVIOUS_LOGIN,
  lastLoginIp: null,
  bannedAt: null,
  bannedUntil: null,
  tokenInvalidatedAt: null,
  deletedAt: null,
  passwordResetToken: null,
  passwordResetExpiry: null,
  createdAt: new Date('2026-01-05T10:00:00Z'),
  updatedAt: new Date('2026-01-05T10:00:00Z'),
  ...overrides,
});

/** Whether an access token still passes the sign-out-everywhere check */
const accessTokenStillValid = (accessToken: string) => {
  const { iat, iatMs } = verifyAccessToken(accessToken);
  return isTokenValid(ADMIN_ID, iat as number, iatMs);
};

let account: Account | null;
let clock: number;

beforeEach(() => {
  values.clear();
  sets.clear();
  clock = Date.now();
  jest.spyOn(Date, 'now').mockImplementation(() => clock);

  account = adminAccount();
  db.user.findUnique.mockImplementation(async () => account);
  db.user.update.mockImplementation(async ({ data }: { data: Account }) => {
    account = { ...account, ...data };
    return account;
  });
  (comparePassword as jest.Mock).mockImplementation(async (password: string) => password === PASSWORD);
  (hashPassword as jest.Mock).mockResolvedValue('new-hash');
  (sendProfileUpdatedEmail as jest.Mock).mockResolvedValue(undefined);
});

describe('adminLogin', () => {
  it('returns the new sign-in time, not the previous one', async () => {
    const result = await adminLogin({ email: ' Ngozi.Eze@example.com', password: PASSWORD }, IP);

    const saved = db.user.update.mock.calls[0][0].data;
    expect(saved).toMatchObject({ failedLoginAttempts: 0, lockoutUntil: null, lastLoginIp: IP });
    expect(result.admin.lastLoginAt).toBe((saved.lastLoginAt as Date).toISOString());
    expect(result.admin.lastLoginAt).not.toBe(PREVIOUS_LOGIN.toISOString());
  });

  it.each([
    ['no account', null],
    ['a customer account', adminAccount({ role: 'SERVICE_USER' })],
    ['a provider account', adminAccount({ role: 'SERVICE_PROVIDER' })],
  ])('answers an email with %s like a wrong password, even when the password is right', async (_label, record) => {
    account = record;
    (hashPassword as jest.Mock).mockResolvedValue('dummy-hash');

    await expect(adminLogin({ email: EMAIL, password: PASSWORD })).rejects.toMatchObject({
      message: 'Invalid admin credentials',
      extensions: { code: 'INVALID_CREDENTIALS' },
    });
    // The password is still checked, so the answer takes as long as for an admin
    expect(comparePassword).toHaveBeenCalledTimes(1);
    expect(db.user.update).not.toHaveBeenCalled();
    expect(values.size).toBe(0);
  });

  it.each([
    ['locked', { failedLoginAttempts: 5, lockoutUntil: new Date(Date.now() + 20 * MINUTE_MS) }, 'ACCOUNT_LOCKED', /^Account is locked\. Try again in (19|20) minutes\.$/],
    ['suspended', { status: 'SUSPENDED' }, 'ACCOUNT_SUSPENDED', /^Your admin account has been suspended\.$/],
    ['deactivated', { status: 'DEACTIVATED' }, 'ACCOUNT_DEACTIVATED', /^Your admin account has been deactivated\.$/],
    ['banned', { bannedAt: new Date(Date.now() - MINUTE_MS), bannedUntil: null }, 'ACCOUNT_BANNED', /^Your admin account has been banned\.$/],
  ])('only reveals that the account is %s after a correct password', async (_label, overrides, code, message) => {
    account = adminAccount(overrides);

    await expect(adminLogin({ email: EMAIL, password: 'Wrong!Pass1' })).rejects.toMatchObject({
      message: 'Invalid admin credentials',
      extensions: { code: 'INVALID_CREDENTIALS' },
    });
    await expect(adminLogin({ email: EMAIL, password: PASSWORD })).rejects.toMatchObject({
      message: expect.stringMatching(message),
      extensions: { code },
    });
    // No session was started
    expect(values.size).toBe(0);
  });

  it("doesn't count wrong passwords during a lockout, so they don't extend it", async () => {
    account = adminAccount({ failedLoginAttempts: 5, lockoutUntil: new Date(clock + 20 * MINUTE_MS) });

    await expect(adminLogin({ email: EMAIL, password: 'Wrong!Pass1' })).rejects.toMatchObject({
      extensions: { code: 'INVALID_CREDENTIALS' },
    });
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it('locks the account after too many wrong passwords without saying so on that attempt', async () => {
    account = adminAccount({ failedLoginAttempts: config.security.maxLoginAttempts - 1 });

    await expect(adminLogin({ email: EMAIL, password: 'Wrong!Pass1' })).rejects.toMatchObject({
      extensions: { code: 'INVALID_CREDENTIALS' },
    });
    expect(account?.failedLoginAttempts).toBe(config.security.maxLoginAttempts);
    expect((account?.lockoutUntil as Date).getTime()).toBe(clock + config.security.lockoutDurationMinutes * MINUTE_MS);
  });
});

describe('admin sessions', () => {
  const invalidated = { message: 'Refresh token has been invalidated', extensions: { code: 'INVALID_TOKEN' } };

  it('adminLogout ends the session: the access token and the refresh token stop working', async () => {
    const { accessToken, refreshToken } = await adminLogin({ email: EMAIL, password: PASSWORD }, IP);
    const payload = verifyAccessToken(accessToken);

    await expect(adminRefreshToken(refreshToken)).resolves.toMatchObject({ admin: { id: ADMIN_ID } });

    await expect(adminLogout(refreshToken, { payload, accessToken })).resolves.toEqual({
      success: true,
      message: 'Admin logged out successfully',
    });

    await expect(adminRefreshToken(refreshToken)).rejects.toMatchObject(invalidated);
    expect(await isAccessTokenRevoked(payload, accessToken)).toBe(true);
  });

  it('refuses a refresh token that was never stored', async () => {
    const payload = { userId: ADMIN_ID, email: EMAIL, role: 'ADMIN' as const, isAdmin: true };

    await expect(adminRefreshToken(generateRefreshToken(payload))).rejects.toMatchObject(invalidated);
  });

  it('refuses a stored refresh token presented for a different account', async () => {
    const payload = { userId: ADMIN_ID, email: EMAIL, role: 'ADMIN' as const, isAdmin: true };
    const token = generateRefreshToken(payload);
    await storeRefreshToken(OTHER_ADMIN_ID, token);

    await expect(adminRefreshToken(token)).rejects.toMatchObject(invalidated);
  });

  it('refuses a customer refresh token', async () => {
    const token = generateRefreshToken({ userId: ADMIN_ID, email: EMAIL, role: 'SERVICE_USER' });
    await storeRefreshToken(ADMIN_ID, token);

    await expect(adminRefreshToken(token)).rejects.toMatchObject({
      message: 'Invalid admin token',
      extensions: { code: 'INVALID_TOKEN' },
    });
  });

  it('refuses a malformed token', async () => {
    await expect(adminRefreshToken('not-a-token')).rejects.toMatchObject({
      message: 'Invalid or expired token',
      extensions: { code: 'INVALID_TOKEN' },
    });
  });

  it('changing the password signs out every device, and signing in again works', async () => {
    const laptop = await adminLogin({ email: EMAIL, password: PASSWORD });
    const phone = await adminLogin({ email: EMAIL, password: PASSWORD });

    clock += 5000;
    await expect(
      adminChangePassword(ADMIN_ID, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD })
    ).resolves.toEqual({ success: true, message: 'Password changed successfully. Please login again on all devices.' });
    expect(account?.tokenInvalidatedAt).toBeInstanceOf(Date);

    for (const session of [laptop, phone]) {
      await expect(adminRefreshToken(session.refreshToken)).rejects.toMatchObject(invalidated);
      expect(await accessTokenStillValid(session.accessToken)).toBe(false);
    }

    clock += 5000;
    (comparePassword as jest.Mock).mockImplementation(async (password: string) => password === NEW_PASSWORD);
    const again = await adminLogin({ email: EMAIL, password: NEW_PASSWORD });
    await expect(adminRefreshToken(again.refreshToken)).resolves.toMatchObject({ admin: { id: ADMIN_ID } });
    expect(await accessTokenStillValid(again.accessToken)).toBe(true);
  });

  it('resetting the password signs out every device', async () => {
    const session = await adminLogin({ email: EMAIL, password: PASSWORD });
    account = { ...account, passwordResetToken: 'hashed-code', passwordResetExpiry: new Date(clock + 5 * MINUTE_MS) };
    (verifyOtp as jest.Mock).mockReturnValue(true);
    (isOtpExpired as jest.Mock).mockReturnValue(false);

    clock += 5000;
    await adminResetPassword({ email: EMAIL, otp: '482913', newPassword: NEW_PASSWORD });

    expect(account?.tokenInvalidatedAt).toBeInstanceOf(Date);
    await expect(adminRefreshToken(session.refreshToken)).rejects.toMatchObject(invalidated);
    expect(await accessTokenStillValid(session.accessToken)).toBe(false);
  });

  it('refuses a refresh token issued before a ban, even once the ban is lifted', async () => {
    const { refreshToken } = await adminLogin({ email: EMAIL, password: PASSWORD });

    // banUser saves the time sessions ended; unbanUser lifts the ban but keeps that time
    clock += 5000;
    account = { ...account, tokenInvalidatedAt: new Date(clock) };

    await expect(adminRefreshToken(refreshToken)).rejects.toMatchObject(invalidated);
  });

  it('refuses a refresh token for an account that has been deleted', async () => {
    const { refreshToken } = await adminLogin({ email: EMAIL, password: PASSWORD });
    account = { ...account, deletedAt: new Date() };

    await expect(adminRefreshToken(refreshToken)).rejects.toMatchObject({
      message: 'Admin not found',
      extensions: { code: 'NOT_FOUND' },
    });
  });

  it('accepts a signed refresh token while the token store is unavailable, as for customers', async () => {
    const { refreshToken } = await adminLogin({ email: EMAIL, password: PASSWORD });
    jest.spyOn(mockRedis, 'exists').mockRejectedValueOnce(new Error('connection refused'));
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(adminRefreshToken(refreshToken)).resolves.toMatchObject({ admin: { id: ADMIN_ID } });
  });
});

describe('adminChangePassword lockout', () => {
  it('counts a wrong current password toward the lockout', async () => {
    await expect(
      adminChangePassword(ADMIN_ID, { currentPassword: 'Wrong!Pass1', newPassword: NEW_PASSWORD })
    ).rejects.toMatchObject({ message: 'Current password is incorrect', extensions: { code: 'INVALID_PASSWORD' } });

    expect(account).toMatchObject({ failedLoginAttempts: 1, password: 'stored-hash' });
  });

  it('locks the account on the attempt that reaches the limit, then refuses even the right password', async () => {
    account = adminAccount({ failedLoginAttempts: config.security.maxLoginAttempts - 1 });

    await expect(
      adminChangePassword(ADMIN_ID, { currentPassword: 'Wrong!Pass1', newPassword: NEW_PASSWORD })
    ).rejects.toMatchObject({
      message: `Account is locked. Try again in ${config.security.lockoutDurationMinutes} minutes.`,
      extensions: { code: 'ACCOUNT_LOCKED' },
    });
    await expect(
      adminChangePassword(ADMIN_ID, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD })
    ).rejects.toMatchObject({ extensions: { code: 'ACCOUNT_LOCKED' } });
    expect(hashPassword).not.toHaveBeenCalled();
  });

  it('clears earlier failed attempts when the change succeeds', async () => {
    account = adminAccount({ failedLoginAttempts: 2 });

    await adminChangePassword(ADMIN_ID, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD });

    expect(account).toMatchObject({ password: 'new-hash', failedLoginAttempts: 0, lockoutUntil: null });
  });
});

describe('admin contact details', () => {
  it.each(['not-an-email', 'ngozi@', ''])('createAdmin refuses the email %p', async (email) => {
    await expect(
      createAdmin({ email, password: PASSWORD, firstName: 'Ngozi', lastName: 'Eze', role: 'ADMIN' }, OTHER_ADMIN_ID)
    ).rejects.toMatchObject({ message: 'Invalid email format', extensions: { code: 'INVALID_EMAIL' } });
    expect(db.user.findUnique).not.toHaveBeenCalled();
  });

  it.each([
    ['firstName', 'N', /^First name /],
    ['lastName', 'Eze$', /^Last name /],
  ])('createAdmin refuses %s %p', async (field, value, message) => {
    const input = { email: EMAIL, password: PASSWORD, firstName: 'Ngozi', lastName: 'Eze', role: 'ADMIN' as const, [field]: value };

    await expect(createAdmin(input, OTHER_ADMIN_ID)).rejects.toMatchObject({
      message: expect.stringMatching(message),
      extensions: { code: 'INVALID_INPUT' },
    });
    expect(db.user.findUnique).not.toHaveBeenCalled();
  });

  it('adminRequestEmailChange refuses a malformed address before saving anything', async () => {
    await expect(adminRequestEmailChange(ADMIN_ID, 'c.okafor@')).rejects.toMatchObject({
      message: 'Invalid email format',
      extensions: { code: 'INVALID_EMAIL' },
    });
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it('updateAdminProfile refuses an invalid phone number or name', async () => {
    await expect(updateAdminProfile(ADMIN_ID, { phone: '12345' })).rejects.toMatchObject({
      extensions: { code: 'INVALID_PHONE' },
    });
    await expect(updateAdminProfile(ADMIN_ID, { firstName: 'N' })).rejects.toMatchObject({
      extensions: { code: 'INVALID_INPUT' },
    });
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it('updateAdminProfile saves cleaned values, and an empty phone removes the number', async () => {
    await updateAdminProfile(ADMIN_ID, { firstName: 'Ngozi', lastName: '  Eze-Okafor ', phone: '0803 123 4567' });

    expect(db.user.update).toHaveBeenCalledWith({
      where: { id: ADMIN_ID },
      data: { lastName: 'Eze-Okafor', phone: '+2348031234567' },
    });
    expect(sendProfileUpdatedEmail).toHaveBeenCalledWith(EMAIL, 'Ngozi', ['Last Name', 'Phone Number']);

    db.user.update.mockClear();
    await updateAdminProfile(ADMIN_ID, { phone: '' });

    expect(db.user.update).toHaveBeenCalledWith({ where: { id: ADMIN_ID }, data: { phone: null } });
  });

  it('updateAdminProfile accepts a saved value sent back unchanged, even in an older format', async () => {
    account = adminAccount({ phone: '+44 20 7946 0958' });

    await expect(updateAdminProfile(ADMIN_ID, { firstName: 'Ngozi', phone: '+44 20 7946 0958' })).resolves.toMatchObject({
      phone: '+44 20 7946 0958',
    });
    expect(db.user.update).not.toHaveBeenCalled();
  });
});
