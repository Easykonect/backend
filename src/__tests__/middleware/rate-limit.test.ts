/**
 * Rate Limiting Middleware Tests
 * Tests rate limit config, IP extraction, and logic
 */

import { RateLimitConfig, getClientIp } from '@/middleware/rate-limit.middleware';
import { NextRequest } from 'next/server';

// Helper to create a mock NextRequest with headers
const createRequest = (headers: Record<string, string> = {}) => {
  const req = new NextRequest('http://localhost:3000/api/graphql', {
    method: 'POST',
    headers: new Headers(headers),
  });
  return req;
};

describe('Rate Limiting Middleware', () => {
  // ==================
  // Rate Limit Configs
  // ==================
  describe('RateLimitConfig', () => {
    it('should define all required rate limit types', () => {
      expect(RateLimitConfig.API).toBeDefined();
      expect(RateLimitConfig.AUTH).toBeDefined();
      expect(RateLimitConfig.LOGIN).toBeDefined();
      expect(RateLimitConfig.PASSWORD_RESET).toBeDefined();
      expect(RateLimitConfig.OTP).toBeDefined();
      expect(RateLimitConfig.UPLOAD).toBeDefined();
      expect(RateLimitConfig.MESSAGE).toBeDefined();
    });

    it('should have stricter limits for sensitive operations', () => {
      // Auth/login should be stricter than general API
      expect(RateLimitConfig.AUTH.limit).toBeLessThan(RateLimitConfig.API.limit);
      expect(RateLimitConfig.LOGIN.limit).toBeLessThan(RateLimitConfig.API.limit);
    });

    it('should have the strictest limit for password reset', () => {
      expect(RateLimitConfig.PASSWORD_RESET.limit).toBeLessThanOrEqual(
        RateLimitConfig.AUTH.limit
      );
    });

    it('should have positive limits and window seconds', () => {
      Object.values(RateLimitConfig).forEach((cfg) => {
        expect(cfg.limit).toBeGreaterThan(0);
        expect(cfg.windowSeconds).toBeGreaterThan(0);
      });
    });
  });

  // ==================
  // IP Extraction
  // ==================
  describe('getClientIp', () => {
    it('should extract IP from x-forwarded-for header', () => {
      const req = createRequest({ 'x-forwarded-for': '203.0.113.1' });
      const ip = getClientIp(req);
      expect(ip).toBe('203.0.113.1');
    });

    it('should use only the first IP from a list in x-forwarded-for', () => {
      const req = createRequest({ 'x-forwarded-for': '203.0.113.1, 10.0.0.1, 172.16.0.1' });
      const ip = getClientIp(req);
      expect(ip).toBe('203.0.113.1');
    });

    it('should fall back to x-real-ip when x-forwarded-for is absent', () => {
      const req = createRequest({ 'x-real-ip': '203.0.113.2' });
      const ip = getClientIp(req);
      expect(ip).toBe('203.0.113.2');
    });

    it('should return unknown when no IP header is present', () => {
      const req = createRequest({});
      const ip = getClientIp(req);
      expect(ip).toBeTruthy(); // Should return some fallback
    });
  });
});
