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
    // The API rate limiter uses the settings below and no longer reads RATE_LIMIT_WINDOW_MS or
    // RATE_LIMIT_MAX_REQUESTS. A missing or invalid value uses the default.
    // A header the edge in front of the app sets to the client's IP and clients can't
    // override. Used before X-Forwarded-For. On Render (which sets RENDER=true) traffic
    // comes through Cloudflare, whose True-Client-IP is the default; X-Forwarded-For there
    // ends with Cloudflare's and Render's own addresses. Elsewhere, leave it unset unless
    // such an edge exists, or clients could fake their IP.
    clientIpHeader: (
      process.env.CLIENT_IP_HEADER || (process.env.RENDER === 'true' ? 'true-client-ip' : '')
    )
      .trim()
      .toLowerCase(),
    // Proxies in front of the app that append to X-Forwarded-For
    trustedProxyCount:
      parseInt(process.env.TRUSTED_PROXY_COUNT || '', 10) >= 0
        ? parseInt(process.env.TRUSTED_PROXY_COUNT as string, 10)
        : 1,
    // GraphQL requests per minute: queries and mutations per signed-in user, and any request
    // per IP from callers without a valid access token
    rateLimitReadsPerMinute:
      parseInt(process.env.RATE_LIMIT_READS_PER_MINUTE || '', 10) > 0
        ? parseInt(process.env.RATE_LIMIT_READS_PER_MINUTE as string, 10)
        : 300,
    rateLimitWritesPerMinute:
      parseInt(process.env.RATE_LIMIT_WRITES_PER_MINUTE || '', 10) > 0
        ? parseInt(process.env.RATE_LIMIT_WRITES_PER_MINUTE as string, 10)
        : 60,
    rateLimitAnonymousPerMinute:
      parseInt(process.env.RATE_LIMIT_ANONYMOUS_PER_MINUTE || '', 10) > 0
        ? parseInt(process.env.RATE_LIMIT_ANONYMOUS_PER_MINUTE as string, 10)
        : 300,
    // Largest GraphQL request accepted: nesting depth (counted through fragments), root
    // fields and aliases. Raise these if the app's own queries get QUERY_TOO_COMPLEX.
    graphqlMaxDepth:
      parseInt(process.env.GRAPHQL_MAX_DEPTH || '', 10) > 0
        ? parseInt(process.env.GRAPHQL_MAX_DEPTH as string, 10)
        : 10,
    graphqlMaxRootFields:
      parseInt(process.env.GRAPHQL_MAX_ROOT_FIELDS || '', 10) > 0
        ? parseInt(process.env.GRAPHQL_MAX_ROOT_FIELDS as string, 10)
        : 20,
    graphqlMaxAliases:
      parseInt(process.env.GRAPHQL_MAX_ALIASES || '', 10) > 0
        ? parseInt(process.env.GRAPHQL_MAX_ALIASES as string, 10)
        : 30,
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

  // Google Maps API
  googleMaps: {
    apiKey: process.env.GOOGLE_MAPS_API_KEY || '',
  },

  // Platform Settings
  platform: {
    name: process.env.PLATFORM_NAME || '',
    // Starting commission (7%), used until a Super Admin sets a rate in the app
    commissionRate: parseFloat(process.env.COMMISSION_RATE || '0.07'),
    currency: process.env.CURRENCY || 'NGN',
    // URL schemes the mobile app registers. After checkout the payment bridge
    // only returns customers to these, or to pages on our own site.
    appUrlSchemes: (process.env.APP_URL_SCHEMES || 'easykonnect,easykonnet')
      .split(',')
      .map((scheme) => scheme.trim().toLowerCase())
      .filter(Boolean),
    frontendUrl: process.env.FRONTEND_URL || '',
    // Public HTTPS origin of this backend (e.g. "https://api.easykonnet.com").
    // Used for the Paystack callback bridge so native apps return to the app via
    // deep link after checkout. Required in production: without it the bridge URL
    // is built on FRONTEND_URL, which is the website, not the API.
    backendUrl: process.env.BACKEND_URL || '',
    supportEmail: process.env.SUPPORT_EMAIL || '',
  },

  // Content moderation and community terms
  moderation: {
    // Version of the community terms users accept; change it when the terms change
    termsVersion: process.env.TERMS_VERSION || '2026-09',
    // Block messages, reviews and listings until the current terms are accepted.
    // Turn on once the app shows the terms screen.
    requireTermsAcceptance: process.env.REQUIRE_TERMS_ACCEPTANCE === 'true',
    // Extra words to filter, comma-separated, on top of the built-in list
    extraBlockedTerms: (process.env.CONTENT_FILTER_TERMS || '')
      .split(',')
      .map((term) => term.trim().toLowerCase())
      .filter(Boolean),
    // Separate reports that hide a message or review until an admin reviews it
    // A missing or invalid value uses the default
    autoHideReportCount:
      parseInt(process.env.AUTO_HIDE_REPORT_COUNT || '', 10) > 0
        ? parseInt(process.env.AUTO_HIDE_REPORT_COUNT as string, 10)
        : 3,
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
 * Check environment variables at startup. A missing required variable stops
 * the server with a clear message; a missing recommended one is logged, since
 * only the feature that uses it stops working.
 */
export const validateEnv = (): { missingRecommended: string[] } => {
  const required = ['DATABASE_URL', 'JWT_SECRET'];
  const recommended = [
    'REDIS_URL',
    'RESEND_API_KEY',
    'EMAIL_FROM_ADDRESS',
    'PAYSTACK_SECRET_KEY',
    'CLOUDINARY_CLOUD_NAME',
    'CLOUDINARY_API_KEY',
    'CLOUDINARY_API_SECRET',
    'ONESIGNAL_APP_ID',
    'ONESIGNAL_REST_API_KEY',
    'FRONTEND_URL',
    'BACKEND_URL',
    'SUPPORT_EMAIL',
  ];

  const missingRequired = required.filter((key) => !process.env[key]);
  if (missingRequired.length > 0) {
    throw new Error(`Missing required environment variables: ${missingRequired.join(', ')}`);
  }

  const missingRecommended = recommended.filter((key) => !process.env[key]);
  if (missingRecommended.length > 0) {
    console.warn(
      `⚠️ Missing environment variables (the features that use them won't work): ${missingRecommended.join(', ')}`
    );
  }

  return { missingRecommended };
};
