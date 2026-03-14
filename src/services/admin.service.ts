/**
 * Admin Authentication Service
 * Separate authentication system for ADMIN and SUPER_ADMIN roles
 * 
 * Security features:
 * - Admin-only registration (invite-based by SUPER_ADMIN)
 * - Separate login endpoint
 * - Role verification on login
 * - Account lockout after failed attempts
 * - Audit logging
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
import { sendPasswordResetEmail } from '@/lib/email';
import { config } from '@/config';
import { ErrorCode, ErrorMessage, UserRole, AccountStatus } from '@/constants';
import { passwordSchema } from '@/utils/validation';

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
  firstName?: string;
  lastName?: string;
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
const isAccountLocked = (lockoutUntil: Date | null): boolean => {
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
  role: user.role,
  status: user.status,
  lastLoginAt: user.lastLoginAt?.toISOString() || null,
  createdAt: user.createdAt.toISOString(),
  updatedAt: user.updatedAt.toISOString(),
});

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

  if (!user) {
    throw new GraphQLError('Invalid admin credentials', {
      extensions: { code: 'INVALID_CREDENTIALS' },
    });
  }

  // CRITICAL: Check if user has admin role
  if (!isAdminRole(user.role)) {
    throw new GraphQLError('Access denied. Admin credentials required.', {
      extensions: { code: 'FORBIDDEN' },
    });
  }

  // Check if account is locked
  if (isAccountLocked(user.lockoutUntil)) {
    const minutesLeft = Math.ceil(
      (user.lockoutUntil!.getTime() - Date.now()) / (1000 * 60)
    );
    throw new GraphQLError(
      `Account is locked. Try again in ${minutesLeft} minutes.`,
      { extensions: { code: 'ACCOUNT_LOCKED' } }
    );
  }

  // Check if account is active
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

  // Verify password
  const isValidPassword = await comparePassword(password, user.password);

  if (!isValidPassword) {
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

    throw new GraphQLError('Invalid admin credentials', {
      extensions: { code: 'INVALID_CREDENTIALS' },
    });
  }

  // Reset failed attempts and update login info
  await prisma.user.update({
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
    userId: user.id,
    email: user.email,
    role: user.role,
    isAdmin: true,
  };

  const accessToken = generateToken(tokenPayload);
  const refreshToken = generateRefreshToken(tokenPayload);

  return {
    admin: formatAdminUser(user),
    accessToken,
    refreshToken,
  };
};

/**
 * Create Admin (SUPER_ADMIN only)
 * Invite-based admin creation
 */
export const createAdmin = async (input: CreateAdminInput, creatorId: string) => {
  const { email, password, firstName, lastName, role } = input;
  const normalizedEmail = email.toLowerCase().trim();

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
  await prisma.user.create({
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

  // Update password
  await prisma.user.update({
    where: { id: user.id },
    data: {
      password: hashedPassword,
      passwordResetToken: null,
      passwordResetExpiry: null,
      failedLoginAttempts: 0,
      lockoutUntil: null,
    },
  });

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

  // Verify current password
  const isValidPassword = await comparePassword(currentPassword, admin.password);

  if (!isValidPassword) {
    throw new GraphQLError('Current password is incorrect', {
      extensions: { code: 'INVALID_PASSWORD' },
    });
  }

  // Hash new password
  const hashedPassword = await hashPassword(newPassword);

  // Update password
  await prisma.user.update({
    where: { id: adminId },
    data: {
      password: hashedPassword,
    },
  });

  return {
    success: true,
    message: 'Password changed successfully.',
  };
};

/**
 * Admin Refresh Token
 */
export const adminRefreshToken = async (refreshToken: string) => {
  try {
    const decoded = verifyToken(refreshToken) as {
      userId: string;
      email: string;
      role: string;
      isAdmin?: boolean;
    };

    // Verify this is an admin token
    if (!decoded.isAdmin || !isAdminRole(decoded.role)) {
      throw new GraphQLError('Invalid admin token', {
        extensions: { code: 'INVALID_TOKEN' },
      });
    }

    // Fetch current admin data
    const admin = await prisma.user.findUnique({
      where: { id: decoded.userId },
    });

    if (!admin || !isAdminRole(admin.role)) {
      throw new GraphQLError('Admin not found', {
        extensions: { code: 'NOT_FOUND' },
      });
    }

    if (admin.status !== AccountStatus.ACTIVE) {
      throw new GraphQLError('Admin account is not active', {
        extensions: { code: 'ACCOUNT_INACTIVE' },
      });
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
  } catch (error) {
    if (error instanceof GraphQLError) throw error;
    throw new GraphQLError('Invalid or expired token', {
      extensions: { code: 'INVALID_TOKEN' },
    });
  }
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

  const updatedAdmin = await prisma.user.update({
    where: { id: adminId },
    data: {
      ...(input.firstName && { firstName: input.firstName }),
      ...(input.lastName && { lastName: input.lastName }),
    },
  });

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
export const suspendAdmin = async (adminId: string, reason: string, suspenderId: string) => {
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

  // TODO: Log suspension reason

  return {
    success: true,
    message: `Admin ${admin.email} has been suspended.`,
  };
};

/**
 * Activate Admin
 */
export const activateAdmin = async (adminId: string) => {
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

  return {
    success: true,
    message: `Admin ${admin.email} has been activated.`,
  };
};

/**
 * Update Admin Role
 */
export const updateAdminRole = async (adminId: string, newRole: 'ADMIN' | 'SUPER_ADMIN', updaterId: string) => {
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

  const updatedAdmin = await prisma.user.update({
    where: { id: adminId },
    data: {
      role: newRole,
    },
  });

  return formatAdminUser(updatedAdmin);
};

/**
 * Delete Admin
 */
export const deleteAdmin = async (adminId: string, deleterId: string) => {
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
export const suspendUser = async (userId: string, reason: string) => {
  const user = await prisma.user.findUnique({
    where: { id: userId },
  });

  if (!user) {
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

  // TODO: Send suspension notification email
  // TODO: Log suspension reason

  return {
    success: true,
    message: `User ${user.email} has been suspended.`,
  };
};

/**
 * Activate User
 */
export const activateUser = async (userId: string) => {
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

  await prisma.user.update({
    where: { id: userId },
    data: {
      status: AccountStatus.ACTIVE,
    },
  });

  return {
    success: true,
    message: `User ${user.email} has been activated.`,
  };
};

/**
 * Admin logout - invalidate refresh token
 */
export { invalidateRefreshToken as adminLogout } from './token.service';
