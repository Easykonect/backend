/**
 * Auth Service Tests
 *
 * Covers:
 *   - registerUser refuses names with blocked language before any account is
 *     looked up, created or emailed
 */

jest.mock('@/lib/prisma', () => ({
  __esModule: true,
  default: {
    user: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
  },
}));

// The Resend client throws at import time without an API key
jest.mock('@/lib/email', () => ({
  sendVerificationEmail: jest.fn(),
  sendPasswordResetEmail: jest.fn(),
  sendLoginAlertEmail: jest.fn(),
}));

jest.mock('@/lib/redis', () => ({
  __esModule: true,
  default: { getInstance: jest.fn(), connect: jest.fn() },
}));

jest.mock('@/services/token.service', () => ({
  storeRefreshToken: jest.fn(),
  validateRefreshToken: jest.fn(),
  invalidateRefreshToken: jest.fn(),
}));

import prisma from '@/lib/prisma';
import { sendVerificationEmail } from '@/lib/email';
import { registerUser } from '@/services/auth.service';

const validInput = {
  email: 'ada@example.com',
  password: 'Str0ng!Passw0rd',
  firstName: 'Ada',
  lastName: 'Obi',
};

describe('registerUser — name screening', () => {
  it.each([
    [{ firstName: 'Bitch' }],
    [{ lastName: 'Asshole' }],
    [{ firstName: 'B4stard' }],
  ])('rejects %j with INAPPROPRIATE_CONTENT and creates no account', async (names) => {
    await expect(registerUser({ ...validInput, ...names })).rejects.toMatchObject({
      extensions: { code: 'INAPPROPRIATE_CONTENT' },
    });

    expect(prisma.user.findUnique).not.toHaveBeenCalled();
    expect(prisma.user.create).not.toHaveBeenCalled();
    expect(sendVerificationEmail).not.toHaveBeenCalled();
  });
});
