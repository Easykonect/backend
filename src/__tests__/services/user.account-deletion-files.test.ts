/**
 * Account deletion (deleteAccount and admin deleteUser) removes the account's
 * Cloudinary files, but only once the account has been anonymised
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
jest.mock('@/services/upload.service', () => ({
  getUserFileUrls: jest.fn(),
  deleteUserFiles: jest.fn(),
}));

import prisma from '@/lib/prisma';
import { withTransaction } from '@/lib/transaction';
import { hashPassword } from '@/lib/auth';
import { deleteUserFiles, getUserFileUrls } from '@/services/upload.service';
import { deleteOwnAccount, deleteUser } from '@/services/user.service';

const USER_ID = '507f1f77bcf86cd799439011';
const ADMIN_ID = '507f1f77bcf86cd799439033';
const PHOTO = `https://res.cloudinary.com/easykonnet/image/upload/v1/easykonect/profiles/${USER_ID}_1.jpg`;

const db = prisma as unknown as Record<string, Record<string, jest.Mock>>;

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

beforeEach(() => {
  jest.resetAllMocks();
  db.user.findUnique.mockResolvedValue({
    id: USER_ID,
    email: 'ada@example.com',
    role: 'SERVICE_USER',
    status: 'ACTIVE',
    deletedAt: null,
  });
  db.serviceProvider.findUnique.mockResolvedValue(null);
  db.booking.count.mockResolvedValue(0);
  db.dispute.count.mockResolvedValue(0);
  db.withdrawal.count.mockResolvedValue(0);
  db.scheduledPayout.count.mockResolvedValue(0);
  db.wallet.findUnique.mockResolvedValue({ balance: 0, pendingBalance: 0 });
  tx.serviceProvider.findUnique.mockResolvedValue(null);
  (withTransaction as jest.Mock).mockImplementation(async (run: (client: typeof tx) => unknown) => run(tx));
  (hashPassword as jest.Mock).mockResolvedValue('unusable-hash');
  (getUserFileUrls as jest.Mock).mockResolvedValue([PHOTO]);
  (deleteUserFiles as jest.Mock).mockResolvedValue(undefined);
});

describe('account deletion and Cloudinary files', () => {
  it('notes the files before the account is anonymised and deletes them afterwards', async () => {
    await expect(deleteOwnAccount(USER_ID)).resolves.toMatchObject({ success: true });

    expect(getUserFileUrls).toHaveBeenCalledWith(USER_ID);
    expect(deleteUserFiles).toHaveBeenCalledWith(USER_ID, [PHOTO]);

    const listed = (getUserFileUrls as jest.Mock).mock.invocationCallOrder[0];
    const anonymised = tx.user.update.mock.invocationCallOrder[0];
    const deleted = (deleteUserFiles as jest.Mock).mock.invocationCallOrder[0];
    expect(listed).toBeLessThan(anonymised);
    expect(anonymised).toBeLessThan(deleted);
  });

  it('deletes the files when an admin deletes the user', async () => {
    await expect(deleteUser(USER_ID, ADMIN_ID, 'ADMIN')).resolves.toMatchObject({ success: true });

    expect(deleteUserFiles).toHaveBeenCalledWith(USER_ID, [PHOTO]);
  });

  it('keeps the files when the account could not be anonymised', async () => {
    (withTransaction as jest.Mock).mockRejectedValue(new Error('transaction aborted'));

    await expect(deleteOwnAccount(USER_ID)).rejects.toThrow('transaction aborted');

    expect(deleteUserFiles).not.toHaveBeenCalled();
  });

  it('keeps the files when deletion is refused', async () => {
    db.booking.count.mockResolvedValue(1);

    await expect(deleteOwnAccount(USER_ID)).rejects.toMatchObject({
      extensions: { code: 'HAS_ACTIVE_BOOKINGS' },
    });

    expect(getUserFileUrls).not.toHaveBeenCalled();
    expect(deleteUserFiles).not.toHaveBeenCalled();
  });
});
