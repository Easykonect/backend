/**
 * Sign-in, sign-up, password and session rules in the auth service
 *
 * Covers:
 *   - login checks the password before revealing account state, refuses admin and
 *     deleted accounts like a wrong password, restarts the failed-attempt count after
 *     a lockout, reactivates deactivated accounts, and returns every User field
 *   - verifyEmail stores its refresh token and only activates PENDING accounts
 *   - register never overwrites an unverified account and accepts local phone numbers
 *   - forgotPassword and resetPassword don't reveal accounts and refuse admins
 *   - changePassword counts wrong passwords toward the lockout
 *   - resetPassword and changePassword end every session
 *   - refreshToken with Redis unavailable, sessions ended by tokenInvalidatedAt,
 *     and admin accounts
 *   - logout revokes the access token
 */

jest.mock('@/lib/prisma', () => ({
  __esModule: true,
  default: {
    user: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
  },
}));

// Tokens are signed for real, so don't depend on JWT_SECRET being set locally
jest.mock('@/config', () => {
  const actual = jest.requireActual('@/config');
  return { ...actual, config: { ...actual.config, jwt: { ...actual.config.jwt, secret: 'test-jwt-secret' } } };
});

// The Resend client throws at import time without an API key
jest.mock('@/lib/email', () => ({
  sendVerificationEmail: jest.fn(),
  sendPasswordResetEmail: jest.fn(),
  sendLoginAlertEmail: jest.fn(),
}));

jest.mock('@/lib/redis', () => ({
  __esModule: true,
  default: { getInstance: jest.fn(), connect: jest.fn() },
}));

jest.mock('@/services/token.service', () => ({
  storeRefreshToken: jest.fn(),
  checkRefreshToken: jest.fn(),
  invalidateRefreshToken: jest.fn(),
  endAllSessions: jest.fn(),
  revokeAccessToken: jest.fn(),
}));

jest.mock('@/utils/security', () => ({
  ...jest.requireActual('@/utils/security'),
  enforceRateLimit: jest.fn(),
  incrementRateLimit: jest.fn(),
  resetRateLimit: jest.fn(),
  isTokenValid: jest.fn(),
  logSecurityEvent: jest.fn(),
}));

jest.mock('@/lib/auth', () => ({
  ...jest.requireActual('@/lib/auth'),
  hashPassword: jest.fn(),
  comparePassword: jest.fn(),
}));

import prisma from '@/lib/prisma';
import { config } from '@/config';
import { hashOtp } from '@/lib/otp';
import { sendVerificationEmail, sendPasswordResetEmail } from '@/lib/email';
import {
  comparePassword,
  generateRefreshToken,
  hashPassword,
  verifyAccessToken,
  type JWTPayload,
} from '@/lib/auth';
import { isTokenValid } from '@/utils/security';
import {
  storeRefreshToken,
  checkRefreshToken,
  invalidateRefreshToken,
  endAllSessions,
  revokeAccessToken,
} from '@/services/token.service';
import {
  changePassword,
  forgotPassword,
  loginUser,
  logout,
  refreshAccessToken,
  registerUser,
  resetPassword,
  verifyEmail,
} from '@/services/auth.service';

const USER_ID = '507f1f77bcf86cd799439011';
const PASSWORD = 'Str0ng!Pass';
const MINUTE_MS = 60 * 1000;

const hashed = (password: string) => `hashed:${password}`;

const account = (overrides: Record<string, unknown> = {}) => ({
  id: USER_ID,
  email: 'ada@example.com',
  password: hashed(PASSWORD),
  firstName: 'Ada',
  lastName: 'Obi',
  phone: '+2348031234567',
  profilePhoto: null,
  role: 'SERVICE_USER',
  activeRole: null,
  status: 'ACTIVE',
  isEmailVerified: true,
  pushEnabled: false,
  lastLoginAt: null,
  lastLoginIp: null,
  failedLoginAttempts: 0,
  lockoutUntil: null,
  bannedAt: null,
  bannedUntil: null,
  deletedAt: null,
  deactivatedAt: null,
  deactivationReason: null,
  tokenInvalidatedAt: null,
  emailVerifyToken: null,
  emailVerifyExpiry: null,
  passwordResetToken: null,
  passwordResetExpiry: null,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-02T00:00:00.000Z'),
  ...overrides,
});

const findUser = prisma.user.findUnique as jest.Mock;
const updateUser = prisma.user.update as jest.Mock;

let stored: ReturnType<typeof account>;

const givenAccount = (overrides: Record<string, unknown> = {}) => {
  stored = account(overrides);
  findUser.mockResolvedValue(stored);
  return stored;
};

beforeEach(() => {
  (hashPassword as jest.Mock).mockImplementation(async (password: string) => hashed(password));
  (comparePassword as jest.Mock).mockImplementation(
    async (password: string, hash: string) => hash === hashed(password)
  );
  (isTokenValid as jest.Mock).mockResolvedValue(true);
  (sendVerificationEmail as jest.Mock).mockResolvedValue(true);
  updateUser.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    ...stored,
    ...data,
  }));
});

const lastUpdateData = () => updateUser.mock.calls[updateUser.mock.calls.length - 1][0].data;

// ==================
// login
// ==================

describe('loginUser', () => {
  const signIn = (password = PASSWORD) => loginUser({ email: 'Ada@Example.com ', password }, '1.2.3.4');

  it('returns every User field, including pushEnabled, and stores the refresh token', async () => {
    givenAccount({ pushEnabled: false });

    const result = await signIn();

    expect(result.user).toMatchObject({
      id: USER_ID,
      activeRole: 'SERVICE_USER',
      pushEnabled: false,
      isEmailVerified: true,
    });
    expect(typeof result.user.lastLoginAt).toBe('string');
    expect(storeRefreshToken).toHaveBeenCalledWith(USER_ID, result.refreshToken, expect.anything());
  });

  it.each([
    ['locked', { lockoutUntil: new Date(Date.now() + 10 * MINUTE_MS) }],
    ['unverified', { isEmailVerified: false, status: 'PENDING' }],
    ['suspended', { status: 'SUSPENDED' }],
    ['deactivated', { status: 'DEACTIVATED' }],
    ['banned', { bannedAt: new Date() }],
  ])('gives a %s account the wrong-password error for a wrong password', async (_label, state) => {
    givenAccount(state);

    await expect(signIn('Wrong!Pass1')).rejects.toMatchObject({
      extensions: { code: 'INVALID_CREDENTIALS' },
    });
  });

  it.each([
    ['locked', { lockoutUntil: new Date(Date.now() + 10 * MINUTE_MS) }, 'ACCOUNT_LOCKED'],
    ['unverified', { isEmailVerified: false, status: 'PENDING' }, 'EMAIL_NOT_VERIFIED'],
    ['suspended', { status: 'SUSPENDED' }, 'USER_SUSPENDED'],
    ['banned', { bannedAt: new Date() }, 'ACCOUNT_BANNED'],
  ])('shows a %s account its state once the password is right', async (_label, state, code) => {
    givenAccount(state);

    await expect(signIn()).rejects.toMatchObject({ extensions: { code } });
  });

  it("doesn't extend a lockout or report attempts for a wrong password while locked", async () => {
    givenAccount({ failedLoginAttempts: 5, lockoutUntil: new Date(Date.now() + 10 * MINUTE_MS) });

    const error = await signIn('Wrong!Pass1').catch((e) => e);

    expect(error.extensions).toEqual({ code: 'INVALID_CREDENTIALS' });
    expect(updateUser).not.toHaveBeenCalled();
  });

  it('starts the failed-attempt count again once a lockout has ended', async () => {
    givenAccount({
      failedLoginAttempts: config.security.maxLoginAttempts,
      lockoutUntil: new Date(Date.now() - MINUTE_MS),
    });

    await expect(signIn('Wrong!Pass1')).rejects.toMatchObject({
      extensions: {
        code: 'INVALID_CREDENTIALS',
        attemptsRemaining: config.security.maxLoginAttempts - 1,
      },
    });
    expect(lastUpdateData()).toEqual({ failedLoginAttempts: 1, lockoutUntil: null });
  });

  it('locks the account on the last allowed wrong password', async () => {
    givenAccount({ failedLoginAttempts: config.security.maxLoginAttempts - 1 });

    await expect(signIn('Wrong!Pass1')).rejects.toMatchObject({
      extensions: { code: 'ACCOUNT_LOCKED' },
    });
    expect(lastUpdateData().lockoutUntil).toBeInstanceOf(Date);
  });

  it('reactivates a deactivated account when the password is right', async () => {
    givenAccount({ status: 'DEACTIVATED', deactivatedAt: new Date(), deactivationReason: 'Break' });

    const result = await signIn();

    expect(lastUpdateData()).toMatchObject({
      status: 'ACTIVE',
      deactivatedAt: null,
      deactivationReason: null,
    });
    expect(result.user.status).toBe('ACTIVE');
    expect(result.accessToken).toEqual(expect.any(String));
  });

  it.each([
    ['an admin', { role: 'ADMIN' }],
    ['a super admin', { role: 'SUPER_ADMIN' }],
    ['a deleted', { deletedAt: new Date(), status: 'DEACTIVATED' }],
  ])('refuses %s account like a wrong password, without touching its lockout', async (_label, state) => {
    givenAccount(state);

    const error = await signIn().catch((e) => e);

    expect(error.extensions).toEqual({ code: 'INVALID_CREDENTIALS' });
    expect(updateUser).not.toHaveBeenCalled();
    expect(storeRefreshToken).not.toHaveBeenCalled();
  });

  it('does the same password work for an unknown email', async () => {
    findUser.mockResolvedValue(null);

    const error = await signIn().catch((e) => e);

    expect(error.extensions).toEqual({ code: 'INVALID_CREDENTIALS' });
    expect(comparePassword).toHaveBeenCalled();
  });
});

// ==================
// verifyEmail
// ==================

describe('verifyEmail', () => {
  const verify = () => verifyEmail({ email: 'ada@example.com', otp: '123456' });

  const pending = (overrides: Record<string, unknown> = {}) =>
    givenAccount({
      status: 'PENDING',
      isEmailVerified: false,
      emailVerifyToken: hashOtp('123456'),
      emailVerifyExpiry: new Date(Date.now() + 5 * MINUTE_MS),
      ...overrides,
    });

  it('activates a pending account and stores the refresh token it returns', async () => {
    pending();

    const result = await verify();

    expect(lastUpdateData()).toMatchObject({ isEmailVerified: true, status: 'ACTIVE' });
    expect(result.refreshToken).toEqual(expect.any(String));
    expect(storeRefreshToken).toHaveBeenCalledWith(USER_ID, result.refreshToken, expect.anything());
    expect(result.user).toMatchObject({ activeRole: 'SERVICE_USER', pushEnabled: false, status: 'ACTIVE' });
  });

  it("keeps a suspended account suspended and doesn't sign it in", async () => {
    pending({ status: 'SUSPENDED' });

    const result = await verify();

    expect(lastUpdateData()).not.toHaveProperty('status');
    expect(result).toMatchObject({
      success: true,
      message: 'Email verified successfully! Please sign in to continue.',
      accessToken: null,
      refreshToken: null,
    });
    expect(storeRefreshToken).not.toHaveBeenCalled();
  });
});

// ==================
// register
// ==================

describe('registerUser', () => {
  const input = {
    email: 'ada@example.com',
    password: 'N3w!Passw0rd',
    firstName: 'Adaeze',
    lastName: 'Okafor',
  };

  it('sends a new code to an unverified account without changing its password or names', async () => {
    givenAccount({ isEmailVerified: false, status: 'PENDING' });

    const result = await registerUser({ ...input, phone: '08099999999' });

    expect(result).toEqual({
      success: true,
      message: 'Registration successful! Please check your email for the verification code.',
      requiresVerification: true,
    });
    expect(Object.keys(lastUpdateData()).sort()).toEqual(['emailVerifyExpiry', 'emailVerifyToken']);
    expect(sendVerificationEmail).toHaveBeenCalledWith('ada@example.com', 'Ada', expect.any(String));
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it('still refuses an email that belongs to a verified account', async () => {
    givenAccount();

    await expect(registerUser(input)).rejects.toMatchObject({
      extensions: { code: 'USER_ALREADY_EXISTS' },
    });
  });

  it.each(['0803 123 4567', '+234 803 123 4567', '2348031234567'])(
    'accepts the phone number %s and stores it as +234',
    async (phone) => {
      findUser.mockResolvedValue(null);

      await registerUser({ ...input, phone });

      expect((prisma.user.create as jest.Mock).mock.calls[0][0].data.phone).toBe('+2348031234567');
    }
  );
});

// ==================
// forgotPassword / resetPassword
// ==================

describe('forgotPassword', () => {
  it('sends nothing for an admin account but answers the same way', async () => {
    givenAccount({ role: 'ADMIN' });

    const result = await forgotPassword({ email: 'ada@example.com' });

    expect(result.message).toBe('If an account exists with this email, a password reset code has been sent.');
    expect(updateUser).not.toHaveBeenCalled();
    expect(sendPasswordResetEmail).not.toHaveBeenCalled();
  });
});

describe('resetPassword', () => {
  const reset = (otp = '654321') =>
    resetPassword({ email: 'ada@example.com', otp, newPassword: 'N3w!Passw0rd' });

  const withResetCode = (overrides: Record<string, unknown> = {}) =>
    givenAccount({
      passwordResetToken: hashOtp('654321'),
      passwordResetExpiry: new Date(Date.now() + 5 * MINUTE_MS),
      ...overrides,
    });

  it.each([
    ['an unknown email', () => findUser.mockResolvedValue(null)],
    ['an account with no reset requested', () => givenAccount()],
    ['an admin account', () => withResetCode({ role: 'SUPER_ADMIN' })],
  ])('answers %s like a wrong code', async (_label, arrange) => {
    arrange();

    await expect(reset()).rejects.toMatchObject({
      message: 'Invalid reset code. Please try again.',
      extensions: { code: 'INVALID_RESET_CODE' },
    });
    expect(updateUser).not.toHaveBeenCalled();
  });

  it('only reports an expired code when the code is right', async () => {
    withResetCode({ passwordResetExpiry: new Date(Date.now() - MINUTE_MS) });

    await expect(reset('000000')).rejects.toMatchObject({ extensions: { code: 'INVALID_RESET_CODE' } });
    await expect(reset()).rejects.toMatchObject({ extensions: { code: 'RESET_EXPIRED' } });
  });

  it('ends every session, including stored refresh tokens', async () => {
    withResetCode({ failedLoginAttempts: 5, lockoutUntil: new Date(Date.now() + MINUTE_MS) });

    await reset();

    expect(lastUpdateData()).toMatchObject({
      password: hashed('N3w!Passw0rd'),
      failedLoginAttempts: 0,
      lockoutUntil: null,
      tokenInvalidatedAt: expect.any(Date),
    });
    expect(endAllSessions).toHaveBeenCalledWith(USER_ID);
  });
});

// ==================
// changePassword
// ==================

describe('changePassword', () => {
  const change = (currentPassword: string) =>
    changePassword(USER_ID, { currentPassword, newPassword: 'N3w!Passw0rd' });

  it('counts a wrong current password toward the lockout', async () => {
    givenAccount({ failedLoginAttempts: 1 });

    await expect(change('Wrong!Pass1')).rejects.toMatchObject({
      message: 'Current password is incorrect',
      extensions: { code: 'INVALID_PASSWORD' },
    });
    expect(lastUpdateData()).toEqual({ failedLoginAttempts: 2, lockoutUntil: null });
  });

  it('locks the account after too many wrong current passwords', async () => {
    givenAccount({ failedLoginAttempts: config.security.maxLoginAttempts - 1 });

    await expect(change('Wrong!Pass1')).rejects.toMatchObject({ extensions: { code: 'ACCOUNT_LOCKED' } });
  });

  it("refuses while the account is locked, without checking the password", async () => {
    givenAccount({ lockoutUntil: new Date(Date.now() + MINUTE_MS) });

    await expect(change(PASSWORD)).rejects.toMatchObject({ extensions: { code: 'ACCOUNT_LOCKED' } });
    expect(comparePassword).not.toHaveBeenCalled();
  });

  it('ends every session, including stored refresh tokens', async () => {
    givenAccount({ failedLoginAttempts: 2 });

    await change(PASSWORD);

    expect(lastUpdateData()).toMatchObject({
      password: hashed('N3w!Passw0rd'),
      failedLoginAttempts: 0,
      tokenInvalidatedAt: expect.any(Date),
    });
    expect(endAllSessions).toHaveBeenCalledWith(USER_ID);
  });
});

// ==================
// refreshToken
// ==================

describe('refreshAccessToken', () => {
  const payload: JWTPayload = { userId: USER_ID, email: 'ada@example.com', role: 'SERVICE_USER' };

  beforeEach(() => {
    (checkRefreshToken as jest.Mock).mockResolvedValue({ status: 'active', userId: USER_ID });
  });

  it('returns a new access token and the full user', async () => {
    givenAccount();

    const result = await refreshAccessToken(generateRefreshToken(payload));

    expect(verifyAccessToken(result.accessToken).userId).toBe(USER_ID);
    expect(result.user).toMatchObject({ isEmailVerified: true, pushEnabled: false, activeRole: 'SERVICE_USER' });
  });

  it('accepts a signed, unexpired token while the token store is unavailable', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    (checkRefreshToken as jest.Mock).mockResolvedValue({ status: 'unavailable' });
    givenAccount();

    await expect(refreshAccessToken(generateRefreshToken(payload))).resolves.toHaveProperty('accessToken');
    expect(warn).toHaveBeenCalled();
  });

  it('still refuses a revoked token', async () => {
    (checkRefreshToken as jest.Mock).mockResolvedValue({ status: 'revoked' });
    givenAccount();

    await expect(refreshAccessToken(generateRefreshToken(payload))).rejects.toMatchObject({
      message: 'Refresh token has been invalidated',
    });
  });

  it('refuses a token issued before the account sessions were ended', async () => {
    const token = generateRefreshToken(payload);
    givenAccount({ tokenInvalidatedAt: new Date(Date.now() + 1000) });

    await expect(refreshAccessToken(token)).rejects.toMatchObject({
      message: 'Refresh token has been invalidated',
      extensions: { code: 'INVALID_REFRESH_TOKEN' },
    });
  });

  it('keeps a token issued moments after the sessions were ended', async () => {
    givenAccount({ tokenInvalidatedAt: new Date(Date.now() - 1) });

    await expect(refreshAccessToken(generateRefreshToken(payload))).resolves.toHaveProperty('accessToken');
  });

  it.each([
    ['an admin', { role: 'ADMIN' }],
    ['a deactivated', { status: 'DEACTIVATED' }],
    ['a deleted', { deletedAt: new Date() }],
  ])('refuses %s account', async (_label, state) => {
    givenAccount(state);

    await expect(refreshAccessToken(generateRefreshToken(payload))).rejects.toMatchObject({
      message: 'Invalid refresh token',
    });
  });

  it('refuses a token with a bad signature before looking it up', async () => {
    await expect(refreshAccessToken('not.a.token')).rejects.toMatchObject({
      message: 'Invalid or expired refresh token',
    });
    expect(checkRefreshToken).not.toHaveBeenCalled();
  });
});

// ==================
// logout
// ==================

describe('logout', () => {
  it('revokes the access token and the refresh token', async () => {
    const session = { payload: { userId: USER_ID, email: 'ada@example.com', role: 'SERVICE_USER' as const, jti: 'abc' }, accessToken: 'access-token' };

    await expect(logout('refresh-token', session)).resolves.toEqual({
      success: true,
      message: 'Logged out successfully.',
    });
    expect(revokeAccessToken).toHaveBeenCalledWith(session.payload, 'access-token');
    expect(invalidateRefreshToken).toHaveBeenCalledWith('refresh-token');
  });

  it('revokes the access token when no refresh token is passed', async () => {
    const payloadOnly = { userId: USER_ID, email: 'ada@example.com', role: 'SERVICE_USER' as const };

    await logout(undefined, { payload: payloadOnly, accessToken: null });

    expect(revokeAccessToken).toHaveBeenCalledWith(payloadOnly, undefined);
    expect(invalidateRefreshToken).not.toHaveBeenCalled();
  });
});
