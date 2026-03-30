/**
 * Application Configuration
 * Centralizes all environment variables and app settings
 * 
 * IMPORTANT: All sensitive values MUST come from environment variables
 * See .env.example for all required variables
 */

// Helper to ensure Upstash URLs use TLS
const getRedisUrl = (): string => {
  const url = process.env.REDIS_URL || 'redis://localhost:6379';
  
  // Auto-fix Upstash URLs to use TLS (rediss://)
  if (url.includes('upstash.io') && url.startsWith('redis://')) {
    console.warn('⚠️ Upstash Redis URL detected without TLS. Auto-converting to rediss://');
    return url.replace('redis://', 'rediss://');
  }
  
  return url;
};

export const config = {
  // Environment
  nodeEnv: process.env.NODE_ENV || 'development',
  isDevelopment: process.env.NODE_ENV === 'development',
  isProduction: process.env.NODE_ENV === 'production',

  // Server
  port: parseInt(process.env.PORT || '3000', 10),
  hostname: process.env.HOSTNAME || 'localhost',

  // Database
  databaseUrl: process.env.DATABASE_URL || '',

  // Redis (auto-fixes Upstash URLs to use TLS)
  redisUrl: getRedisUrl(),

  // JWT Authentication
  jwt: {
    secret: process.env.JWT_SECRET || '',
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
    refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '30d',
  },

  // Password Hashing
  bcrypt: {
    saltRounds: parseInt(process.env.BCRYPT_SALT_ROUNDS || '12', 10),
  },

  // Email Configuration
  email: {
    host: process.env.SMTP_HOST || '',
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: process.env.SMTP_SECURE === 'true',
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    fromName: process.env.EMAIL_FROM_NAME || '',
    fromAddress: process.env.EMAIL_FROM_ADDRESS || '',
  },

  // Cloudinary
  cloudinary: {
    cloudName: process.env.CLOUDINARY_CLOUD_NAME || '',
    apiKey: process.env.CLOUDINARY_API_KEY || '',
    apiSecret: process.env.CLOUDINARY_API_SECRET || '',
  },

  // OTP Settings
  otp: {
    expiryMinutes: parseInt(process.env.OTP_EXPIRY_MINUTES || '10', 10),
    maxAttempts: parseInt(process.env.OTP_MAX_ATTEMPTS || '3', 10),
    length: parseInt(process.env.OTP_LENGTH || '6', 10),
  },

  // Security Settings
  security: {
    maxLoginAttempts: parseInt(process.env.MAX_LOGIN_ATTEMPTS || '5', 10),
    lockoutDurationMinutes: parseInt(process.env.LOCKOUT_DURATION_MINUTES || '30', 10),
    rateLimitWindowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000', 10), // 15 minutes
    rateLimitMaxRequests: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '100', 10),
  },

  // CORS Settings
  cors: {
    allowedOrigins: (process.env.CORS_ALLOWED_ORIGINS || '')
      .split(',')
      .map(origin => origin.trim())
      .filter(Boolean),
    allowCredentials: true,
  },

  // WebSocket Settings
  websocket: {
    corsOrigins: (process.env.WEBSOCKET_CORS_ORIGINS || '')
      .split(',')
      .map(origin => origin.trim())
      .filter(Boolean),
  },

  // Payment Settings
  payment: {
    paystack: {
      secretKey: process.env.PAYSTACK_SECRET_KEY || '',
      publicKey: process.env.PAYSTACK_PUBLIC_KEY || '',
    },
    stripe: {
      secretKey: process.env.STRIPE_SECRET_KEY || '',
      publicKey: process.env.STRIPE_PUBLIC_KEY || '',
      webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',
    },
  },

  // Push Notifications (OneSignal)
  oneSignal: {
    appId: process.env.ONESIGNAL_APP_ID || '',
    restApiKey: process.env.ONESIGNAL_REST_API_KEY || '',
    apiUrl: process.env.ONESIGNAL_API_URL || 'https://onesignal.com/api/v1',
  },

  // Geolocation Settings
  geo: {
    defaultRadiusKm: parseFloat(process.env.GEO_DEFAULT_RADIUS_KM || '25'),
    maxRadiusKm: parseFloat(process.env.GEO_MAX_RADIUS_KM || '100'),
  },

  // Platform Settings
  platform: {
    name: process.env.PLATFORM_NAME || '',
    commissionRate: parseFloat(process.env.COMMISSION_RATE || '0.10'),
    currency: process.env.CURRENCY || '',
    frontendUrl: process.env.FRONTEND_URL || '',
    supportEmail: process.env.SUPPORT_EMAIL || '',
  },

  // Pagination Defaults
  pagination: {
    defaultLimit: 10,
    maxLimit: 100,
  },

  // Logging
  logging: {
    level: process.env.LOG_LEVEL || 'info',
    sentryDsn: process.env.SENTRY_DSN || '',
  },
} as const;

export type Config = typeof config;

/**
 * Validate required environment variables
 * Call this on app startup
 */
export const validateEnv = (): void => {
  const required = [
    'DATABASE_URL',
    'JWT_SECRET',
    'SMTP_HOST',
    'SMTP_USER',
    'SMTP_PASS',
    'EMAIL_FROM_NAME',
    'EMAIL_FROM_ADDRESS',
    'CLOUDINARY_CLOUD_NAME',
    'CLOUDINARY_API_KEY',
    'CLOUDINARY_API_SECRET',
    'REDIS_URL',
    'PLATFORM_NAME',
    'CURRENCY',
    'FRONTEND_URL',
    'SUPPORT_EMAIL',
  ];

  const missing = required.filter(key => !process.env[key]);

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  if (config.isProduction && !config.jwt.secret) {
    throw new Error('JWT_SECRET must be set in production!');
  }
};
