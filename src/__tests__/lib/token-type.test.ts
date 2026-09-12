/**
 * Access vs refresh token types
 */

jest.mock('@/config', () => ({
  config: {
    jwt: { secret: 'test-secret', expiresIn: '15m', refreshExpiresIn: '30d' },
    bcrypt: { saltRounds: 4 },
  },
}));

import jwt from 'jsonwebtoken';
import {
  generateToken,
  generateRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
} from '@/lib/auth';

const payload = {
  userId: '507f1f77bcf86cd799439011',
  email: 'ada@example.com',
  role: 'SERVICE_USER' as const,
};

describe('token types', () => {
  it('accepts an access token as an access token', () => {
    expect(verifyAccessToken(generateToken(payload)).userId).toBe(payload.userId);
  });

  it('accepts a refresh token at a refresh endpoint', () => {
    expect(verifyRefreshToken(generateRefreshToken(payload)).userId).toBe(payload.userId);
  });

  it('rejects a refresh token presented as an access token', () => {
    expect(() => verifyAccessToken(generateRefreshToken(payload))).toThrow(/access token/);
  });

  it('rejects an access token presented to a refresh endpoint', () => {
    expect(() => verifyRefreshToken(generateToken(payload))).toThrow(/refresh token/);
  });

  it('rejects tokens issued before token types existed', () => {
    const legacy = jwt.sign(payload, 'test-secret', { expiresIn: '15m' });
    expect(() => verifyAccessToken(legacy)).toThrow();
  });
});
