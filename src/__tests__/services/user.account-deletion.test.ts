/**
 * Account deletion (deleteAccount and admin deleteUser)
 *
 * Covers:
 *   - the account is anonymised, not removed: personal data scrubbed, placeholder
 *     email, unusable password, push IDs cleared, sessions ended
 *   - a provider's services are hidden and its business details and bank accounts removed
 *   - deletion is refused while bookings, disputes, payouts, held earnings or wallet
 *     money are outstanding, with a code for each
 *   - the optional password confirmation
 *   - deleteUser uses the same rules and returns NOT_FOUND like the other admin user operations
 */

jest.mock('@/lib/prisma', () => ({
  __esModule: true,
  default: {
    user: { findUnique: jest.fn() },
    serviceProvider: { findUnique: jest.fn() },
    booking: { count: jest.fn() },
    dispute: { count: jest.fn() },
    wallet: { findUnique: jest.fn() },
    withdrawal: { count: jest.fn() },
    scheduledPayout: { count: jest.fn() },
  },
}));

jest.mock('@/lib/transaction', () => ({ withTransaction: jest.fn() }));
jest.mock('@/lib/email', () => ({
  sendProfileUpdatedEmail: jest.fn(),
  sendEmailChangeOtpEmail: jest.fn(),
}));
jest.mock('@/lib/redis', () => ({
  __esModule: true,
  default: { getInstance: jest.fn(), connect: jest.fn() },
}));
jest.mock('@/lib/auth', () => ({
  ...jest.requireActual('@/lib/auth'),
  hashPassword: jest.fn(),
}));
jest.mock('@/services/audit.service', () => ({ createAuditLog: jest.fn() }));
jest.mock('@/services/auth.service', () => ({ confirmAccountPassword: jest.fn() }));
jest.mock('@/services/token.service', () => ({ endAllSessions: jest.fn() }));
jest.mock('@/services/push.service', () => ({ unregisterPushToken: jest.fn() }));

import { GraphQLError } from 'graphql';
import prisma from '@/lib/prisma';
import { withTransaction } from '@/lib/transaction';
import { hashPassword } from '@/lib/auth';
import { createAuditLog } from '@/services/audit.service';
import { confirmAccountPassword } from '@/services/auth.service';
import { endAllSessions } from '@/services/token.service';
import { unregisterPushToken } from '@/services/push.service';
import { deleteOwnAccount, deleteUser, deletedAccountEmail } from '@/services/user.service';

const USER_ID = '507f1f77bcf86cd799439011';
const PROVIDER_ID = '507f1f77bcf86cd799439022';
const ADMIN_ID = '507f1f77bcf86cd799439033';

const tx = {
  serviceProvider: { findUnique: jest.fn(), update: jest.fn() },
  service: { updateMany: jest.fn() },
  providerBankAccount: { deleteMany: jest.fn() },
  payoutSchedule: { updateMany: jest.fn() },
  favourite: { deleteMany: jest.fn() },
  providerLike: { deleteMany: jest.fn() },
  userSettings: { deleteMany: jest.fn() },
  notification: { deleteMany: jest.fn() },
  user: { update: jest.fn() },
};

const account = (overrides: Record<string, unknown> = {}) => ({
  id: USER_ID,
  email: 'ada@example.com',
  password: 'stored-hash',
  role: 'SERVICE_USER',
  status: 'ACTIVE',
  deletedAt: null,
  failedLoginAttempts: 0,
  lockoutUntil: null,
  ...overrides,
});

type Outstanding = {
  provider?: boolean;
  activeBookings?: number;
  openDisputes?: number;
  withdrawals?: number;
  payouts?: number;
  earningsOnHold?: number;
  balance?: number;
  pendingBalance?: number;
};

const given = (user: Record<string, unknown> | null, outstanding: Outstanding = {}) => {
  const {
    provider = false,
    activeBookings = 0,
    openDisputes = 0,
    withdrawals = 0,
    payouts = 0,
    earningsOnHold = 0,
    balance = 0,
    pendingBalance = 0,
  } = outstanding;
  const providerRecord = provider ? { id: PROVIDER_ID } : null;

  (prisma.user.findUnique as jest.Mock).mockResolvedValue(user);
  (prisma.serviceProvider.findUnique as jest.Mock).mockResolvedValue(providerRecord);
  (prisma.booking.count as jest.Mock).mockImplementation(
    async ({ where }: { where: { status: unknown } }) =>
      where.status === 'COMPLETED' ? earningsOnHold : activeBookings
  );
  (prisma.dispute.count as jest.Mock).mockResolvedValue(openDisputes);
  (prisma.withdrawal.count as jest.Mock).mockResolvedValue(withdrawals);
  (prisma.scheduledPayout.count as jest.Mock).mockResolvedValue(payouts);
  (prisma.wallet.findUnique as jest.Mock).mockResolvedValue({ balance, pendingBalance });
  tx.serviceProvider.findUnique.mockResolvedValue(providerRecord);
};

beforeEach(() => {
  (withTransaction as jest.Mock).mockImplementation(async (run: (client: typeof tx) => unknown) => run(tx));
  (hashPassword as jest.Mock).mockResolvedValue('unusable-hash');
});

describe('deleteOwnAccount', () => {
  it('anonymises the account instead of removing it', async () => {
    given(account());

    await expect(deleteOwnAccount(USER_ID)).resolves.toEqual({
      success: true,
      message: 'Your account has been deleted successfully.',
    });

    expect(tx.user.update).toHaveBeenCalledWith({
      where: { id: USER_ID },
      data: expect.objectContaining({
        email: deletedAccountEmail(USER_ID),
        firstName: 'Deleted',
        lastName: 'User',
        phone: null,
        profilePhoto: null,
        password: 'unusable-hash',
        status: 'DEACTIVATED',
        oneSignalPlayerId: null,
        oneSignalPlayerIds: [],
        pushEnabled: false,
        pendingEmail: null,
        passwordResetToken: null,
        deletedAt: expect.any(Date),
        tokenInvalidatedAt: expect.any(Date),
      }),
    });
    expect((hashPassword as jest.Mock).mock.calls[0][0]).toMatch(/^[0-9a-f]{64}$/);

    for (const model of [tx.favourite, tx.providerLike, tx.userSettings, tx.notification]) {
      expect(model.deleteMany).toHaveBeenCalledWith({ where: { userId: USER_ID } });
    }
    expect(unregisterPushToken).toHaveBeenCalledWith(USER_ID);
    expect(endAllSessions).toHaveBeenCalledWith(USER_ID);
  });

  it('uses a unique address that cannot receive email', () => {
    expect(deletedAccountEmail(USER_ID)).toBe(`deleted-${USER_ID}@deleted.easykonnet.invalid`);
  });

  it("hides a provider's services and removes its business details and bank accounts", async () => {
    given(account({ role: 'SERVICE_PROVIDER' }), { provider: true });

    await deleteOwnAccount(USER_ID);

    expect(tx.service.updateMany).toHaveBeenCalledWith({
      where: { providerId: PROVIDER_ID },
      data: { status: 'INACTIVE', images: [] },
    });
    expect(tx.providerBankAccount.deleteMany).toHaveBeenCalledWith({ where: { providerId: PROVIDER_ID } });
    expect(tx.payoutSchedule.updateMany).toHaveBeenCalledWith({
      where: { providerId: PROVIDER_ID },
      data: { isActive: false, bankAccountId: null },
    });
    expect(tx.serviceProvider.update).toHaveBeenCalledWith({
      where: { id: PROVIDER_ID },
      data: expect.objectContaining({
        businessName: 'Deleted provider',
        businessDescription: null,
        address: '',
        images: [],
        documents: [],
      }),
    });
  });

  it('allows a provider whose bookings are all finished', async () => {
    given(account({ role: 'SERVICE_PROVIDER' }), { provider: true });

    await expect(deleteOwnAccount(USER_ID)).resolves.toMatchObject({ success: true });

    expect(prisma.booking.count).toHaveBeenCalledWith({
      where: {
        status: { in: ['PENDING', 'ACCEPTED', 'IN_PROGRESS'] },
        OR: [{ userId: USER_ID }, { providerId: PROVIDER_ID }],
      },
    });
  });

  it.each([
    [{ activeBookings: 1 }, 'HAS_ACTIVE_BOOKINGS'],
    [{ openDisputes: 1 }, 'HAS_OPEN_DISPUTES'],
    [{ provider: true, withdrawals: 1 }, 'HAS_PENDING_WITHDRAWALS'],
    [{ provider: true, payouts: 1 }, 'HAS_PENDING_WITHDRAWALS'],
    [{ provider: true, earningsOnHold: 2 }, 'HAS_PENDING_EARNINGS'],
    [{ pendingBalance: 50_000 }, 'HAS_PENDING_EARNINGS'],
    [{ balance: 100 }, 'WALLET_BALANCE_NOT_EMPTY'],
  ])('refuses while %j is outstanding (%s)', async (outstanding, code) => {
    given(account(), outstanding);

    await expect(deleteOwnAccount(USER_ID)).rejects.toMatchObject({ extensions: { code } });

    expect(withTransaction).not.toHaveBeenCalled();
    expect(endAllSessions).not.toHaveBeenCalled();
  });

  it('names the wallet balance in naira', async () => {
    given(account(), { balance: 150_050 });

    await expect(deleteOwnAccount(USER_ID)).rejects.toMatchObject({
      message: 'Your wallet still has ₦1,500.50. Withdraw or use it before deleting your account, or contact support for help.',
    });
  });

  it('checks the password when the app sends one', async () => {
    const user = account();
    given(user);

    await deleteOwnAccount(USER_ID, 'Str0ng!Pass');

    expect(confirmAccountPassword).toHaveBeenCalledWith(user, 'Str0ng!Pass', {
      code: 'INVALID_PASSWORD',
      message: 'Password is incorrect',
    });
  });

  it('keeps the account when the password is wrong', async () => {
    given(account());
    (confirmAccountPassword as jest.Mock).mockRejectedValue(
      new GraphQLError('Password is incorrect', { extensions: { code: 'INVALID_PASSWORD' } })
    );

    await expect(deleteOwnAccount(USER_ID, 'wrong')).rejects.toMatchObject({
      extensions: { code: 'INVALID_PASSWORD' },
    });
    expect(withTransaction).not.toHaveBeenCalled();
  });

  it("doesn't ask for the password when none is sent", async () => {
    given(account());

    await deleteOwnAccount(USER_ID, null);

    expect(confirmAccountPassword).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', null],
    ['already deleted', account({ deletedAt: new Date() })],
  ])('returns USER_NOT_FOUND for an account that is %s', async (_label, user) => {
    given(user);

    await expect(deleteOwnAccount(USER_ID)).rejects.toMatchObject({
      extensions: { code: 'USER_NOT_FOUND' },
    });
  });
});

describe('deleteUser (admin)', () => {
  it('anonymises the account and records the deletion', async () => {
    given(account());

    await expect(deleteUser(USER_ID, ADMIN_ID, 'ADMIN')).resolves.toEqual({
      success: true,
      message: 'User deleted successfully',
    });

    expect(tx.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ email: deletedAccountEmail(USER_ID) }) })
    );
    expect(createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'DELETE_USER', targetId: USER_ID, performedBy: ADMIN_ID })
    );
  });

  it.each([
    ['missing', null],
    ['already deleted', account({ deletedAt: new Date() })],
  ])('returns NOT_FOUND for an account that is %s', async (_label, user) => {
    given(user);

    await expect(deleteUser(USER_ID, ADMIN_ID, 'ADMIN')).rejects.toMatchObject({
      message: 'User not found',
      extensions: { code: 'NOT_FOUND' },
    });
  });

  it('refuses admin accounts and yourself', async () => {
    given(account({ role: 'ADMIN' }));
    await expect(deleteUser(USER_ID, ADMIN_ID, 'SUPER_ADMIN')).rejects.toMatchObject({
      extensions: { code: 'FORBIDDEN' },
    });
    await expect(deleteUser(ADMIN_ID, ADMIN_ID, 'SUPER_ADMIN')).rejects.toMatchObject({
      extensions: { code: 'FORBIDDEN' },
    });
  });

  it('applies the same refusals, worded for the admin', async () => {
    given(account(), { activeBookings: 1 });

    await expect(deleteUser(USER_ID, ADMIN_ID, 'ADMIN')).rejects.toMatchObject({
      message: 'This user has bookings that are pending, accepted or in progress. They must be completed or cancelled first.',
      extensions: { code: 'HAS_ACTIVE_BOOKINGS' },
    });
    expect(createAuditLog).not.toHaveBeenCalled();
  });
});
