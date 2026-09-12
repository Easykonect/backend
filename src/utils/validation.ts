/**
 * Validation Schemas
 * Zod schemas for input validation
 */

import { z } from 'zod';
import { UserRole, AccountStatus, BookingStatus, PaymentStatus } from '@/constants';

/**
 * Common validation schemas
 */
// Surrounding spaces (often added by mobile keyboards and autofill) are ignored
export const emailSchema = z.string().trim().email('Invalid email address');

export const passwordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(128, 'Password must not exceed 128 characters')
  .regex(/[A-Z]/, 'Password must contain at least one uppercase letter')
  .regex(/[a-z]/, 'Password must contain at least one lowercase letter')
  .regex(/[0-9]/, 'Password must contain at least one number')
  .regex(/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/, 'Password must contain at least one special character (!@#$%^&*()_+-=[]{};\':"|,.<>/?)');

const PHONE_CHARACTERS = /^\+?[\d\s().-]+$/;
const NIGERIAN_MOBILE = /^(?:\+?2340?|0)([789][01]\d{8})$/;
const MAX_PHONE_INPUT_LENGTH = 30;

/**
 * Nigerian mobile numbers, accepted the same way by every operation: local
 * (0803 123 4567) or international (+234 803 123 4567, 2348031234567,
 * +234 (0) 803 123 4567). Spaces, dashes, dots and brackets may separate the
 * digits. Returns the number as +234 followed by 10 digits, or null when it
 * isn't a Nigerian mobile number.
 */
export const normalizeNigerianPhone = (phone: unknown): string | null => {
  if (typeof phone !== 'string') return null;

  const trimmed = phone.trim();
  if (!trimmed || trimmed.length > MAX_PHONE_INPUT_LENGTH || !PHONE_CHARACTERS.test(trimmed)) {
    return null;
  }

  const match = NIGERIAN_MOBILE.exec(trimmed.replace(/[\s().-]/g, ''));
  return match ? `+234${match[1]}` : null;
};

export const phoneSchema = z
  .string()
  .refine((value) => normalizeNigerianPhone(value) !== null, 'Invalid phone number');

export const objectIdSchema = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid ID');

/**
 * Pagination schema
 */
export const paginationSchema = z.object({
  page: z.number().int().positive().default(1),
  limit: z.number().int().positive().max(100).default(10),
});

/**
 * Location schema
 */
export const locationSchema = z.object({
  address: z.string().min(1, 'Address is required'),
  city: z.string().min(1, 'City is required'),
  state: z.string().min(1, 'State is required'),
  country: z.string().min(1, 'Country is required'),
  coordinates: z
    .object({
      lat: z.number().min(-90).max(90),
      lng: z.number().min(-180).max(180),
    })
    .optional(),
});

/**
 * Auth validation schemas
 */
export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Password is required'),
});

export const registerUserSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  firstName: z.string().min(2, 'First name must be at least 2 characters'),
  lastName: z.string().min(2, 'Last name must be at least 2 characters'),
  // Optional: an empty string or null means no phone number
  phone: z
    .string()
    .refine((value) => !value.trim() || normalizeNigerianPhone(value) !== null, 'Invalid phone number')
    .nullish(),
});

export const registerProviderSchema = registerUserSchema.extend({
  businessName: z.string().min(2, 'Business name must be at least 2 characters'),
  businessDescription: z.string().optional(),
  serviceCategories: z.array(z.string()).min(1, 'At least one service category is required'),
  location: locationSchema,
});

/**
 * Enum schemas
 */
export const userRoleSchema = z.enum([
  UserRole.SERVICE_USER,
  UserRole.SERVICE_PROVIDER,
  UserRole.ADMIN,
  UserRole.SUPER_ADMIN,
]);

export const accountStatusSchema = z.enum([
  AccountStatus.PENDING,
  AccountStatus.ACTIVE,
  AccountStatus.SUSPENDED,
  AccountStatus.DEACTIVATED,
]);

export const bookingStatusSchema = z.enum([
  BookingStatus.PENDING,
  BookingStatus.ACCEPTED,
  BookingStatus.REJECTED,
  BookingStatus.IN_PROGRESS,
  BookingStatus.COMPLETED,
  BookingStatus.CANCELLED,
  BookingStatus.DISPUTED,
]);

export const paymentStatusSchema = z.enum([
  PaymentStatus.PENDING,
  PaymentStatus.PROCESSING,
  PaymentStatus.COMPLETED,
  PaymentStatus.FAILED,
  PaymentStatus.REFUNDED,
]);

/**
 * Type inference helpers
 */
export type LoginInput = z.infer<typeof loginSchema>;
export type RegisterUserInput = z.infer<typeof registerUserSchema>;
export type RegisterProviderInput = z.infer<typeof registerProviderSchema>;
export type LocationInput = z.infer<typeof locationSchema>;
export type PaginationInput = z.infer<typeof paginationSchema>;
