/**
 * Auth Utilities Tests
 * Tests JWT generation/verification and password hashing
 */

import {
  generateToken,
  generateRefreshToken,
  verifyToken,
  hashPassword,
  comparePassword,
} from '@/lib/auth';
import type { JWTPayload } from '@/lib/auth';

const mockPayload: JWTPayload = {
  userId: '507f1f77bcf86cd799439011',
  email: 'test@example.com',
  role: 'SERVICE_USER',
};

// ==================
// JWT Tests
// ==================
describe('JWT Utilities', () => {
  describe('generateToken', () => {
    it('should generate a valid JWT token', () => {
      const token = generateToken(mockPayload);
      expect(token).toBeDefined();
      expect(typeof token).toBe('string');
      expect(token.split('.')).toHaveLength(3); // JWT format: header.payload.signature
    });

    it('should encode the payload correctly', () => {
      const token = generateToken(mockPayload);
      const decoded = verifyToken(token);
      expect(decoded.userId).toBe(mockPayload.userId);
      expect(decoded.email).toBe(mockPayload.email);
      expect(decoded.role).toBe(mockPayload.role);
    });

    it('should generate different tokens for different payloads', () => {
      const token1 = generateToken(mockPayload);
      const token2 = generateToken({ ...mockPayload, userId: 'different-id' });
      expect(token1).not.toBe(token2);
    });
  });

  describe('generateRefreshToken', () => {
    it('should generate a valid refresh token', () => {
      const token = generateRefreshToken(mockPayload);
      expect(token).toBeDefined();
      expect(typeof token).toBe('string');
      expect(token.split('.')).toHaveLength(3);
    });

    it('should generate a token different from the access token', () => {
      const accessToken = generateToken(mockPayload);
      const refreshToken = generateRefreshToken(mockPayload);
      // Refresh has longer expiry so the signatures should differ
      expect(accessToken).not.toBe(refreshToken);
    });
  });

  describe('verifyToken', () => {
    it('should verify a valid token and return the payload', () => {
      const token = generateToken(mockPayload);
      const decoded = verifyToken(token);
      expect(decoded.userId).toBe(mockPayload.userId);
      expect(decoded.email).toBe(mockPayload.email);
      expect(decoded.role).toBe(mockPayload.role);
    });

    it('should throw an error for an invalid token', () => {
      expect(() => verifyToken('invalid.token.here')).toThrow();
    });

    it('should throw an error for a tampered token', () => {
      const token = generateToken(mockPayload);
      const parts = token.split('.');
      const tampered = `${parts[0]}.${parts[1]}tampered.${parts[2]}`;
      expect(() => verifyToken(tampered)).toThrow();
    });

    it('should throw an error for an empty token', () => {
      expect(() => verifyToken('')).toThrow();
    });
  });
});

// ==================
// Password Tests
// ==================
describe('Password Utilities', () => {
  describe('hashPassword', () => {
    it('should hash a password', async () => {
      const hash = await hashPassword('Password123!');
      expect(hash).toBeDefined();
      expect(hash).not.toBe('Password123!');
      expect(hash).toHaveLength(60); // bcrypt hash length
    });

    it('should produce different hashes for the same password', async () => {
      const hash1 = await hashPassword('Password123!');
      const hash2 = await hashPassword('Password123!');
      expect(hash1).not.toBe(hash2); // Different salts
    });
  });

  describe('comparePassword', () => {
    it('should return true for a matching password', async () => {
      const password = 'Password123!';
      const hash = await hashPassword(password);
      const result = await comparePassword(password, hash);
      expect(result).toBe(true);
    });

    it('should return false for a wrong password', async () => {
      const hash = await hashPassword('Password123!');
      const result = await comparePassword('WrongPassword!', hash);
      expect(result).toBe(false);
    });

    it('should return false for an empty password', async () => {
      const hash = await hashPassword('Password123!');
      const result = await comparePassword('', hash);
      expect(result).toBe(false);
    });
  });
});
