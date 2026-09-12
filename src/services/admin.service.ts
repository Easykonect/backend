/**
 * Admin Authentication Service
 * Separate authentication system for ADMIN and SUPER_ADMIN roles
 *
 * Security features:
 * - Admin-only registration (invite-based by SUPER_ADMIN)
 * - Separate login endpoint
 * - Role verification on login
 * - Account lockout after failed attempts
 * - Sessions stored and ended the same way as customer sessions
 * - Audit logging
 */

import { randomUUID } from 'crypto';
import { GraphQLError } from 'graphql';
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
import { sendPasswordResetEmail, sendProfileUpdatedEmail, sendEmailChangeOtpEmail } from '@/lib/email';
import { config } from '@/config';
import { UserRole, AccountStatus } from '@/constants';
import { passwordSchema } from '@/utils/validation';
import {
  isBanActive,
  isIssuedAfter,
  isTokenValid,
  validateEmail,
  validateName,
  validatePhone,
} from '@/utils/security';
import { AdminAction } from '@prisma/client';
import { createAuditLog } from './audit.service';
import {
  storeRefreshToken,
  checkRefreshToken,
  invalidateRefreshToken,
  endAllSessions,
  revokeAccessToken,
} from './token.service';
import { notifyAndPush } from './user-management.service';

// ==================
// Types
// ==================

interface AdminLoginInput {
  email: string;
  password: string;
}

interface CreateAdminInput {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  role: 'ADMIN' | 'SUPER_ADMIN';
}

interface UpdateAdminInput {
  firstName?: string | null;
  lastName?: string | null;
  phone?: string | null;
  profilePhoto?: string | null;
}

interface AdminForgotPasswordInput {
  email: string;
}

interface AdminResetPasswordInput {
  email: string;
  otp: string;
  newPassword: string;
}

interface AdminChangePasswordInput {
  currentPassword: string;
  newPassword: string;
}

// ==================
// Helper Functions
// ==================

/**
 * Check if account is locked
 */
const isAccountLocked = (lockoutUntil: Date | null): lockoutUntil is Date => {
  if (!lockoutUntil) return false;
  return new Date() < lockoutUntil;
};

/**
 * Check if user has admin role
 */
const isAdminRole = (role: string): boolean => {
  return role === UserRole.ADMIN || role === UserRole.SUPER_ADMIN;
};

/**
 * Format admin user response
 */
const formatAdminUser = (user: {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  phone?: string | null;
  profilePhoto?: string | null;
  role: string;
  status: string;
  lastLoginAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}) => ({
  id: user.id,
  email: user.email,
  firstName: user.firstName,
  lastName: user.lastName,
  phone: user.phone ?? null,
  profilePhoto: user.profilePhoto ?? null,
  role: user.role,
  status: user.status,
  lastLoginAt: user.lastLoginAt?.toISOString() || null,
  createdAt: user.createdAt.toISOString(),
  updatedAt: user.updatedAt.toISOString(),
});

const invalidAdminCredentials = () =>
  new GraphQLError('Invalid admin credentials', {
    extensions: { code: 'INVALID_CREDENTIALS' },
  });

const invalidAdminToken = (message: string) =>
  new GraphQLError(message, {
    extensions: { code: 'INVALID_TOKEN' },
  });

const accountLocked = (lockoutUntil: Date) =>
  new GraphQLError(
    `Account is locked. Try again in ${Math.ceil((lockoutUntil.getTime() - Date.now()) / (1000 * 60))} minutes.`,
    { extensions: { code: 'ACCOUNT_LOCKED' } }
  );

// Compared against when the email has no admin account, so that answer takes as
// long as a wrong password does
let dummyPasswordHash: Promise<string> | undefined;
const getDummyPasswordHash = (): Promise<string> => {
  dummyPasswordHash ??= hashPassword(randomUUID());
  return dummyPasswordHash;
};

/**
 * Count a wrong password toward the lockout. Returns the lockout end when this
 * attempt locks the account.
 */
const recordFailedPassword = async (account: {
  id: string;
  failedLoginAttempts: number;
}): Promise<Date | null> => {
  const failedLoginAttempts = account.failedLoginAttempts + 1;
  const lockoutUntil = failedLoginAttempts >= config.security.maxLoginAttempts
    ? new Date(Date.now() + config.security.lockoutDurationMinutes * 60 * 1000)
    : null;

  await prisma.user.update({
    where: { id: account.id },
    data: { failedLoginAttempts, lockoutUntil },
  });

  return lockoutUntil;
};

/**
 * Record an admin action that has already been saved. A failed log is reported
 * in the server log but doesn't turn the saved action into an error.
 */
const recordAdminAction = async (entry: Parameters<typeof createAuditLog>[0]) => {
  try {
    await createAuditLog(entry);
  } catch (error) {
    console.error(`Failed to write ${entry.action} audit log:`, error);
  }
};

// ==================
// Admin Authentication Functions
// ==================

/**
 * Admin Login
 * Only allows ADMIN and SUPER_ADMIN roles
 */
export const adminLogin = async (input: AdminLoginInput, clientIp?: string) => {
  const { email, password } = input;
  const normalizedEmail = email.toLowerCase().trim();

  // Find user
  const user = await prisma.user.findUnique({
    where: { email: normalizedEmail },
  });

  // An email with no account, a deleted account, or a customer or provider
  // account gets the same answer as a wrong password, after a password check of
  // the same cost
  if (!user || user.deletedAt || !isAdminRole(user.role)) {
    await comparePassword(password, user?.password ?? (await getDummyPasswordHash()));
    throw invalidAdminCredentials();
  }

  // Verify password
  const isValidPassword = await comparePassword(password, user.password);
  const isLocked = isAccountLocked(user.lockoutUntil);

  if (!isValidPassword) {
    // Wrong passwords during a lockout aren't counted, so they don't extend it
    if (!isLocked) {
      await recordFailedPassword(user);
    }

    throw invalidAdminCredentials();
  }

  // The account's state is only revealed to someone who knows its password
  if (isAccountLocked(user.lockoutUntil)) {
    throw accountLocked(user.lockoutUntil);
  }

  if (user.status === AccountStatus.SUSPENDED) {
    throw new GraphQLError('Your admin account has been suspended.', {
      extensions: { code: 'ACCOUNT_SUSPENDED' },
    });
  }

  if (user.status === AccountStatus.DEACTIVATED) {
    throw new GraphQLError('Your admin account has been deactivated.', {
      extensions: { code: 'ACCOUNT_DEACTIVATED' },
    });
  }

  if (isBanActive(user)) {
    throw new GraphQLError('Your admin account has been banned.', {
      extensions: { code: 'ACCOUNT_BANNED' },
    });
  }

  // Reset failed attempts and update login info
  const admin = await prisma.user.update({
    where: { id: user.id },
    data: {
      failedLoginAttempts: 0,
      lockoutUntil: null,
      lastLoginAt: new Date(),
      lastLoginIp: clientIp || 'unknown',
    },
  });

  // Generate tokens with admin flag
  const tokenPayload = {
    userId: admin.id,
    email: admin.email,
    role: admin.role,
    isAdmin: true,
  };

  const accessToken = generateToken(tokenPayload);
  const refreshToken = generateRefreshToken(tokenPayload);

  // Stored so adminRefreshToken accepts it until adminLogout or a password change revokes it
  await storeRefreshToken(admin.id, refreshToken, {
    deviceInfo: 'admin-dashboard',
    ipAddress: clientIp,
  });

  return {
    admin: formatAdminUser(admin),
    accessToken,
    refreshToken,
  };
};

/**
 * Create Admin (SUPER_ADMIN only)
 * Invite-based admin creation
 */
export const createAdmin = async (
  input: CreateAdminInput,
  creatorId: string,
  creatorRole: string = UserRole.SUPER_ADMIN,
  ipAddress?: string
) => {
  const { password, role } = input;
  const normalizedEmail = validateEmail(input.email);
  const firstName = validateName(input.firstName, 'First name');
  const lastName = validateName(input.lastName, 'Last name');

  // Validate password
  const passwordValidation = passwordSchema.safeParse(password);
  if (!passwordValidation.success) {
    throw new GraphQLError(passwordValidation.error.issues[0]?.message || 'Invalid password', {
      extensions: { code: 'VALIDATION_ERROR' },
    });
  }

  // Check if email already exists
  const existingUser = await prisma.user.findUnique({
    where: { email: normalizedEmail },
  });

  if (existingUser) {
    throw new GraphQLError('An account with this email already exists', {
      extensions: { code: 'USER_ALREADY_EXISTS' },
    });
  }

  // Hash password
  const hashedPassword = await hashPassword(password);

  // Create admin user (already verified since it's invite-based)
  const createdAdmin = await prisma.user.create({
    data: {
      email: normalizedEmail,
      password: hashedPassword,
      firstName,
      lastName,
      role,
      status: AccountStatus.ACTIVE,
      isEmailVerified: true, // Admin accounts are pre-verified
    },
  });

  await recordAdminAction({
    action: AdminAction.CREATE_ADMIN,
    targetType: 'User',
    targetId: createdAdmin.id,
    performedBy: creatorId,
    performedByRole: creatorRole,
    newValue: { email: normalizedEmail, role, status: AccountStatus.ACTIVE },
    ipAddress,
  });

  // TODO: Send welcome email to new admin

  return {
    success: true,
    message: `${role} account created successfully for ${normalizedEmail}`,
    requiresVerification: false,
  };
};

/**
 * Admin Forgot Password
 */
export const adminForgotPassword = async (input: AdminForgotPasswordInput) => {
  const { email } = input;
  const normalizedEmail = email.toLowerCase().trim();

  // Find user
  const user = await prisma.user.findUnique({
    where: { email: normalizedEmail },
  });

  // Always return success to prevent email enumeration
  if (!user || !isAdminRole(user.role)) {
    return {
      success: true,
      message: 'If an admin account exists with this email, a reset code has been sent.',
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
    message: 'If an admin account exists with this email, a reset code has been sent.',
  };
};

/**
 * Admin Reset Password
 */
export const adminResetPassword = async (input: AdminResetPasswordInput) => {
  const { email, otp, newPassword } = input;
  const normalizedEmail = email.toLowerCase().trim();

  // Validate new password
  const passwordValidation = passwordSchema.safeParse(newPassword);
  if (!passwordValidation.success) {
    throw new GraphQLError(passwordValidation.error.issues[0]?.message || 'Invalid password', {
      extensions: { code: 'VALIDATION_ERROR' },
    });
  }

  // Find user
  const user = await prisma.user.findUnique({
    where: { email: normalizedEmail },
  });

  if (!user || !isAdminRole(user.role)) {
    throw new GraphQLError('Invalid reset request', {
      extensions: { code: 'INVALID_REQUEST' },
    });
  }

  // Check if OTP exists
  if (!user.passwordResetToken) {
    throw new GraphQLError('No reset code found. Please request a new one.', {
      extensions: { code: 'OTP_NOT_FOUND' },
    });
  }

  // Check if OTP expired
  if (isOtpExpired(user.passwordResetExpiry)) {
    throw new GraphQLError('Reset code has expired. Please request a new one.', {
      extensions: { code: 'OTP_EXPIRED' },
    });
  }

  // Verify OTP
  const isValidOtp = verifyOtp(otp, user.passwordResetToken);

  if (!isValidOtp) {
    throw new GraphQLError('Invalid reset code.', {
      extensions: { code: 'INVALID_OTP' },
    });
  }

  // Hash new password
  const hashedPassword = await hashPassword(newPassword);

  // Update password. Saving the sign-out time with it keeps every earlier
  // session ended even if the token store is unavailable.
  await prisma.user.update({
    where: { id: user.id },
    data: {
      password: hashedPassword,
      passwordResetToken: null,
      passwordResetExpiry: null,
      failedLoginAttempts: 0,
      lockoutUntil: null,
      tokenInvalidatedAt: new Date(),
    },
  });

  // Anyone signed in with the old password is signed out
  await endAllSessions(user.id);

  return {
    success: true,
    message: 'Password reset successfully. You can now login with your new password.',
  };
};

/**
 * Admin Change Password
 */
export const adminChangePassword = async (adminId: string, input: AdminChangePasswordInput) => {
  const { currentPassword, newPassword } = input;

  // Validate new password
  const passwordValidation = passwordSchema.safeParse(newPassword);
  if (!passwordValidation.success) {
    throw new GraphQLError(passwordValidation.error.issues[0]?.message || 'Invalid password', {
      extensions: { code: 'VALIDATION_ERROR' },
    });
  }

  // Find admin
  const admin = await prisma.user.findUnique({
    where: { id: adminId },
  });

  if (!admin || !isAdminRole(admin.role)) {
    throw new GraphQLError('Admin not found', {
      extensions: { code: 'NOT_FOUND' },
    });
  }

  // The sign-in lockout applies here too, so a signed-in session can't be used
  // to keep guessing the password
  if (isAccountLocked(admin.lockoutUntil)) {
    throw accountLocked(admin.lockoutUntil);
  }

  // Verify current password
  const isValidPassword = await comparePassword(currentPassword, admin.password);

  if (!isValidPassword) {
    const lockoutUntil = await recordFailedPassword(admin);

    if (lockoutUntil) {
      throw accountLocked(lockoutUntil);
    }

    throw new GraphQLError('Current password is incorrect', {
      extensions: { code: 'INVALID_PASSWORD' },
    });
  }

  // Hash new password
  const hashedPassword = await hashPassword(newPassword);

  // Update password, with the sign-out time for every earlier session
  await prisma.user.update({
    where: { id: adminId },
    data: {
      password: hashedPassword,
      failedLoginAttempts: 0,
      lockoutUntil: null,
      tokenInvalidatedAt: new Date(),
    },
  });

  // Sign out on every device, this one included
  await endAllSessions(adminId);

  return {
    success: true,
    message: 'Password changed successfully. Please login again on all devices.',
  };
};

/**
 * Admin Refresh Token
 * Checked the same way as a customer refresh token, and it must come from adminLogin
 */
export const adminRefreshToken = async (refreshToken: string) => {
  let decoded: JWTPayload & { isAdmin?: boolean };

  try {
    decoded = verifyRefreshToken(refreshToken);
  } catch {
    throw invalidAdminToken('Invalid or expired token');
  }

  // Verify this is an admin token
  if (!decoded.isAdmin || !isAdminRole(decoded.role)) {
    throw invalidAdminToken('Invalid admin token');
  }

  // Only a token stored at sign-in, and not revoked since by adminLogout or a
  // password change, is accepted
  const record = await checkRefreshToken(refreshToken);

  if (record.status === 'revoked') {
    throw invalidAdminToken('Refresh token has been invalidated');
  }

  if (record.status === 'unavailable') {
    // Signed and unexpired; the account checks below still apply
    console.warn(`Token store unavailable: accepting a signed admin refresh token for user ${decoded.userId}`);
  } else if (record.userId !== decoded.userId) {
    throw invalidAdminToken('Refresh token has been invalidated');
  }

  if (decoded.iat && !(await isTokenValid(decoded.userId, decoded.iat, decoded.iatMs))) {
    throw invalidAdminToken('Refresh token has been invalidated');
  }

  // Fetch current admin data
  const admin = await prisma.user.findUnique({
    where: { id: decoded.userId },
  });

  if (!admin || admin.deletedAt || !isAdminRole(admin.role)) {
    throw new GraphQLError('Admin not found', {
      extensions: { code: 'NOT_FOUND' },
    });
  }

  if (admin.status !== AccountStatus.ACTIVE || isBanActive(admin)) {
    throw new GraphQLError('Admin account is not active', {
      extensions: { code: 'ACCOUNT_INACTIVE' },
    });
  }

  // Sessions ended by a password change or reset, or by a ban
  if (
    admin.tokenInvalidatedAt &&
    !isIssuedAfter(getTokenIssuedAtMs(decoded), admin.tokenInvalidatedAt.getTime())
  ) {
    throw invalidAdminToken('Refresh token has been invalidated');
  }

  // Generate new access token
  const tokenPayload = {
    userId: admin.id,
    email: admin.email,
    role: admin.role,
    isAdmin: true,
  };

  const accessToken = generateToken(tokenPayload);

  return {
    accessToken,
    admin: formatAdminUser(admin),
  };
};

/**
 * Admin logout: revoke the refresh token and the access token the request was
 * made with, as the customer logout does
 */
export const adminLogout = async (
  refreshToken?: string | null,
  session?: { payload: JWTPayload; accessToken?: string | null }
): Promise<{ success: boolean; message: string }> => {
  await Promise.all([
    session ? revokeAccessToken(session.payload, session.accessToken ?? undefined) : undefined,
    refreshToken ? invalidateRefreshToken(refreshToken) : undefined,
  ]);

  return {
    success: true,
    message: 'Admin logged out successfully',
  };
};

/**
 * Get Current Admin
 */
export const getCurrentAdmin = async (adminId: string) => {
  const admin = await prisma.user.findUnique({
    where: { id: adminId },
  });

  if (!admin || !isAdminRole(admin.role)) {
    throw new GraphQLError('Admin not found', {
      extensions: { code: 'NOT_FOUND' },
    });
  }

  return formatAdminUser(admin);
};

/**
 * Update Admin Profile
 * Supports: firstName, lastName, phone, profilePhoto
 * Email changes are handled separately via adminRequestEmailChange / adminConfirmEmailChange
 */
export const updateAdminProfile = async (adminId: string, input: UpdateAdminInput) => {
  const admin = await prisma.user.findUnique({
    where: { id: adminId },
  });

  if (!admin || !isAdminRole(admin.role)) {
    throw new GraphQLError('Admin not found', {
      extensions: { code: 'NOT_FOUND' },
    });
  }

  // Values are validated only when they differ from the saved ones, so a form
  // that sends back an unchanged value still saves
  const changes: { firstName?: string; lastName?: string; phone?: string | null; profilePhoto?: string | null } = {};
  // Which fields are actually changing, for the notification email
  const changedFields: string[] = [];

  if (input.firstName && input.firstName !== admin.firstName) {
    const firstName = validateName(input.firstName, 'First name');
    if (firstName !== admin.firstName) {
      changes.firstName = firstName;
      changedFields.push('First Name');
    }
  }

  if (input.lastName && input.lastName !== admin.lastName) {
    const lastName = validateName(input.lastName, 'Last name');
    if (lastName !== admin.lastName) {
      changes.lastName = lastName;
      changedFields.push('Last Name');
    }
  }

  if (input.phone !== undefined && input.phone !== admin.phone) {
    // null or an empty string removes the number
    const phone = input.phone?.trim() ? validatePhone(input.phone) : null;
    if (phone !== admin.phone) {
      changes.phone = phone;
      changedFields.push('Phone Number');
    }
  }

  if (input.profilePhoto !== undefined && input.profilePhoto !== admin.profilePhoto) {
    changes.profilePhoto = input.profilePhoto;
    changedFields.push('Profile Photo');
  }

  if (changedFields.length === 0) {
    return formatAdminUser(admin);
  }

  const updatedAdmin = await prisma.user.update({
    where: { id: adminId },
    data: changes,
  });

  // Send profile update notification email (non-blocking)
  sendProfileUpdatedEmail(admin.email, admin.firstName, changedFields).catch(() => {});

  return formatAdminUser(updatedAdmin);
};

/**
 * Admin Request Email Change
 * Sends an OTP to the NEW email address to confirm ownership
 */
export const adminRequestEmailChange = async (adminId: string, newEmail: string) => {
  const normalizedEmail = validateEmail(newEmail);

  const admin = await prisma.user.findUnique({
    where: { id: adminId },
  });

  if (!admin || !isAdminRole(admin.role)) {
    throw new GraphQLError('Admin not found', {
      extensions: { code: 'NOT_FOUND' },
    });
  }

  // Cannot set the same email
  if (normalizedEmail === admin.email) {
    throw new GraphQLError('New email must be different from your current email', {
      extensions: { code: 'VALIDATION_ERROR' },
    });
  }

  // Check the new email is not already in use
  const existing = await prisma.user.findUnique({
    where: { email: normalizedEmail },
  });

  if (existing) {
    throw new GraphQLError('This email address is already in use', {
      extensions: { code: 'USER_ALREADY_EXISTS' },
    });
  }

  // Generate OTP and store it alongside the pending new email
  const otp = generateOtp();
  const hashedOtp = hashOtp(otp);
  const otpExpiry = getOtpExpiry();

  await prisma.user.update({
    where: { id: adminId },
    data: {
      emailVerifyToken: hashedOtp,
      emailVerifyExpiry: otpExpiry,
      pendingEmail: normalizedEmail,
    },
  });

  // Send OTP to the NEW email address
  await sendEmailChangeOtpEmail(normalizedEmail, admin.firstName, otp);

  return {
    success: true,
    message: `A confirmation code has been sent to ${normalizedEmail}. It expires in 10 minutes.`,
  };
};

/**
 * Admin Confirm Email Change
 * Verifies the OTP and commits the new email
 */
export const adminConfirmEmailChange = async (adminId: string, otp: string) => {
  const admin = await prisma.user.findUnique({
    where: { id: adminId },
  });

  if (!admin || !isAdminRole(admin.role)) {
    throw new GraphQLError('Admin not found', {
      extensions: { code: 'NOT_FOUND' },
    });
  }

  if (!admin.pendingEmail || !admin.emailVerifyToken) {
    throw new GraphQLError('No pending email change found. Please request a new one.', {
      extensions: { code: 'INVALID_REQUEST' },
    });
  }

  if (isOtpExpired(admin.emailVerifyExpiry)) {
    throw new GraphQLError('Confirmation code has expired. Please request a new one.', {
      extensions: { code: 'OTP_EXPIRED' },
    });
  }

  if (!verifyOtp(otp, admin.emailVerifyToken)) {
    throw new GraphQLError('Invalid confirmation code.', {
      extensions: { code: 'INVALID_OTP' },
    });
  }

  const oldEmail = admin.email;
  const newEmail = admin.pendingEmail;

  // Commit the email change
  const updatedAdmin = await prisma.user.update({
    where: { id: adminId },
    data: {
      email: newEmail,
      pendingEmail: null,
      emailVerifyToken: null,
      emailVerifyExpiry: null,
    },
  });

  // Notify old email about the change
  sendProfileUpdatedEmail(oldEmail, admin.firstName, ['Email Address']).catch(() => {});

  return formatAdminUser(updatedAdmin);
};

// ==================
// Admin Management (SUPER_ADMIN only)
// ==================

/**
 * Get All Admins
 */
export const getAdmins = async (pagination: { page: number; limit: number }) => {
  const { page, limit } = pagination;
  const skip = (page - 1) * limit;

  const [items, total] = await Promise.all([
    prisma.user.findMany({
      where: {
        role: { in: [UserRole.ADMIN, UserRole.SUPER_ADMIN] },
      },
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
    }),
    prisma.user.count({
      where: {
        role: { in: [UserRole.ADMIN, UserRole.SUPER_ADMIN] },
      },
    }),
  ]);

  const totalPages = Math.ceil(total / limit);

  return {
    items: items.map(formatAdminUser),
    total,
    page,
    limit,
    totalPages,
    hasNextPage: page < totalPages,
    hasPreviousPage: page > 1,
  };
};

/**
 * Get Admin by ID
 */
export const getAdminById = async (adminId: string) => {
  const admin = await prisma.user.findUnique({
    where: { id: adminId },
  });

  if (!admin || !isAdminRole(admin.role)) {
    throw new GraphQLError('Admin not found', {
      extensions: { code: 'NOT_FOUND' },
    });
  }

  return formatAdminUser(admin);
};

/**
 * Suspend Admin
 */
export const suspendAdmin = async (
  adminId: string,
  reason: string,
  suspenderId: string,
  suspenderRole: string = UserRole.SUPER_ADMIN,
  ipAddress?: string
) => {
  const admin = await prisma.user.findUnique({
    where: { id: adminId },
  });

  if (!admin || !isAdminRole(admin.role)) {
    throw new GraphQLError('Admin not found', {
      extensions: { code: 'NOT_FOUND' },
    });
  }

  // Cannot suspend yourself
  if (admin.id === suspenderId) {
    throw new GraphQLError('You cannot suspend your own account', {
      extensions: { code: 'FORBIDDEN' },
    });
  }

  // Cannot suspend another SUPER_ADMIN
  if (admin.role === UserRole.SUPER_ADMIN) {
    throw new GraphQLError('Cannot suspend a Super Admin', {
      extensions: { code: 'FORBIDDEN' },
    });
  }

  await prisma.user.update({
    where: { id: adminId },
    data: {
      status: AccountStatus.SUSPENDED,
    },
  });

  // Record who suspended the admin and why
  await recordAdminAction({
    action: AdminAction.SUSPEND_USER,
    targetType: 'User',
    targetId: adminId,
    performedBy: suspenderId,
    performedByRole: suspenderRole,
    previousValue: { status: admin.status },
    newValue: { status: AccountStatus.SUSPENDED },
    reason,
    ipAddress,
  });

  return {
    success: true,
    message: `Admin ${admin.email} has been suspended.`,
  };
};

/**
 * Activate Admin
 */
export const activateAdmin = async (
  adminId: string,
  activatorId: string,
  activatorRole: string = UserRole.SUPER_ADMIN,
  ipAddress?: string
) => {
  const admin = await prisma.user.findUnique({
    where: { id: adminId },
  });

  if (!admin || !isAdminRole(admin.role)) {
    throw new GraphQLError('Admin not found', {
      extensions: { code: 'NOT_FOUND' },
    });
  }

  await prisma.user.update({
    where: { id: adminId },
    data: {
      status: AccountStatus.ACTIVE,
    },
  });

  await recordAdminAction({
    action: AdminAction.ACTIVATE_USER,
    targetType: 'User',
    targetId: adminId,
    performedBy: activatorId,
    performedByRole: activatorRole,
    previousValue: { status: admin.status },
    newValue: { status: AccountStatus.ACTIVE },
    ipAddress,
  });

  return {
    success: true,
    message: `Admin ${admin.email} has been activated.`,
  };
};

/**
 * Update Admin Role
 */
export const updateAdminRole = async (
  adminId: string,
  newRole: 'ADMIN' | 'SUPER_ADMIN',
  updaterId: string,
  updaterRole: string = UserRole.SUPER_ADMIN,
  ipAddress?: string
) => {
  const admin = await prisma.user.findUnique({
    where: { id: adminId },
  });

  if (!admin || !isAdminRole(admin.role)) {
    throw new GraphQLError('Admin not found', {
      extensions: { code: 'NOT_FOUND' },
    });
  }

  // Cannot change your own role
  if (admin.id === updaterId) {
    throw new GraphQLError('You cannot change your own role', {
      extensions: { code: 'FORBIDDEN' },
    });
  }

  // A Super Admin can't be demoted, just as they can't be suspended or deleted
  if (admin.role === UserRole.SUPER_ADMIN) {
    throw new GraphQLError('Cannot change the role of a Super Admin', {
      extensions: { code: 'FORBIDDEN' },
    });
  }

  if (admin.role === newRole) {
    return formatAdminUser(admin);
  }

  const updatedAdmin = await prisma.user.update({
    where: { id: adminId },
    data: {
      role: newRole,
    },
  });

  await recordAdminAction({
    action: AdminAction.UPDATE_USER_ROLE,
    targetType: 'User',
    targetId: adminId,
    performedBy: updaterId,
    performedByRole: updaterRole,
    previousValue: { role: admin.role },
    newValue: { role: newRole },
    ipAddress,
  });

  return formatAdminUser(updatedAdmin);
};

/**
 * Delete Admin
 */
export const deleteAdmin = async (
  adminId: string,
  deleterId: string,
  deleterRole: string = UserRole.SUPER_ADMIN,
  ipAddress?: string
) => {
  const admin = await prisma.user.findUnique({
    where: { id: adminId },
  });

  if (!admin || !isAdminRole(admin.role)) {
    throw new GraphQLError('Admin not found', {
      extensions: { code: 'NOT_FOUND' },
    });
  }

  // Cannot delete yourself
  if (admin.id === deleterId) {
    throw new GraphQLError('You cannot delete your own account', {
      extensions: { code: 'FORBIDDEN' },
    });
  }

  // Cannot delete another SUPER_ADMIN
  if (admin.role === UserRole.SUPER_ADMIN) {
    throw new GraphQLError('Cannot delete a Super Admin', {
      extensions: { code: 'FORBIDDEN' },
    });
  }

  await prisma.user.delete({
    where: { id: adminId },
  });

  await recordAdminAction({
    action: AdminAction.DELETE_USER,
    targetType: 'User',
    targetId: adminId,
    performedBy: deleterId,
    performedByRole: deleterRole,
    previousValue: { email: admin.email, role: admin.role, status: admin.status },
    ipAddress,
  });

  return {
    success: true,
    message: `Admin ${admin.email} has been deleted.`,
  };
};

// ==================
// User Management (Admin actions)
// ==================

/**
 * Suspend User
 */
export const suspendUser = async (
  userId: string,
  reason: string,
  adminId: string,
  adminRole: string = UserRole.ADMIN,
  ipAddress?: string
) => {
  const user = await prisma.user.findUnique({
    where: { id: userId },
  });

  // A deleted account has nothing left to suspend
  if (!user || user.deletedAt) {
    throw new GraphQLError('User not found', {
      extensions: { code: 'NOT_FOUND' },
    });
  }

  // Cannot suspend admins through this endpoint
  if (isAdminRole(user.role)) {
    throw new GraphQLError('Use admin management endpoints for admin accounts', {
      extensions: { code: 'FORBIDDEN' },
    });
  }

  await prisma.user.update({
    where: { id: userId },
    data: {
      status: AccountStatus.SUSPENDED,
    },
  });

  await recordAdminAction({
    action: AdminAction.SUSPEND_USER,
    targetType: 'User',
    targetId: userId,
    performedBy: adminId,
    performedByRole: adminRole,
    previousValue: { status: user.status },
    newValue: { status: AccountStatus.SUSPENDED },
    reason,
    ipAddress,
  });

  // A suspended account can't open in-app notifications, so the push is what they see
  if (user.status !== AccountStatus.SUSPENDED) {
    const shownReason = reason.trim();
    await notifyAndPush(
      userId,
      'ACCOUNT_SUSPENDED',
      'Account Suspended',
      shownReason
        ? `Your account has been suspended. Reason: ${shownReason}`
        : 'Your account has been suspended. Please contact support.',
      { reason: shownReason },
    );
  }

  return {
    success: true,
    message: `User ${user.email} has been suspended.`,
  };
};

/**
 * Activate User
 */
export const activateUser = async (
  userId: string,
  adminId: string,
  adminRole: string = UserRole.ADMIN,
  ipAddress?: string
) => {
  const user = await prisma.user.findUnique({
    where: { id: userId },
  });

  if (!user) {
    throw new GraphQLError('User not found', {
      extensions: { code: 'NOT_FOUND' },
    });
  }

  // Cannot activate admins through this endpoint
  if (isAdminRole(user.role)) {
    throw new GraphQLError('Use admin management endpoints for admin accounts', {
      extensions: { code: 'FORBIDDEN' },
    });
  }

  // A deleted account's personal data is gone and it can't be used again
  if (user.deletedAt) {
    throw new GraphQLError('This account has been deleted and cannot be reactivated', {
      extensions: { code: 'ACCOUNT_DELETED' },
    });
  }

  await prisma.user.update({
    where: { id: userId },
    data: {
      status: AccountStatus.ACTIVE,
    },
  });

  await recordAdminAction({
    action: AdminAction.ACTIVATE_USER,
    targetType: 'User',
    targetId: userId,
    performedBy: adminId,
    performedByRole: adminRole,
    previousValue: { status: user.status },
    newValue: { status: AccountStatus.ACTIVE },
    ipAddress,
  });

  // Tell the user when a suspension or deactivation is lifted
  if (user.status === AccountStatus.SUSPENDED || user.status === AccountStatus.DEACTIVATED) {
    await notifyAndPush(
      userId,
      'ACCOUNT_ACTIVATED',
      'Account Reactivated',
      'Your account has been reactivated. You can now access your account.',
    );
  }

  return {
    success: true,
    message: `User ${user.email} has been activated.`,
  };
};
