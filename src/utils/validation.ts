/**
 * Validation Schemas
 * Zod schemas for input validation
 */

import { z } from 'zod';
import { UserRole, AccountStatus, BookingStatus, PaymentStatus } from '@/constants';

/**
 * Common validation schemas
 */
export const emailSchema = z.string().email('Invalid email address');

export const passwordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(128, 'Password must not exceed 128 characters')
  .regex(/[A-Z]/, 'Password must contain at least one uppercase letter')
  .regex(/[a-z]/, 'Password must contain at least one lowercase letter')
  .regex(/[0-9]/, 'Password must contain at least one number')
  .regex(/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/, 'Password must contain at least one special character (!@#$%^&*()_+-=[]{};\':"|,.<>/?)');

export const phoneSchema = z
  .string()
  .regex(/^\+?[1-9]\d{1,14}$/, 'Invalid phone number');

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
  phone: phoneSchema.optional(),
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
