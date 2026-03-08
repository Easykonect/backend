/**
 * Application Configuration
 * Centralizes all environment variables and app settings
 */

export const config = {
  // Environment
  nodeEnv: process.env.NODE_ENV || 'development',
  isDevelopment: process.env.NODE_ENV === 'development',
  isProduction: process.env.NODE_ENV === 'production',

  // Server
  port: parseInt(process.env.PORT || '3000', 10),

  // Database
  databaseUrl: process.env.DATABASE_URL || '',

  // JWT Authentication
  jwt: {
    secret: process.env.JWT_SECRET || 'default-secret-change-in-production',
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
    refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '30d',
  },

  // Password Hashing
  bcrypt: {
    saltRounds: 12,
  },

  // Email Configuration
  email: {
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: process.env.SMTP_SECURE === 'true',
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    fromName: process.env.EMAIL_FROM_NAME || 'EasyKonnect',
    fromAddress: process.env.EMAIL_FROM_ADDRESS || 'noreply@easykonnect.com',
  },

  // OTP Settings
  otp: {
    expiryMinutes: 10,
    maxAttempts: 3,
    length: 6,
  },

  // Security Settings
  security: {
    maxLoginAttempts: 5,
    lockoutDurationMinutes: 30,
    rateLimitWindowMs: 15 * 60 * 1000, // 15 minutes
    rateLimitMaxRequests: 100,
  },

  // Platform Settings
  platform: {
    name: 'EasyKonnect',
    commissionRate: 0.10, // 10% commission
    currency: 'NGN',
  },

  // Pagination Defaults
  pagination: {
    defaultLimit: 10,
    maxLimit: 100,
  },
} as const;

export type Config = typeof config;
