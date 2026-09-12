/**
 * Authentication Service
 * Handles user authentication with email verification
 *
 * Security features:
 * - Email verification with 6-digit OTP
 * - Account lockout after failed attempts, at sign-in and when a signed-in user
 *   confirms their password
 * - Rate limiting ready
 * - Secure password hashing
 * - JWT with refresh tokens
 * - Login activity tracking
 * - Input validation with Zod
 * - Refresh token storage and invalidation, and access token revocation at sign-out
 * - Sign-in and password reset responses that don't reveal whether an email is registered
 */

import { randomBytes } from 'crypto';
import { GraphQLError } from 'graphql';
import type { Prisma } from '@prisma/client';
import prisma from '@/lib/prisma';
import {
  hashPassword,
  comparePassword,
  generateToken,
  generateRefreshToken,
  verifyRefreshToken,
  getTokenIssuedAtMs,
  type JWTPayload,
} from '@/lib/auth';
import {
  generateOtp,
  hashOtp,
  verifyOtp,
  getOtpExpiry,
  isOtpExpired,
} from '@/lib/otp';
import {
  sendVerificationEmail,
  sendPasswordResetEmail,
  sendLoginAlertEmail,
} from '@/lib/email';
import { config } from '@/config';
import { ErrorCode, ErrorMessage, UserRole, AccountStatus } from '@/constants';
import { assertAcceptableText } from '@/lib/content-filter';
import { getClientIp as getProxiedClientIp } from '@/middleware/rate-limit.middleware';
import {
  registerUserSchema,
  loginSchema,
  passwordSchema,
} from '@/utils/validation';
import {
  storeRefreshToken,
  checkRefreshToken,
  invalidateRefreshToken,
  endAllSessions,
  revokeAccessToken,
} from './token.service';
import {
  validateName,
  validateEmail as validateEmailSecurity,
  validatePhone,
  validatePassword as validatePasswordSecurity,
  enforceRateLimit,
  incrementRateLimit,
  resetRateLimit,
  isTokenValid,
  isIssuedAfter,
  logSecurityEvent,
  isBanActive,
} from '@/utils/security';

// ==================
// Types
// ==================

interface RegisterInput {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  phone?: string | null;
}

interface LoginInput {
  email: string;
  password: string;
}

interface VerifyEmailInput {
  email: string;
  otp: string;
}

interface ResendOtpInput {
  email: string;
}

interface ForgotPasswordInput {
  email: string;
}

interface ResetPasswordInput {
  email: string;
  otp: string;
  newPassword: string;
}

// ==================
// Helper Functions
// ==================

const REGISTRATION_MESSAGE =
  'Registration successful! Please check your email for the verification code.';
const FORGOT_PASSWORD_MESSAGE =
  'If an account exists with this email, a password reset code has been sent.';

/**
 * Check if account is locked
 */
const isAccountLocked = (lockoutUntil: Date | null): boolean => {
  if (!lockoutUntil) return false;
  return new Date() < lockoutUntil;
};

/**
 * Admin accounts sign in, refresh and reset passwords with the admin operations only
 */
const isAdminRole = (role: string): boolean =>
  role === UserRole.ADMIN || role === UserRole.SUPER_ADMIN;

/**
 * Get client IP from request (for logging). Uses the same trusted-proxy rule as
 * rate limiting, so a client can't put a made-up address in login alerts and
 * audit logs.
 */
export const getClientIp = (request?: Request): string =>
  request ? getProxiedClientIp(request) : 'unknown';

/**
 * Validate input and throw GraphQL error if invalid
 */
const validateInput = <T>(schema: { safeParse: (data: unknown) => { success: boolean; error?: { issues: Array<{ message: string }> }; data?: T } }, data: unknown): T => {
  const result = schema.safeParse(data);
  if (!result.success) {
    const errorMessage = result.error?.issues[0]?.message || 'Invalid input';
    throw new GraphQLError(errorMessage, {
      extensions: { code: 'VALIDATION_ERROR' },
    });
  }
  return result.data as T;
};

const invalidCredentialsError = (extensions: Record<string, unknown> = {}) =>
  new GraphQLError(ErrorMessage[ErrorCode.INVALID_CREDENTIALS], {
    extensions: { code: ErrorCode.INVALID_CREDENTIALS, ...extensions },
  });

/**
 * The account is still locked from earlier failed attempts
 */
const accountLockedError = (lockoutUntil: Date) =>
  new GraphQLError(
    `Account is locked due to too many failed attempts. Please try again in ${Math.ceil(
      (lockoutUntil.getTime() - Date.now()) / (1000 * 60)
    )} minutes.`,
    { extensions: { code: 'ACCOUNT_LOCKED' } }
  );

/**
 * This failed attempt locked the account
 */
const lockedNowError = () =>
  new GraphQLError(
    `Account locked due to too many failed attempts. Please try again in ${config.security.lockoutDurationMinutes} minutes.`,
    { extensions: { code: 'ACCOUNT_LOCKED' } }
  );

/**
 * A bcrypt hash of a random password, checked when there is no account the
 * sign-in can use, so an unknown email takes as long as a wrong password
 */
let decoyPasswordHash: Promise<string> | undefined;
const getDecoyPasswordHash = (): Promise<string> =>
  (decoyPasswordHash ??= hashPassword(randomBytes(24).toString('hex')));

type LockoutState = {
  id: string;
  failedLoginAttempts: number;
  lockoutUntil: Date | null;
};

/**
 * Count a wrong password toward the lockout. Once an earlier lockout has ended
 * the count starts again, so a single wrong password doesn't lock the account
 * straight back up.
 */
const recordFailedPassword = async (user: LockoutState) => {
  const previousFailures =
    user.lockoutUntil && !isAccountLocked(user.lockoutUntil) ? 0 : user.failedLoginAttempts;
  const failedAttempts = previousFailures + 1;
  const locked = failedAttempts >= config.security.maxLoginAttempts;

  await prisma.user.update({
    where: { id: user.id },
    data: {
      failedLoginAttempts: failedAttempts,
      lockoutUntil: locked
        ? new Date(Date.now() + config.security.lockoutDurationMinutes * 60 * 1000)
        : null,
    },
  });

  return {
    locked,
    attemptsRemaining: Math.max(0, config.security.maxLoginAttempts - failedAttempts),
  };
};

/**
 * Check a signed-in user's password before a sensitive change (changing the
 * password, deleting the account). Wrong passwords count toward the same
 * lockout as sign-in, and a locked account can't make the change until the
 * lockout ends.
 */
export const confirmAccountPassword = async (
  user: LockoutState & { password: string },
  password: string,
  wrongPassword: { code: string; message: string }
): Promise<void> => {
  if (isAccountLocked(user.lockoutUntil)) {
    throw accountLockedError(user.lockoutUntil as Date);
  }

  if (await comparePassword(password, user.password)) {
    return;
  }

  const { locked } = await recordFailedPassword(user);

  logSecurityEvent('AUTH_FAILURE', {
    userId: user.id,
    reason: 'Wrong password confirming an account change',
  });

  if (locked) {
    throw lockedNowError();
  }

  throw new GraphQLError(wrongPassword.message, {
    extensions: { code: wrongPassword.code },
  });
};

/**
 * Every User field the API returns, for responses that include the account
 */
const USER_RESPONSE_SELECT = {
  id: true,
  email: true,
  firstName: true,
  lastName: true,
  phone: true,
  profilePhoto: true,
  role: true,
  activeRole: true,
  status: true,
  isEmailVerified: true,
  pushEnabled: true,
  lastLoginAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

type UserResponseRecord = Prisma.UserGetPayload<{ select: typeof USER_RESPONSE_SELECT }>;

const formatUserResponse = (user: UserResponseRecord) => ({
  id: user.id,
  email: user.email,
  firstName: user.firstName,
  lastName: user.lastName,
  phone: user.phone,
  profilePhoto: user.profilePhoto,
  role: user.role,
  activeRole: user.activeRole ?? user.role,
  status: user.status,
  isEmailVerified: user.isEmailVerified,
  pushEnabled: user.pushEnabled ?? true,
  lastLoginAt: user.lastLoginAt ? user.lastLoginAt.toISOString() : null,
  createdAt: user.createdAt,
  updatedAt: user.updatedAt,
});

/**
 * Issue an access and refresh token pair, storing the refresh token so
 * `refreshToken` accepts it
 */
const startSession = async (
  user: { id: string; email: string; role: JWTPayload['role'] },
  clientIp?: string
) => {
  const tokenPayload: JWTPayload = {
    userId: user.id,
    email: user.email,
    role: user.role,
  };

  const accessToken = generateToken(tokenPayload);
  const refreshToken = generateRefreshToken(tokenPayload);

  await storeRefreshToken(user.id, refreshToken, {
    deviceInfo: 'web',
    ipAddress: clientIp,
  });

  return { accessToken, refreshToken };
};

// ==================
// Authentication Functions
// ==================

/**
 * Register a new user
 * Creates unverified account and sends OTP email
 */
export const registerUser = async (input: RegisterInput) => {
  // Validate input with Zod schema
  const validatedInput = validateInput(registerUserSchema, input);
  const { email, password, firstName, lastName, phone } = validatedInput;

  // Additional security validation and sanitization
  const sanitizedEmail = validateEmailSecurity(email);
  const sanitizedFirstName = validateName(firstName, 'First name');
  const sanitizedLastName = validateName(lastName, 'Last name');
  assertAcceptableText(sanitizedFirstName, 'First name');
  assertAcceptableText(sanitizedLastName, 'Last name');
  const sanitizedPhone = phone?.trim() ? validatePhone(phone) : undefined;

  // Validate password strength
  validatePasswordSecurity(password);

  // Rate limiting for registration (prevent mass account creation)
  await enforceRateLimit('REGISTER', sanitizedEmail);
  await incrementRateLimit('REGISTER', sanitizedEmail);

  // Normalize email
  const normalizedEmail = sanitizedEmail.toLowerCase().trim();

  // Check if user already exists
  const existingUser = await prisma.user.findUnique({
    where: { email: normalizedEmail },
  });

  if (existingUser) {
    // An unverified account gets a new code, but its password and details stay
    // as they are: only the owner of the email can finish that sign-up
    if (!existingUser.isEmailVerified && !isAdminRole(existingUser.role)) {
      const otp = generateOtp();

      await prisma.user.update({
        where: { id: existingUser.id },
        data: {
          emailVerifyToken: hashOtp(otp),
          emailVerifyExpiry: getOtpExpiry(),
        },
      });

      const emailSent = await sendVerificationEmail(normalizedEmail, existingUser.firstName, otp);

      if (!emailSent) {
        console.error('Failed to send verification email to:', normalizedEmail);
      }

      return {
        success: true,
        message: REGISTRATION_MESSAGE,
        requiresVerification: true,
      };
    }

    throw new GraphQLError(ErrorMessage[ErrorCode.USER_ALREADY_EXISTS], {
      extensions: { code: ErrorCode.USER_ALREADY_EXISTS },
    });
  }

  // Hash password
  const hashedPassword = await hashPassword(password);

  // Generate OTP
  const otp = generateOtp();
  const hashedOtp = hashOtp(otp);
  const otpExpiry = getOtpExpiry();

  // Create user (unverified)
  await prisma.user.create({
    data: {
      email: normalizedEmail,
      password: hashedPassword,
      firstName: sanitizedFirstName,
      lastName: sanitizedLastName,
      phone: sanitizedPhone,
      role: UserRole.SERVICE_USER,
      status: AccountStatus.PENDING,
      isEmailVerified: false,
      emailVerifyToken: hashedOtp,
      emailVerifyExpiry: otpExpiry,
    },
  });

  // Send verification email
  const emailSent = await sendVerificationEmail(normalizedEmail, sanitizedFirstName, otp);

  if (!emailSent) {
    console.error('Failed to send verification email to:', normalizedEmail);
  }

  return {
    success: true,
    message: REGISTRATION_MESSAGE,
    requiresVerification: true,
  };
};

/**
 * Verify email with OTP
 */
export const verifyEmail = async (input: VerifyEmailInput) => {
  const { email, otp } = input;
  const normalizedEmail = email.toLowerCase().trim();

  // Rate limiting for OTP verification
  await enforceRateLimit('OTP_VERIFY', normalizedEmail);

  // Find user
  const user = await prisma.user.findUnique({
    where: { email: normalizedEmail },
  });

  if (!user) {
    await incrementRateLimit('OTP_VERIFY', normalizedEmail);
    throw new GraphQLError(ErrorMessage[ErrorCode.USER_NOT_FOUND], {
      extensions: { code: ErrorCode.USER_NOT_FOUND },
    });
  }

  // Check if already verified
  if (user.isEmailVerified) {
    throw new GraphQLError('Email is already verified', {
      extensions: { code: 'ALREADY_VERIFIED' },
    });
  }

  // Check if OTP exists
  if (!user.emailVerifyToken) {
    throw new GraphQLError('No verification code found. Please request a new one.', {
      extensions: { code: 'OTP_NOT_FOUND' },
    });
  }

  // Check if OTP expired
  if (isOtpExpired(user.emailVerifyExpiry)) {
    throw new GraphQLError('Verification code has expired. Please request a new one.', {
      extensions: { code: 'OTP_EXPIRED' },
    });
  }

  // Verify OTP
  const isValidOtp = verifyOtp(otp, user.emailVerifyToken);

  if (!isValidOtp) {
    await incrementRateLimit('OTP_VERIFY', normalizedEmail);
    logSecurityEvent('AUTH_FAILURE', {
      userId: user.id,
      reason: 'Invalid email verification OTP',
    });
    throw new GraphQLError('Invalid verification code. Please try again.', {
      extensions: { code: 'INVALID_OTP' },
    });
  }

  // Reset rate limits on success
  await resetRateLimit('OTP_VERIFY', normalizedEmail);

  // Verification activates a new account only: an account an admin suspended
  // stays suspended
  const updatedUser = await prisma.user.update({
    where: { id: user.id },
    data: {
      isEmailVerified: true,
      emailVerifyToken: null,
      emailVerifyExpiry: null,
      ...(user.status === AccountStatus.PENDING && { status: AccountStatus.ACTIVE }),
    },
    select: USER_RESPONSE_SELECT,
  });

  // No session for an account that can't be used: signing in shows the reason
  if (
    updatedUser.status !== AccountStatus.ACTIVE ||
    isBanActive(user) ||
    isAdminRole(user.role)
  ) {
    return {
      success: true,
      message: 'Email verified successfully! Please sign in to continue.',
      user: formatUserResponse(updatedUser),
      accessToken: null,
      refreshToken: null,
    };
  }

  const tokens = await startSession(updatedUser);

  return {
    success: true,
    message: 'Email verified successfully!',
    user: formatUserResponse(updatedUser),
    ...tokens,
  };
};

/**
 * Resend verification OTP
 */
export const resendVerificationOtp = async (input: ResendOtpInput) => {
  const { email } = input;
  const normalizedEmail = email.toLowerCase().trim();

  // Rate limiting to prevent OTP flooding
  await enforceRateLimit('OTP_RESEND', normalizedEmail);
  await incrementRateLimit('OTP_RESEND', normalizedEmail);

  // Find user
  const user = await prisma.user.findUnique({
    where: { email: normalizedEmail },
  });

  if (!user) {
    // Don't reveal if user exists or not for security
    return {
      success: true,
      message: 'If an account exists with this email, a verification code has been sent.',
    };
  }

  // Check if already verified
  if (user.isEmailVerified) {
    throw new GraphQLError('Email is already verified. Please login.', {
      extensions: { code: 'ALREADY_VERIFIED' },
    });
  }

  // Generate new OTP
  const otp = generateOtp();
  const hashedOtp = hashOtp(otp);
  const otpExpiry = getOtpExpiry();

  // Update user
  await prisma.user.update({
    where: { id: user.id },
    data: {
      emailVerifyToken: hashedOtp,
      emailVerifyExpiry: otpExpiry,
    },
  });

  // Send verification email
  await sendVerificationEmail(normalizedEmail, user.firstName, otp);

  return {
    success: true,
    message: 'A new verification code has been sent to your email.',
  };
};

/**
 * Login user
 *
 * The password is checked before anything about the account is revealed, so
 * someone without it can't learn whether an email is registered, locked,
 * unverified, suspended or deactivated. Signing in to a deactivated account
 * reactivates it.
 */
export const loginUser = async (input: LoginInput, clientIp?: string) => {
  // Validate input
  const validatedInput = validateInput(loginSchema, input);
  const { email, password } = validatedInput;
  const normalizedEmail = email.toLowerCase().trim();

  // Rate limiting - check before any database operations
  await enforceRateLimit('LOGIN', normalizedEmail);

  // Find user
  const user = await prisma.user.findUnique({
    where: { email: normalizedEmail },
  });

  // No account this sign-in can use: admins sign in with adminLogin, and deleted
  // accounts can't sign in. Same error, and the same hashing work, as a wrong
  // password; the admin account's failed-attempt count isn't touched.
  if (!user || isAdminRole(user.role) || user.deletedAt) {
    await comparePassword(password, await getDecoyPasswordHash());
    await incrementRateLimit('LOGIN', normalizedEmail);
    logSecurityEvent('AUTH_FAILURE', {
      userId: user?.id,
      reason: !user
        ? 'User not found'
        : user.deletedAt
          ? 'Deleted account'
          : 'Admin account used the customer sign-in',
      input: { email: normalizedEmail },
      ip: clientIp,
    });
    throw invalidCredentialsError();
  }

  const lockedOut = isAccountLocked(user.lockoutUntil);
  const isValidPassword = await comparePassword(password, user.password);

  if (!isValidPassword) {
    // Increment rate limit for failed password
    await incrementRateLimit('LOGIN', normalizedEmail);

    logSecurityEvent('AUTH_FAILURE', {
      userId: user.id,
      reason: 'Invalid password',
      ip: clientIp,
    });

    // During a lockout a wrong password doesn't extend it or say it's in force
    if (lockedOut) {
      throw invalidCredentialsError();
    }

    const { locked, attemptsRemaining } = await recordFailedPassword(user);

    if (locked) {
      throw lockedNowError();
    }

    throw invalidCredentialsError({ attemptsRemaining });
  }

  // The password is right, so the account's state can be shown
  if (lockedOut) {
    throw accountLockedError(user.lockoutUntil as Date);
  }

  if (!user.isEmailVerified) {
    throw new GraphQLError(
      'Please verify your email before logging in. Check your inbox for the verification code.',
      { extensions: { code: 'EMAIL_NOT_VERIFIED', requiresVerification: true } }
    );
  }

  if (user.status === AccountStatus.SUSPENDED) {
    throw new GraphQLError(
      'Your account has been suspended. Please contact support.',
      { extensions: { code: ErrorCode.USER_SUSPENDED } }
    );
  }

  if (isBanActive(user)) {
    throw new GraphQLError('Your account has been banned. Please contact support.', {
      extensions: { code: 'ACCOUNT_BANNED' },
    });
  }

  // Signing in reactivates an account its owner deactivated
  const reactivate = user.status === AccountStatus.DEACTIVATED;

  // Reset failed attempts, rate limits, and update login info
  await resetRateLimit('LOGIN', normalizedEmail);

  const signedIn = await prisma.user.update({
    where: { id: user.id },
    data: {
      failedLoginAttempts: 0,
      lockoutUntil: null,
      lastLoginAt: new Date(),
      lastLoginIp: clientIp || 'unknown',
      ...(reactivate && {
        status: AccountStatus.ACTIVE,
        deactivatedAt: null,
        deactivationReason: null,
      }),
    },
    select: USER_RESPONSE_SELECT,
  });

  // Send login alert email (async, don't wait)
  if (clientIp && config.isProduction) {
    sendLoginAlertEmail(signedIn.email, signedIn.firstName, clientIp).catch(console.error);
  }

  const tokens = await startSession(signedIn, clientIp);

  return {
    user: formatUserResponse(signedIn),
    ...tokens,
  };
};

/**
 * Request password reset
 */
export const forgotPassword = async (input: ForgotPasswordInput) => {
  const { email } = input;
  const normalizedEmail = email.toLowerCase().trim();

  // Rate limiting to prevent abuse
  await enforceRateLimit('PASSWORD_RESET', normalizedEmail);
  await incrementRateLimit('PASSWORD_RESET', normalizedEmail);

  // Find user
  const user = await prisma.user.findUnique({
    where: { email: normalizedEmail },
  });

  // Always return the same success to prevent email enumeration. Admin accounts
  // reset their password with adminForgotPassword, so nothing is sent for them.
  if (!user || isAdminRole(user.role) || user.deletedAt) {
    return {
      success: true,
      message: FORGOT_PASSWORD_MESSAGE,
    };
  }

  // Generate OTP
  const otp = generateOtp();
  const hashedOtp = hashOtp(otp);
  const otpExpiry = getOtpExpiry();

  // Update user
  await prisma.user.update({
    where: { id: user.id },
    data: {
      passwordResetToken: hashedOtp,
      passwordResetExpiry: otpExpiry,
    },
  });

  // Send password reset email
  await sendPasswordResetEmail(normalizedEmail, user.firstName, otp);

  return {
    success: true,
    message: FORGOT_PASSWORD_MESSAGE,
  };
};

/**
 * Reset password with OTP
 */
export const resetPassword = async (input: ResetPasswordInput) => {
  const { email, otp, newPassword } = input;

  // Validate new password strength
  const passwordValidation = passwordSchema.safeParse(newPassword);
  if (!passwordValidation.success) {
    throw new GraphQLError(passwordValidation.error.issues[0]?.message || 'Invalid password', {
      extensions: { code: 'VALIDATION_ERROR' },
    });
  }

  const normalizedEmail = email.toLowerCase().trim();

  // Rate limiting for OTP verification
  await enforceRateLimit('OTP_VERIFY', normalizedEmail);

  // Find user
  const user = await prisma.user.findUnique({
    where: { email: normalizedEmail },
  });

  // An unknown email, an admin account, no reset request and a wrong code all
  // get the same error, so the response doesn't reveal whether the email is
  // registered
  const resetToken =
    user && !isAdminRole(user.role) && !user.deletedAt ? user.passwordResetToken : null;

  if (!user || !resetToken || !verifyOtp(otp, resetToken)) {
    await incrementRateLimit('OTP_VERIFY', normalizedEmail);
    logSecurityEvent('AUTH_FAILURE', {
      userId: user?.id,
      reason: 'Invalid password reset OTP',
    });
    throw new GraphQLError('Invalid reset code. Please try again.', {
      extensions: { code: 'INVALID_RESET_CODE' },
    });
  }

  // Only someone holding the right code learns that it has expired
  if (isOtpExpired(user.passwordResetExpiry)) {
    throw new GraphQLError('Password reset code has expired. Please request a new one.', {
      extensions: { code: 'RESET_EXPIRED' },
    });
  }

  // Reset rate limits on success
  await resetRateLimit('OTP_VERIFY', normalizedEmail);
  await resetRateLimit('PASSWORD_RESET', normalizedEmail);

  // Hash new password
  const hashedPassword = await hashPassword(newPassword);

  // Update user, ending every session (the timestamp keeps working while Redis is down)
  await prisma.user.update({
    where: { id: user.id },
    data: {
      password: hashedPassword,
      passwordResetToken: null,
      passwordResetExpiry: null,
      // Reset failed attempts on password change
      failedLoginAttempts: 0,
      lockoutUntil: null,
      tokenInvalidatedAt: new Date(),
    },
  });

  // Revoke stored refresh tokens and reject earlier access tokens
  await endAllSessions(user.id);

  return {
    success: true,
    message: 'Password has been reset successfully. You can now login with your new password.',
  };
};

const refreshTokenError = (message: string) =>
  new GraphQLError(message, {
    extensions: { code: 'INVALID_REFRESH_TOKEN' },
  });

/**
 * Refresh access token
 *
 * The refresh token isn't rotated: the response has no field for a new one.
 */
export const refreshAccessToken = async (refreshToken: string) => {
  let payload: JWTPayload;

  try {
    payload = verifyRefreshToken(refreshToken);
  } catch {
    throw refreshTokenError('Invalid or expired refresh token');
  }

  const record = await checkRefreshToken(refreshToken);

  if (record.status === 'revoked') {
    throw refreshTokenError('Refresh token has been invalidated');
  }

  if (record.status === 'unavailable') {
    // Signed and unexpired; the account checks below still apply
    console.warn(
      `Token store unavailable: accepting a signed refresh token for user ${payload.userId}`
    );
  } else if (record.userId !== payload.userId) {
    throw refreshTokenError('Token mismatch');
  }

  if (payload.iat && !(await isTokenValid(payload.userId, payload.iat, payload.iatMs))) {
    throw refreshTokenError('Refresh token has been invalidated');
  }

  // Find user to make sure they still exist and are active
  const user = await prisma.user.findUnique({
    where: { id: payload.userId },
  });

  if (
    !user ||
    user.deletedAt ||
    isAdminRole(user.role) ||
    user.status !== AccountStatus.ACTIVE ||
    isBanActive(user)
  ) {
    throw refreshTokenError('Invalid refresh token');
  }

  // Sessions ended by a password change or reset, deactivation, or an admin
  if (
    user.tokenInvalidatedAt &&
    !isIssuedAfter(getTokenIssuedAtMs(payload), user.tokenInvalidatedAt.getTime())
  ) {
    throw refreshTokenError('Refresh token has been invalidated');
  }

  // Generate new access token
  const accessToken = generateToken({
    userId: user.id,
    email: user.email,
    role: user.role,
  });

  return {
    accessToken,
    user: formatUserResponse(user),
  };
};

/**
 * Get current user
 */
export const getCurrentUser = async (userId: string) => {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      firstName: true,
      lastName: true,
      phone: true,
      profilePhoto: true,
      role: true,
      activeRole: true,
      status: true,
      isEmailVerified: true,
      pushEnabled: true,
      lastLoginAt: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  if (!user) {
    throw new GraphQLError(ErrorMessage[ErrorCode.USER_NOT_FOUND], {
      extensions: { code: ErrorCode.USER_NOT_FOUND },
    });
  }

  // Return with computed fields
  return {
    ...user,
    activeRole: user.activeRole || user.role,
    pushEnabled: user.pushEnabled ?? true,
    lastLoginAt: user.lastLoginAt ? user.lastLoginAt.toISOString() : null,
  };
};

/**
 * Change password (authenticated user)
 */
export const changePassword = async (
  userId: string,
  input: { currentPassword: string; newPassword: string }
) => {
  const { currentPassword, newPassword } = input;

  // Validate new password
  const passwordValidation = passwordSchema.safeParse(newPassword);
  if (!passwordValidation.success) {
    throw new GraphQLError(passwordValidation.error.issues[0]?.message || 'Invalid password', {
      extensions: { code: 'VALIDATION_ERROR' },
    });
  }

  // Find user
  const user = await prisma.user.findUnique({
    where: { id: userId },
  });

  if (!user) {
    throw new GraphQLError(ErrorMessage[ErrorCode.USER_NOT_FOUND], {
      extensions: { code: ErrorCode.USER_NOT_FOUND },
    });
  }

  // Verify current password (wrong attempts count toward the sign-in lockout)
  await confirmAccountPassword(user, currentPassword, {
    code: 'INVALID_PASSWORD',
    message: 'Current password is incorrect',
  });

  // Check if new password is same as current
  const isSamePassword = await comparePassword(newPassword, user.password);
  if (isSamePassword) {
    throw new GraphQLError('New password must be different from current password', {
      extensions: { code: 'SAME_PASSWORD' },
    });
  }

  // Hash new password
  const hashedPassword = await hashPassword(newPassword);

  // Update password, ending every session (the timestamp keeps working while Redis is down)
  await prisma.user.update({
    where: { id: userId },
    data: {
      password: hashedPassword,
      failedLoginAttempts: 0,
      lockoutUntil: null,
      tokenInvalidatedAt: new Date(),
    },
  });

  // Revoke stored refresh tokens and reject earlier access tokens: this forces
  // re-login on all devices. Tokens issued from here on are unaffected.
  await endAllSessions(userId);

  return {
    success: true,
    message: 'Password changed successfully. Please login again on all devices.',
  };
};

/**
 * Logout: revoke the access token the request was made with and, when the app
 * passes it, the refresh token. Always succeeds.
 */
export const logout = async (
  refreshToken?: string | null,
  session?: { payload: JWTPayload; accessToken?: string | null }
): Promise<{ success: boolean; message: string }> => {
  await Promise.all([
    session ? revokeAccessToken(session.payload, session.accessToken ?? undefined) : undefined,
    refreshToken ? invalidateRefreshToken(refreshToken) : undefined,
  ]);

  return {
    success: true,
    message: 'Logged out successfully.',
  };
};

const authService = {
  registerUser,
  verifyEmail,
  resendVerificationOtp,
  loginUser,
  forgotPassword,
  resetPassword,
  refreshAccessToken,
  getCurrentUser,
  changePassword,
  confirmAccountPassword,
  logout,
  getClientIp,
};

export default authService;
