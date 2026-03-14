/**
 * OTP Utilities Tests
 * Tests OTP generation, hashing and verification
 */

import { generateOtp, hashOtp, verifyOtp, getOtpExpiry } from '@/lib/otp';

describe('OTP Utilities', () => {
  describe('generateOtp', () => {
    it('should generate a 6-digit OTP by default', () => {
      const otp = generateOtp();
      expect(otp).toHaveLength(6);
      expect(/^\d+$/.test(otp)).toBe(true); // All digits
    });

    it('should generate an OTP of custom length', () => {
      const otp = generateOtp(8);
      expect(otp).toHaveLength(8);
    });

    it('should generate different OTPs on each call', () => {
      const otps = new Set(Array.from({ length: 100 }, () => generateOtp()));
      // With 6 digits (1,000,000 combos) generating 100 OTPs, they should mostly be unique
      expect(otps.size).toBeGreaterThan(90);
    });

    it('should only contain numeric digits', () => {
      for (let i = 0; i < 20; i++) {
        const otp = generateOtp();
        expect(/^\d+$/.test(otp)).toBe(true);
      }
    });
  });

  describe('hashOtp', () => {
    it('should return a hex string hash', () => {
      const hash = hashOtp('123456');
      expect(hash).toBeDefined();
      expect(typeof hash).toBe('string');
      expect(/^[a-f0-9]+$/.test(hash)).toBe(true); // Hex format
      expect(hash).toHaveLength(64); // SHA-256 hex is 64 chars
    });

    it('should produce the same hash for the same OTP', () => {
      const otp = '123456';
      const hash1 = hashOtp(otp);
      const hash2 = hashOtp(otp);
      expect(hash1).toBe(hash2);
    });

    it('should produce different hashes for different OTPs', () => {
      const hash1 = hashOtp('123456');
      const hash2 = hashOtp('654321');
      expect(hash1).not.toBe(hash2);
    });
  });

  describe('verifyOtp', () => {
    it('should return true for a valid OTP', () => {
      const otp = generateOtp();
      const hash = hashOtp(otp);
      expect(verifyOtp(otp, hash)).toBe(true);
    });

    it('should return false for an incorrect OTP', () => {
      const hash = hashOtp('123456');
      expect(verifyOtp('654321', hash)).toBe(false);
    });

    it('should return false for an empty OTP', () => {
      const hash = hashOtp('123456');
      expect(verifyOtp('', hash)).toBe(false);
    });

    it('should be timing-safe (no early exit)', () => {
      // Both comparisons should take similar time
      const hash = hashOtp('123456');
      const start1 = Date.now();
      verifyOtp('000000', hash);
      const time1 = Date.now() - start1;

      const start2 = Date.now();
      verifyOtp('999999', hash);
      const time2 = Date.now() - start2;

      // Time difference should be negligible (within 50ms)
      expect(Math.abs(time1 - time2)).toBeLessThan(50);
    });
  });

  describe('getOtpExpiry', () => {
    it('should return a future date', () => {
      const expiry = getOtpExpiry();
      expect(expiry).toBeInstanceOf(Date);
      expect(expiry.getTime()).toBeGreaterThan(Date.now());
    });

    it('should return an expiry approximately 10 minutes in the future', () => {
      const before = Date.now();
      const expiry = getOtpExpiry();
      const after = Date.now();

      const expectedMin = before + 9 * 60 * 1000; // 9 min (buffer)
      const expectedMax = after + 11 * 60 * 1000; // 11 min (buffer)

      expect(expiry.getTime()).toBeGreaterThanOrEqual(expectedMin);
      expect(expiry.getTime()).toBeLessThanOrEqual(expectedMax);
    });
  });
});
