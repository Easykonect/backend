/**
 * Profile and email changes
 *
 * Covers:
 *   - updateProfile stores phone numbers in the same form as register
 *   - requestEmailChange names the real code expiry
 *   - confirmEmailChange refuses an address another account took in the meantime,
 *     including when the unique index catches it, and cancels the pending change
 */

jest.mock('@/lib/prisma', () => ({
  __esModule: true,
  default: {
    user: { findUnique: jest.fn(), update: jest.fn() },
  },
}));

jest.mock('@/lib/email', () => ({
  sendProfileUpdatedEmail: jest.fn(),
  sendEmailChangeOtpEmail: jest.fn(),
}));
jest.mock('@/lib/redis', () => ({
  __esModule: true,
  default: { getInstance: jest.fn(), connect: jest.fn() },
}));
jest.mock('@/lib/transaction', () => ({ withTransaction: jest.fn() }));
jest.mock('@/services/audit.service', () => ({ createAuditLog: jest.fn() }));
jest.mock('@/services/auth.service', () => ({ confirmAccountPassword: jest.fn() }));
jest.mock('@/services/token.service', () => ({ endAllSessions: jest.fn() }));
jest.mock('@/services/push.service', () => ({ unregisterPushToken: jest.fn() }));

import { Prisma } from '@prisma/client';
import prisma from '@/lib/prisma';
import { config } from '@/config';
import { hashOtp } from '@/lib/otp';
import { sendProfileUpdatedEmail, sendEmailChangeOtpEmail } from '@/lib/email';
import {
  confirmEmailChange,
  requestEmailChange,
  updateUserProfile,
} from '@/services/user.service';

const USER_ID = '507f1f77bcf86cd799439011';
const OTHER_ID = '507f1f77bcf86cd799439099';

const findUser = prisma.user.findUnique as jest.Mock;
const updateUser = prisma.user.update as jest.Mock;

const account = (overrides: Record<string, unknown> = {}) => ({
  id: USER_ID,
  email: 'ada@example.com',
  firstName: 'Ada',
  lastName: 'Obi',
  phone: null,
  profilePhoto: null,
  pendingEmail: null,
  emailVerifyToken: null,
  emailVerifyExpiry: null,
  ...overrides,
});

beforeEach(() => {
  (sendProfileUpdatedEmail as jest.Mock).mockResolvedValue(true);
  updateUser.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    ...account(),
    ...data,
  }));
});

describe('updateUserProfile phone', () => {
  it('stores a local number in the international form register uses', async () => {
    findUser.mockResolvedValue(account({ phone: '08031234567' }));

    await updateUserProfile(USER_ID, { phone: '0803 123 4567' });

    expect(updateUser.mock.calls[0][0].data).toEqual({ phone: '+2348031234567' });
  });

  it('sees the same number in another format as unchanged', async () => {
    findUser.mockResolvedValue(account({ phone: '+2348031234567' }));

    await updateUserProfile(USER_ID, { phone: '0803-123-4567' });

    expect(updateUser).not.toHaveBeenCalled();
  });

  it('removes the number with an empty string or null', async () => {
    findUser.mockResolvedValue(account({ phone: '+2348031234567' }));
    await updateUserProfile(USER_ID, { phone: '' });
    expect(updateUser.mock.calls[0][0].data).toEqual({ phone: null });

    updateUser.mockClear();
    await updateUserProfile(USER_ID, { phone: null });
    expect(updateUser.mock.calls[0][0].data).toEqual({ phone: null });
  });

  it('returns activeRole and pushEnabled from the account', async () => {
    findUser.mockResolvedValue(account());

    await updateUserProfile(USER_ID, { phone: '08031234567' });

    expect(updateUser.mock.calls[0][0].select).toMatchObject({ activeRole: true, pushEnabled: true, lastLoginAt: true });
  });
});

describe('requestEmailChange', () => {
  it('names the configured code expiry', async () => {
    findUser.mockImplementation(async ({ where }: { where: { id?: string } }) => (where.id ? account() : null));
    (sendEmailChangeOtpEmail as jest.Mock).mockResolvedValue(true);

    const result = await requestEmailChange(USER_ID, 'new@example.com');

    const minutes = config.otp.expiryMinutes;
    expect(result.message).toBe(
      `A confirmation code has been sent to new@example.com. It expires in ${minutes} minute${minutes === 1 ? '' : 's'}.`
    );
  });

  it('refuses an address another account uses', async () => {
    findUser.mockImplementation(async ({ where }: { where: { id?: string } }) =>
      where.id ? account() : { id: OTHER_ID }
    );

    await expect(requestEmailChange(USER_ID, 'taken@example.com')).rejects.toMatchObject({
      message: 'This email address is already in use',
      extensions: { code: 'USER_ALREADY_EXISTS' },
    });
  });
});

describe('confirmEmailChange', () => {
  const pending = account({
    pendingEmail: 'new@example.com',
    emailVerifyToken: hashOtp('111111'),
    emailVerifyExpiry: new Date(Date.now() + 5 * 60 * 1000),
  });
  const cancelled = { pendingEmail: null, emailVerifyToken: null, emailVerifyExpiry: null };
  const takenError = {
    message: 'This email address is now used by another account. Please request a change to a different address.',
    extensions: { code: 'USER_ALREADY_EXISTS' },
  };

  it('switches to the new address when it is still free', async () => {
    findUser.mockImplementation(async ({ where }: { where: { id?: string } }) => (where.id ? pending : null));

    const result = await confirmEmailChange(USER_ID, '111111');

    expect(result.email).toBe('new@example.com');
    expect(updateUser.mock.calls[0][0].select).toMatchObject({ activeRole: true, pushEnabled: true });
  });

  it('refuses and cancels the change when another account took the address', async () => {
    findUser.mockImplementation(async ({ where }: { where: { id?: string } }) =>
      where.id ? pending : { id: OTHER_ID }
    );

    await expect(confirmEmailChange(USER_ID, '111111')).rejects.toMatchObject(takenError);

    expect(updateUser).toHaveBeenCalledTimes(1);
    expect(updateUser.mock.calls[0][0].data).toEqual(cancelled);
  });

  it('turns a unique-index clash into the same error', async () => {
    findUser.mockImplementation(async ({ where }: { where: { id?: string } }) => (where.id ? pending : null));
    updateUser
      .mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError('Unique constraint failed on the constraint: `users_email_key`', {
          code: 'P2002',
          clientVersion: Prisma.prismaVersion.client,
        })
      )
      .mockResolvedValueOnce(account());

    await expect(confirmEmailChange(USER_ID, '111111')).rejects.toMatchObject(takenError);

    expect(updateUser.mock.calls[1][0].data).toEqual(cancelled);
  });

  it('still checks the code before the address', async () => {
    findUser.mockImplementation(async ({ where }: { where: { id?: string } }) =>
      where.id ? pending : { id: OTHER_ID }
    );

    await expect(confirmEmailChange(USER_ID, '000000')).rejects.toMatchObject({
      extensions: { code: 'INVALID_OTP' },
    });
    expect(updateUser).not.toHaveBeenCalled();
  });
});
