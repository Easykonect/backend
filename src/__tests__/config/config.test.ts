/**
 * Config Tests
 * Ensures all required environment variables are loaded
 * and config values are valid
 */

import { config } from '@/config';

describe('Application Config', () => {
  // ==================
  // Environment
  // ==================
  describe('Environment', () => {
    it('should have a valid NODE_ENV', () => {
      expect(['development', 'production', 'test']).toContain(config.nodeEnv);
    });

    it('should have a valid port number', () => {
      expect(config.port).toBeGreaterThan(0);
      expect(config.port).toBeLessThan(65536);
    });

    it('should have boolean flags for environment', () => {
      expect(typeof config.isDevelopment).toBe('boolean');
      expect(typeof config.isProduction).toBe('boolean');
      // Only one can be true at a time
      expect(config.isDevelopment && config.isProduction).toBe(false);
    });
  });

  // ==================
  // Database
  // ==================
  describe('Database', () => {
    it('should have a DATABASE_URL configured', () => {
      expect(config.databaseUrl).toBeTruthy();
    });

    it('should have a MongoDB connection string format', () => {
      expect(config.databaseUrl).toMatch(/^mongodb/);
    });
  });

  // ==================
  // Redis
  // ==================
  describe('Redis', () => {
    it('should have a REDIS_URL configured', () => {
      expect(config.redisUrl).toBeTruthy();
    });

    it('should use rediss:// (TLS) for Upstash', () => {
      if (config.redisUrl.includes('upstash.io')) {
        expect(config.redisUrl).toMatch(/^rediss:\/\//);
      }
    });
  });

  // ==================
  // JWT
  // ==================
  describe('JWT', () => {
    it('should have a JWT secret configured', () => {
      expect(config.jwt.secret).toBeTruthy();
    });

    it('should not use the default/insecure JWT secret in production', () => {
      if (config.isProduction) {
        expect(config.jwt.secret).not.toBe('default-secret-change-in-production');
        expect(config.jwt.secret.length).toBeGreaterThanOrEqual(32);
      }
    });

    it('should have valid token expiry formats', () => {
      expect(config.jwt.expiresIn).toMatch(/^\d+[dhms]$/);
      expect(config.jwt.refreshExpiresIn).toMatch(/^\d+[dhms]$/);
    });
  });

  // ==================
  // Email
  // ==================
  describe('Email', () => {
    it('should have SMTP configuration', () => {
      expect(config.email.host).toBeTruthy();
      expect(config.email.port).toBeGreaterThan(0);
      expect(config.email.fromAddress).toMatch(/^[^\s@]+@[^\s@]+\.[^\s@]+$/);
    });

    it('should have a valid SMTP port', () => {
      expect([25, 465, 587, 2525]).toContain(config.email.port);
    });
  });

  // ==================
  // Cloudinary
  // ==================
  describe('Cloudinary', () => {
    it('should have Cloudinary credentials configured', () => {
      expect(config.cloudinary.cloudName).toBeTruthy();
      expect(config.cloudinary.apiKey).toBeTruthy();
      expect(config.cloudinary.apiSecret).toBeTruthy();
    });
  });

  // ==================
  // OTP
  // ==================
  describe('OTP', () => {
    it('should have a sensible OTP length', () => {
      expect(config.otp.length).toBeGreaterThanOrEqual(4);
      expect(config.otp.length).toBeLessThanOrEqual(10);
    });

    it('should have a sensible OTP expiry', () => {
      expect(config.otp.expiryMinutes).toBeGreaterThan(0);
      expect(config.otp.expiryMinutes).toBeLessThanOrEqual(60);
    });
  });

  // ==================
  // Security
  // ==================
  describe('Security', () => {
    it('should have bcrypt salt rounds >= 10', () => {
      expect(config.bcrypt.saltRounds).toBeGreaterThanOrEqual(10);
    });

    it('should have a max login attempts limit', () => {
      expect(config.security.maxLoginAttempts).toBeGreaterThan(0);
    });

    it('should have a rate limit window configured', () => {
      expect(config.security.rateLimitWindowMs).toBeGreaterThan(0);
    });
  });

  // ==================
  // Platform
  // ==================
  describe('Platform', () => {
    it('should have a valid commission rate between 0 and 1', () => {
      expect(config.platform.commissionRate).toBeGreaterThan(0);
      expect(config.platform.commissionRate).toBeLessThan(1);
    });

    it('should have a valid currency code', () => {
      expect(config.platform.currency).toMatch(/^[A-Z]{3}$/); // ISO 4217
    });
  });
});
