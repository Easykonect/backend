/**
 * Sentry Error Monitoring
 * 
 * Provides real-time error tracking, performance monitoring,
 * and alerting for production issues.
 * 
 * Features:
 * - Automatic error capture from GraphQL resolvers
 * - User context (who experienced the error)
 * - Transaction tracing for performance
 * - Environment-aware (dev vs production)
 * 
 * Dashboard: https://sentry.io
 */

import * as Sentry from '@sentry/node';
import { config } from '@/config';

// ==========================================
// Initialization
// ==========================================

let isInitialized = false;

/**
 * Initialize Sentry SDK
 * Call this as early as possible in your app's lifecycle
 */
export const initSentry = (): void => {
  const dsn = process.env.SENTRY_DSN;
  
  // Skip if no DSN configured or already initialized
  if (!dsn || isInitialized) {
    if (!dsn) {
      console.log('ℹ️  Sentry DSN not configured - error monitoring disabled');
    }
    return;
  }

  Sentry.init({
    dsn,
    
    // Environment (development, staging, production)
    environment: process.env.NODE_ENV || 'development',
    
    // Release version (helps track which deploy introduced bugs)
    release: process.env.npm_package_version || '1.0.0',
    
    // Send default PII (IP address, user info)
    sendDefaultPii: true,
    
    // Sample rate for performance monitoring (1.0 = 100%)
    // Reduce in production if you have high traffic
    tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.2 : 1.0,
    
    // Sample rate for profiling
    profilesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,
    
    // Filter out non-critical errors in development
    beforeSend(event, hint) {
      // Skip certain errors in development
      if (process.env.NODE_ENV === 'development') {
        const error = hint.originalException;
        
        // Skip validation errors (expected user input errors)
        if (error instanceof Error && error.message?.includes('VALIDATION_ERROR')) {
          return null;
        }
      }
      
      return event;
    },
    
    // Integrations
    integrations: [
      // Capture unhandled promise rejections
      Sentry.captureConsoleIntegration({ levels: ['error'] }),
    ],
  });

  isInitialized = true;
  console.log('✅ Sentry error monitoring initialized');
};

// ==========================================
// User Context
// ==========================================

/**
 * Set user context for error tracking
 * Call this after user authentication
 */
export const setUserContext = (user: {
  id: string;
  email?: string;
  role?: string;
}): void => {
  if (!isInitialized) return;
  
  Sentry.setUser({
    id: user.id,
    email: user.email,
    // Custom data
    role: user.role,
  });
};

/**
 * Clear user context (on logout)
 */
export const clearUserContext = (): void => {
  if (!isInitialized) return;
  Sentry.setUser(null);
};

// ==========================================
// Error Capturing
// ==========================================

/**
 * Capture an exception with additional context
 */
export const captureException = (
  error: Error | unknown,
  context?: {
    tags?: Record<string, string>;
    extra?: Record<string, unknown>;
    user?: { id: string; email?: string; role?: string };
    level?: 'fatal' | 'error' | 'warning' | 'info';
  }
): string | undefined => {
  if (!isInitialized) {
    console.error('Sentry not initialized, error:', error);
    return undefined;
  }

  return Sentry.captureException(error, {
    tags: context?.tags,
    extra: context?.extra,
    user: context?.user,
    level: context?.level || 'error',
  });
};

/**
 * Capture a message (for non-error events)
 */
export const captureMessage = (
  message: string,
  level: 'fatal' | 'error' | 'warning' | 'info' | 'debug' = 'info',
  context?: Record<string, unknown>
): string | undefined => {
  if (!isInitialized) {
    console.log(`[${level.toUpperCase()}] ${message}`, context);
    return undefined;
  }

  return Sentry.captureMessage(message, {
    level,
    extra: context,
  });
};

// ==========================================
// Transaction/Span Tracking (Performance)
// ==========================================

/**
 * Start a new transaction for performance monitoring
 */
export const startTransaction = (
  name: string,
  op: string
): Sentry.Span | undefined => {
  if (!isInitialized) return undefined;
  
  return Sentry.startInactiveSpan({
    name,
    op,
  });
};

// ==========================================
// Context & Breadcrumbs
// ==========================================

/**
 * Add a breadcrumb (trail of events leading to an error)
 */
export const addBreadcrumb = (breadcrumb: {
  message: string;
  category?: string;
  level?: 'fatal' | 'error' | 'warning' | 'info' | 'debug';
  data?: Record<string, unknown>;
}): void => {
  if (!isInitialized) return;
  
  Sentry.addBreadcrumb({
    message: breadcrumb.message,
    category: breadcrumb.category || 'app',
    level: breadcrumb.level || 'info',
    data: breadcrumb.data,
    timestamp: Date.now() / 1000,
  });
};

/**
 * Set extra context data
 */
export const setContext = (name: string, context: Record<string, unknown>): void => {
  if (!isInitialized) return;
  Sentry.setContext(name, context);
};

/**
 * Set a tag (searchable in Sentry dashboard)
 */
export const setTag = (key: string, value: string): void => {
  if (!isInitialized) return;
  Sentry.setTag(key, value);
};

// ==========================================
// GraphQL Integration Helper
// ==========================================

/**
 * Capture GraphQL resolver error with full context
 */
export const captureGraphQLError = (
  error: Error,
  resolverInfo: {
    operation: string;
    fieldName: string;
    variables?: Record<string, unknown>;
    userId?: string;
    userRole?: string;
  }
): string | undefined => {
  if (!isInitialized) return undefined;

  // Add breadcrumb for the GraphQL operation
  addBreadcrumb({
    message: `GraphQL ${resolverInfo.operation}: ${resolverInfo.fieldName}`,
    category: 'graphql',
    level: 'info',
    data: {
      variables: resolverInfo.variables,
    },
  });

  // Capture with full context
  return captureException(error, {
    tags: {
      'graphql.operation': resolverInfo.operation,
      'graphql.field': resolverInfo.fieldName,
    },
    extra: {
      variables: resolverInfo.variables,
    },
    user: resolverInfo.userId ? {
      id: resolverInfo.userId,
      role: resolverInfo.userRole,
    } : undefined,
  });
};

// ==========================================
// Payment-Specific Helpers
// ==========================================

/**
 * Capture payment-related error with transaction details
 */
export const capturePaymentError = (
  error: Error,
  paymentInfo: {
    bookingId?: string;
    paymentId?: string;
    amount?: number;
    userId?: string;
    transactionRef?: string;
    provider?: string; // 'paystack', 'wallet', etc.
  }
): string | undefined => {
  if (!isInitialized) return undefined;

  addBreadcrumb({
    message: `Payment error for booking ${paymentInfo.bookingId}`,
    category: 'payment',
    level: 'error',
    data: paymentInfo,
  });

  return captureException(error, {
    tags: {
      'payment.provider': paymentInfo.provider || 'unknown',
      'payment.type': paymentInfo.transactionRef ? 'card' : 'wallet',
    },
    extra: {
      bookingId: paymentInfo.bookingId,
      paymentId: paymentInfo.paymentId,
      amount: paymentInfo.amount,
      transactionRef: paymentInfo.transactionRef,
    },
    user: paymentInfo.userId ? { id: paymentInfo.userId } : undefined,
    level: 'error',
  });
};

/**
 * Capture wallet operation error
 */
export const captureWalletError = (
  error: Error,
  walletInfo: {
    walletId?: string;
    userId?: string;
    operation: 'credit' | 'debit' | 'withdrawal' | 'transfer';
    amount?: number;
  }
): string | undefined => {
  if (!isInitialized) return undefined;

  return captureException(error, {
    tags: {
      'wallet.operation': walletInfo.operation,
    },
    extra: {
      walletId: walletInfo.walletId,
      amount: walletInfo.amount,
    },
    user: walletInfo.userId ? { id: walletInfo.userId } : undefined,
    level: 'error',
  });
};

// ==========================================
// Flush (for serverless/edge functions)
// ==========================================

/**
 * Flush pending events (call before serverless function ends)
 */
export const flush = async (timeout: number = 2000): Promise<boolean> => {
  if (!isInitialized) return true;
  return Sentry.flush(timeout);
};

// ==========================================
// Export Sentry for advanced usage
// ==========================================

export { Sentry };

export default {
  init: initSentry,
  setUserContext,
  clearUserContext,
  captureException,
  captureMessage,
  captureGraphQLError,
  capturePaymentError,
  captureWalletError,
  addBreadcrumb,
  setContext,
  setTag,
  startTransaction,
  flush,
  Sentry,
};
