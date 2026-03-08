/**
 * Error Constants
 * Standardized error codes and messages
 */

export const ErrorCode = {
  // Authentication Errors
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  UNAUTHORIZED: 'UNAUTHORIZED',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  TOKEN_INVALID: 'TOKEN_INVALID',

  // User Errors
  USER_NOT_FOUND: 'USER_NOT_FOUND',
  USER_ALREADY_EXISTS: 'USER_ALREADY_EXISTS',
  USER_SUSPENDED: 'USER_SUSPENDED',
  USER_NOT_VERIFIED: 'USER_NOT_VERIFIED',

  // Service Errors
  SERVICE_NOT_FOUND: 'SERVICE_NOT_FOUND',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',

  // Booking Errors
  BOOKING_NOT_FOUND: 'BOOKING_NOT_FOUND',
  BOOKING_ALREADY_EXISTS: 'BOOKING_ALREADY_EXISTS',
  BOOKING_CANCELLED: 'BOOKING_CANCELLED',

  // Payment Errors
  PAYMENT_FAILED: 'PAYMENT_FAILED',
  PAYMENT_NOT_FOUND: 'PAYMENT_NOT_FOUND',
  INSUFFICIENT_FUNDS: 'INSUFFICIENT_FUNDS',

  // Validation Errors
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  INVALID_INPUT: 'INVALID_INPUT',

  // General Errors
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  NOT_FOUND: 'NOT_FOUND',
  BAD_REQUEST: 'BAD_REQUEST',
  FORBIDDEN: 'FORBIDDEN',
} as const;

export type ErrorCodeType = (typeof ErrorCode)[keyof typeof ErrorCode];

export const ErrorMessage: Record<ErrorCodeType, string> = {
  [ErrorCode.UNAUTHENTICATED]: 'You must be logged in to perform this action',
  [ErrorCode.UNAUTHORIZED]: 'You do not have permission to perform this action',
  [ErrorCode.INVALID_CREDENTIALS]: 'Invalid email or password',
  [ErrorCode.TOKEN_EXPIRED]: 'Your session has expired. Please log in again',
  [ErrorCode.TOKEN_INVALID]: 'Invalid authentication token',

  [ErrorCode.USER_NOT_FOUND]: 'User not found',
  [ErrorCode.USER_ALREADY_EXISTS]: 'A user with this email already exists',
  [ErrorCode.USER_SUSPENDED]: 'Your account has been suspended',
  [ErrorCode.USER_NOT_VERIFIED]: 'Please verify your account to continue',

  [ErrorCode.SERVICE_NOT_FOUND]: 'Service not found',
  [ErrorCode.SERVICE_UNAVAILABLE]: 'This service is currently unavailable',

  [ErrorCode.BOOKING_NOT_FOUND]: 'Booking not found',
  [ErrorCode.BOOKING_ALREADY_EXISTS]: 'You already have a pending booking for this service',
  [ErrorCode.BOOKING_CANCELLED]: 'This booking has been cancelled',

  [ErrorCode.PAYMENT_FAILED]: 'Payment processing failed',
  [ErrorCode.PAYMENT_NOT_FOUND]: 'Payment record not found',
  [ErrorCode.INSUFFICIENT_FUNDS]: 'Insufficient funds to complete this transaction',

  [ErrorCode.VALIDATION_ERROR]: 'Validation failed',
  [ErrorCode.INVALID_INPUT]: 'Invalid input provided',

  [ErrorCode.INTERNAL_ERROR]: 'An unexpected error occurred',
  [ErrorCode.NOT_FOUND]: 'Resource not found',
  [ErrorCode.BAD_REQUEST]: 'Bad request',
  [ErrorCode.FORBIDDEN]: 'Access forbidden',
};
