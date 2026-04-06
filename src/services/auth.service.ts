/**
 * Authentication Service
 * Handles user authentication with email verification
 * 
 * Security features:
 * - Email verification with 6-digit OTP
 * - Account lockout after failed attempts
 * - Rate limiting ready
 * - Secure password hashing
 * - JWT with refresh tokens
 * - Login activity tracking
 * - Input validation with Zod
 * - Refresh token storage and invalidation
 */

import { GraphQLError } from 'graphql';
import prisma from '@/lib/prisma';
import {
  hashPassword,
  comparePassword,
  generateToken,
  generateRefreshToken,
  verifyToken,
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
import {
  registerUserSchema,
  loginSchema,
  emailSchema,
  passwordSchema,
} from '@/utils/validation';
import { storeRefreshToken, validateRefreshToken, invalidateRefreshToken } from './token.service';
import { 
  validateName, 
  validateEmail as validateEmailSecurity, 
  validatePhone, 
  validatePassword as validatePasswordSecurity,
  enforceRateLimit,
  incrementRateLimit,
  resetRateLimit,
  invalidateAllUserTokens,
  logSecurityEvent,
} from '@/utils/security';

// ==================
// Types
// ==================

interface RegisterInput {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  phone?: string;
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

/**
 * Check if account is locked
 */
const isAccountLocked = (lockoutUntil: Date | null): boolean => {
  if (!lockoutUntil) return false;
  return new Date() < lockoutUntil;
};

/**
 * Get client IP from request (for logging)
 */
export const getClientIp = (request?: Request): string => {
  if (!request) return 'unknown';
  
  // Check various headers for IP (common in proxied environments)
  const forwardedFor = request.headers.get('x-forwarded-for');
  if (forwardedFor) {
    return forwardedFor.split(',')[0].trim();
  }
  
  const realIp = request.headers.get('x-real-ip');
  if (realIp) {
    return realIp;
  }
  
  return 'unknown';
};

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
  const sanitizedPhone = phone ? validatePhone(phone) : undefined;
  
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
    // If user exists but email not verified, allow re-registration
    if (!existingUser.isEmailVerified) {
      // Generate new OTP
      const otp = generateOtp();
      const hashedOtp = hashOtp(otp);
      const otpExpiry = getOtpExpiry();

      // Update user with new OTP and possibly new details
      const hashedPassword = await hashPassword(password);
      
      await prisma.user.update({
        where: { id: existingUser.id },
        data: {
          password: hashedPassword,
          firstName: sanitizedFirstName,
          lastName: sanitizedLastName,
          phone: sanitizedPhone,
          emailVerifyToken: hashedOtp,
          emailVerifyExpiry: otpExpiry,
        },
      });

      // Send verification email
      await sendVerificationEmail(normalizedEmail, sanitizedFirstName, otp);

      return {
        success: true,
        message: 'Verification code sent to your email. Please check your inbox.',
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
    message: 'Registration successful! Please check your email for the verification code.',
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

  // Update user - mark as verified
  const updatedUser = await prisma.user.update({
    where: { id: user.id },
    data: {
      isEmailVerified: true,
      emailVerifyToken: null,
      emailVerifyExpiry: null,
      status: AccountStatus.ACTIVE,
    },
    select: {
      id: true,
      email: true,
      firstName: true,
      lastName: true,
      phone: true,
      profilePhoto: true,
      role: true,
      status: true,
      isEmailVerified: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  // Generate tokens
  const tokenPayload = {
    userId: updatedUser.id,
    email: updatedUser.email,
    role: updatedUser.role,
  };

  const accessToken = generateToken(tokenPayload);
  const refreshToken = generateRefreshToken(tokenPayload);

  return {
    success: true,
    message: 'Email verified successfully!',
    user: updatedUser,
    accessToken,
    refreshToken,
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

  if (!user) {
    // Increment rate limit even for non-existent users (prevent enumeration)
    await incrementRateLimit('LOGIN', normalizedEmail);
    logSecurityEvent('AUTH_FAILURE', { 
      reason: 'User not found', 
      input: { email: normalizedEmail },
      ip: clientIp,
    });
    throw new GraphQLError(ErrorMessage[ErrorCode.INVALID_CREDENTIALS], {
      extensions: { code: ErrorCode.INVALID_CREDENTIALS },
    });
  }

  // Check if account is locked
  if (isAccountLocked(user.lockoutUntil)) {
    const minutesLeft = Math.ceil(
      (user.lockoutUntil!.getTime() - Date.now()) / (1000 * 60)
    );
    throw new GraphQLError(
      `Account is locked due to too many failed attempts. Please try again in ${minutesLeft} minutes.`,
      { extensions: { code: 'ACCOUNT_LOCKED' } }
    );
  }

  // Check if email is verified
  if (!user.isEmailVerified) {
    throw new GraphQLError(
      'Please verify your email before logging in. Check your inbox for the verification code.',
      { extensions: { code: 'EMAIL_NOT_VERIFIED', requiresVerification: true } }
    );
  }

  // Check if account is active
  if (user.status === AccountStatus.SUSPENDED) {
    throw new GraphQLError(
      'Your account has been suspended. Please contact support.',
      { extensions: { code: ErrorCode.USER_SUSPENDED } }
    );
  }

  if (user.status === AccountStatus.DEACTIVATED) {
    throw new GraphQLError(
      'Your account has been deactivated.',
      { extensions: { code: 'ACCOUNT_DEACTIVATED' } }
    );
  }

  // Verify password
  const isValidPassword = await comparePassword(password, user.password);

  if (!isValidPassword) {
    // Increment rate limit for failed password
    await incrementRateLimit('LOGIN', normalizedEmail);
    
    // Increment failed login attempts
    const newFailedAttempts = user.failedLoginAttempts + 1;
    const shouldLock = newFailedAttempts >= config.security.maxLoginAttempts;

    await prisma.user.update({
      where: { id: user.id },
      data: {
        failedLoginAttempts: newFailedAttempts,
        lockoutUntil: shouldLock
          ? new Date(Date.now() + config.security.lockoutDurationMinutes * 60 * 1000)
          : null,
      },
    });

    logSecurityEvent('AUTH_FAILURE', {
      userId: user.id,
      reason: 'Invalid password',
      ip: clientIp,
    });

    if (shouldLock) {
      throw new GraphQLError(
        `Account locked due to too many failed attempts. Please try again in ${config.security.lockoutDurationMinutes} minutes.`,
        { extensions: { code: 'ACCOUNT_LOCKED' } }
      );
    }

    throw new GraphQLError(ErrorMessage[ErrorCode.INVALID_CREDENTIALS], {
      extensions: { 
        code: ErrorCode.INVALID_CREDENTIALS,
        attemptsRemaining: config.security.maxLoginAttempts - newFailedAttempts,
      },
    });
  }

  // Reset failed attempts, rate limits, and update login info
  await resetRateLimit('LOGIN', normalizedEmail);
  
  await prisma.user.update({
    where: { id: user.id },
    data: {
      failedLoginAttempts: 0,
      lockoutUntil: null,
      lastLoginAt: new Date(),
      lastLoginIp: clientIp || 'unknown',
    },
  });

  // Send login alert email (async, don't wait)
  if (clientIp && config.isProduction) {
    sendLoginAlertEmail(user.email, user.firstName, clientIp).catch(console.error);
  }

  // Generate tokens
  const tokenPayload = {
    userId: user.id,
    email: user.email,
    role: user.role,
  };

  const accessToken = generateToken(tokenPayload);
  const refreshToken = generateRefreshToken(tokenPayload);

  // Store refresh token in Redis for validation and invalidation
  await storeRefreshToken(user.id, refreshToken, {
    deviceInfo: 'web',
    ipAddress: clientIp,
  });

  return {
    user: {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      phone: user.phone,
      profilePhoto: user.profilePhoto,
      role: user.role,
      activeRole: user.activeRole || user.role,
      status: user.status,
      isEmailVerified: user.isEmailVerified,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    },
    accessToken,
    refreshToken,
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

  // Always return success to prevent email enumeration
  if (!user) {
    return {
      success: true,
      message: 'If an account exists with this email, a password reset code has been sent.',
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
    message: 'If an account exists with this email, a password reset code has been sent.',
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

  if (!user) {
    await incrementRateLimit('OTP_VERIFY', normalizedEmail);
    throw new GraphQLError(ErrorMessage[ErrorCode.USER_NOT_FOUND], {
      extensions: { code: ErrorCode.USER_NOT_FOUND },
    });
  }

  // Check if reset token exists
  if (!user.passwordResetToken) {
    throw new GraphQLError('No password reset request found. Please request a new one.', {
      extensions: { code: 'RESET_NOT_FOUND' },
    });
  }

  // Check if token expired
  if (isOtpExpired(user.passwordResetExpiry)) {
    throw new GraphQLError('Password reset code has expired. Please request a new one.', {
      extensions: { code: 'RESET_EXPIRED' },
    });
  }

  // Verify OTP
  const isValidOtp = verifyOtp(otp, user.passwordResetToken);

  if (!isValidOtp) {
    await incrementRateLimit('OTP_VERIFY', normalizedEmail);
    logSecurityEvent('AUTH_FAILURE', {
      userId: user.id,
      reason: 'Invalid password reset OTP',
    });
    throw new GraphQLError('Invalid reset code. Please try again.', {
      extensions: { code: 'INVALID_RESET_CODE' },
    });
  }

  // Reset rate limits on success
  await resetRateLimit('OTP_VERIFY', normalizedEmail);
  await resetRateLimit('PASSWORD_RESET', normalizedEmail);

  // Hash new password
  const hashedPassword = await hashPassword(newPassword);

  // Update user
  await prisma.user.update({
    where: { id: user.id },
    data: {
      password: hashedPassword,
      passwordResetToken: null,
      passwordResetExpiry: null,
      // Reset failed attempts on password change
      failedLoginAttempts: 0,
      lockoutUntil: null,
    },
  });

  // Invalidate all existing tokens for this user (security measure)
  await invalidateAllUserTokens(user.id);

  return {
    success: true,
    message: 'Password has been reset successfully. You can now login with your new password.',
  };
};

/**
 * Refresh access token
 */
export const refreshAccessToken = async (refreshToken: string) => {
  try {
    // First validate the token is not blacklisted
    const storedUserId = await validateRefreshToken(refreshToken);
    if (!storedUserId) {
      throw new GraphQLError('Refresh token has been invalidated', {
        extensions: { code: 'INVALID_REFRESH_TOKEN' },
      });
    }

    const payload = verifyToken(refreshToken);

    // Ensure the token belongs to the claimed user
    if (payload.userId !== storedUserId) {
      throw new GraphQLError('Token mismatch', {
        extensions: { code: 'INVALID_REFRESH_TOKEN' },
      });
    }

    // Find user to make sure they still exist and are active
    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
    });

    if (!user || user.status !== AccountStatus.ACTIVE) {
      throw new GraphQLError('Invalid refresh token', {
        extensions: { code: 'INVALID_REFRESH_TOKEN' },
      });
    }

    // Generate new access token
    const tokenPayload = {
      userId: user.id,
      email: user.email,
      role: user.role,
    };

    const accessToken = generateToken(tokenPayload);

    return {
      accessToken,
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
        activeRole: user.activeRole || user.role,
        status: user.status,
      },
    };
  } catch (error) {
    if (error instanceof GraphQLError) throw error;
    throw new GraphQLError('Invalid or expired refresh token', {
      extensions: { code: 'INVALID_REFRESH_TOKEN' },
    });
  }
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

  // Verify current password
  const isValidPassword = await comparePassword(currentPassword, user.password);

  if (!isValidPassword) {
    throw new GraphQLError('Current password is incorrect', {
      extensions: { code: 'INVALID_PASSWORD' },
    });
  }

  // Check if new password is same as current
  const isSamePassword = await comparePassword(newPassword, user.password);
  if (isSamePassword) {
    throw new GraphQLError('New password must be different from current password', {
      extensions: { code: 'SAME_PASSWORD' },
    });
  }

  // Hash new password
  const hashedPassword = await hashPassword(newPassword);

  // Update password
  await prisma.user.update({
    where: { id: userId },
    data: {
      password: hashedPassword,
    },
  });

  // Invalidate all existing tokens for security
  // This forces re-login on all devices after password change
  await invalidateAllUserTokens(userId);

  return {
    success: true,
    message: 'Password changed successfully. Please login again on all devices.',
  };
};

/**
 * Logout - invalidate refresh token
 */
export const logout = async (refreshToken?: string): Promise<{ success: boolean; message: string }> => {
  if (refreshToken) {
    await invalidateRefreshToken(refreshToken);
  }
  
  return {
    success: true,
    message: 'Logged out successfully.',
  };
};

export default {
  registerUser,
  verifyEmail,
  resendVerificationOtp,
  loginUser,
  forgotPassword,
  resetPassword,
  refreshAccessToken,
  getCurrentUser,
  changePassword,
  logout,
  getClientIp,
};
