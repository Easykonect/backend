/**
 * Status Constants
 * Defines all status values used across the platform
 */

// User Account Status
export const AccountStatus = {
  PENDING: 'PENDING',
  ACTIVE: 'ACTIVE',
  SUSPENDED: 'SUSPENDED',
  DEACTIVATED: 'DEACTIVATED',
} as const;

export type AccountStatusType = (typeof AccountStatus)[keyof typeof AccountStatus];

// Service Provider Verification Status
export const VerificationStatus = {
  UNVERIFIED: 'UNVERIFIED',
  PENDING: 'PENDING',
  VERIFIED: 'VERIFIED',
  REJECTED: 'REJECTED',
} as const;

export type VerificationStatusType = (typeof VerificationStatus)[keyof typeof VerificationStatus];

// Booking Status
export const BookingStatus = {
  PENDING: 'PENDING',
  ACCEPTED: 'ACCEPTED',
  REJECTED: 'REJECTED',
  IN_PROGRESS: 'IN_PROGRESS',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
  DISPUTED: 'DISPUTED',
} as const;

export type BookingStatusType = (typeof BookingStatus)[keyof typeof BookingStatus];

// Payment Status
export const PaymentStatus = {
  PENDING: 'PENDING',
  PROCESSING: 'PROCESSING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  REFUNDED: 'REFUNDED',
} as const;

export type PaymentStatusType = (typeof PaymentStatus)[keyof typeof PaymentStatus];

// Service Status
export const ServiceStatus = {
  DRAFT: 'DRAFT',
  PENDING_APPROVAL: 'PENDING_APPROVAL',
  ACTIVE: 'ACTIVE',
  INACTIVE: 'INACTIVE',
  SUSPENDED: 'SUSPENDED',
} as const;

export type ServiceStatusType = (typeof ServiceStatus)[keyof typeof ServiceStatus];

// Dispute Status
export const DisputeStatus = {
  OPEN: 'OPEN',
  UNDER_REVIEW: 'UNDER_REVIEW',
  RESOLVED: 'RESOLVED',
  CLOSED: 'CLOSED',
} as const;

export type DisputeStatusType = (typeof DisputeStatus)[keyof typeof DisputeStatus];

// Dispute Resolution Types
export const DisputeResolution = {
  REFUND_FULL: 'REFUND_FULL',
  REFUND_PARTIAL: 'REFUND_PARTIAL',
  NO_REFUND: 'NO_REFUND',
  REDO_SERVICE: 'REDO_SERVICE',
  MUTUAL_AGREEMENT: 'MUTUAL_AGREEMENT',
  DISMISSED: 'DISMISSED',
} as const;

export type DisputeResolutionType = (typeof DisputeResolution)[keyof typeof DisputeResolution];

// Conversation Types
export const ConversationType = {
  USER_PROVIDER: 'USER_PROVIDER',
  USER_ADMIN: 'USER_ADMIN',
  ADMIN_SUPERADMIN: 'ADMIN_SUPERADMIN',
  BOOKING_RELATED: 'BOOKING_RELATED',
} as const;

export type ConversationTypeValue = (typeof ConversationType)[keyof typeof ConversationType];

// Message Status
export const MessageStatus = {
  SENT: 'SENT',
  DELIVERED: 'DELIVERED',
  READ: 'READ',
} as const;

export type MessageStatusType = (typeof MessageStatus)[keyof typeof MessageStatus];

// Notification Types
export const NotificationType = {
  // Booking notifications
  BOOKING_CREATED: 'BOOKING_CREATED',
  BOOKING_ACCEPTED: 'BOOKING_ACCEPTED',
  BOOKING_REJECTED: 'BOOKING_REJECTED',
  BOOKING_CANCELLED: 'BOOKING_CANCELLED',
  BOOKING_STARTED: 'BOOKING_STARTED',
  BOOKING_COMPLETED: 'BOOKING_COMPLETED',
  
  // Payment notifications
  PAYMENT_RECEIVED: 'PAYMENT_RECEIVED',
  PAYMENT_FAILED: 'PAYMENT_FAILED',
  REFUND_PROCESSED: 'REFUND_PROCESSED',
  
  // Review notifications
  REVIEW_RECEIVED: 'REVIEW_RECEIVED',
  REVIEW_RESPONSE: 'REVIEW_RESPONSE',
  
  // Provider notifications
  VERIFICATION_APPROVED: 'VERIFICATION_APPROVED',
  VERIFICATION_REJECTED: 'VERIFICATION_REJECTED',
  SERVICE_APPROVED: 'SERVICE_APPROVED',
  SERVICE_REJECTED: 'SERVICE_REJECTED',
  SERVICE_SUSPENDED: 'SERVICE_SUSPENDED',
  
  // Dispute notifications
  DISPUTE_OPENED: 'DISPUTE_OPENED',
  DISPUTE_UPDATED: 'DISPUTE_UPDATED',
  DISPUTE_RESOLVED: 'DISPUTE_RESOLVED',
  
  // Message notifications
  NEW_MESSAGE: 'NEW_MESSAGE',
  
  // System notifications
  ACCOUNT_SUSPENDED: 'ACCOUNT_SUSPENDED',
  ACCOUNT_ACTIVATED: 'ACCOUNT_ACTIVATED',
  SYSTEM_ANNOUNCEMENT: 'SYSTEM_ANNOUNCEMENT',
} as const;

export type NotificationTypeValue = (typeof NotificationType)[keyof typeof NotificationType];
