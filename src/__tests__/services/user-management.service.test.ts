/**
 * Banning and restricting accounts, and the admin lists and details of users and providers
 */

jest.mock('@/lib/prisma', () => ({
  __esModule: true,
  default: {
    user: { findUnique: jest.fn(), update: jest.fn(), findMany: jest.fn(), count: jest.fn() },
    serviceProvider: { findUnique: jest.fn(), findMany: jest.fn(), count: jest.fn() },
    review: { aggregate: jest.fn() },
    payment: { aggregate: jest.fn() },
    withdrawal: { aggregate: jest.fn() },
    wallet: { findMany: jest.fn() },
    walletTransaction: { groupBy: jest.fn() },
  },
}));
jest.mock('@/lib/redis', () => ({ __esModule: true, default: { getInstance: jest.fn() } }));
jest.mock('@/services/audit.service', () => ({ createAuditLog: jest.fn() }));
jest.mock('@/services/notification.service', () => ({ createNotification: jest.fn() }));
jest.mock('@/services/push.service', () => ({ sendPushToUser: jest.fn() }));
jest.mock('@/services/wallet.service', () => ({ getEscrowedEarningsKobo: jest.fn() }));

import prisma from '@/lib/prisma';
import { createAuditLog } from '@/services/audit.service';
import { createNotification } from '@/services/notification.service';
import { sendPushToUser } from '@/services/push.service';
import { getEscrowedEarningsKobo } from '@/services/wallet.service';
import {
  banUser,
  unbanUser,
  restrictUser,
  removeRestriction,
  getAllUsers,
  getAllProviders,
  getUserDetails,
  getProviderDetails,
} from '@/services/user-management.service';

const db = prisma as unknown as Record<string, Record<string, jest.Mock>>;

const SUPER_ADMIN_ID = '66e2b4c1f0a9d83b5c7e1b01';
const ADMIN_ID = '66e2b4c1f0a9d83b5c7e1b02';
const USER_ID = '66e2b4c1f0a9d83b5c7e1b03';
const OTHER_USER_ID = '66e2b4c1f0a9d83b5c7e1b04';
const PROVIDER_ID = '66e2b4c1f0a9d83b5c7e1b05';
const WALLET_ID = '66e2b4c1f0a9d83b5c7e1b06';
const IP = '102.89.4.7';
const DAY_MS = 24 * 60 * 60 * 1000;

type Account = Record<string, unknown>;

const account = (overrides: Account = {}): Account => ({
  id: USER_ID,
  email: 'tunde.bakare@example.com',
  firstName: 'Tunde',
  lastName: 'Bakare',
  phone: null,
  profilePhoto: null,
  role: 'SERVICE_USER',
  status: 'ACTIVE',
  isEmailVerified: true,
  bannedAt: null,
  bannedUntil: null,
  banReason: null,
  restrictedAt: null,
  restrictedUntil: null,
  restrictionReason: null,
  provider: null,
  lastLoginAt: null,
  createdAt: new Date('2026-05-02T08:30:00Z'),
  updatedAt: new Date('2026-05-02T08:30:00Z'),
  ...overrides,
});

const providerRow = (id: string, userId: string) => ({
  id,
  userId,
  businessName: 'Amaka Cleaning',
  businessDescription: null,
  verificationStatus: 'VERIFIED',
  address: '1 Admiralty Way',
  city: 'Lekki',
  state: 'Lagos',
  country: 'Nigeria',
  createdAt: new Date('2026-03-14T16:05:27Z'),
  updatedAt: new Date('2026-03-14T16:05:27Z'),
  user: account({ id: userId, role: 'SERVICE_PROVIDER' }),
  _count: { services: 1, bookings: 2, reviews: 0 },
});

/** The account as a field-by-field record where some fields were never written */
const withoutFields = (record: Account, ...fields: string[]): Account => {
  const copy = { ...record };
  fields.forEach((field) => delete copy[field]);
  return copy;
};

/** update() resolves to the saved record with the new data applied */
const saveReturns = (record: Account) =>
  db.user.update.mockImplementation(async ({ data }: { data: Account }) => ({ ...record, ...data }));

type Where = Record<string, unknown>;
const MISSING = Symbol('missing');

/**
 * Evaluate a where clause the way MongoDB compares values through Prisma, taking
 * the stricter reading wherever it's ambiguous: a field that was never written is
 * neither null nor any value, and null or missing sorts before every date
 */
const matches = (record: Account, where: Where): boolean =>
  Object.entries(where).every(([key, condition]) => {
    if (key === 'AND') return (condition as Where[]).every((part) => matches(record, part));
    if (key === 'OR') return (condition as Where[]).some((part) => matches(record, part));

    const value = key in record ? record[key] : MISSING;
    if (condition === null) return value === null;
    if (typeof condition !== 'object') return value === condition;

    const filter = condition as { isSet?: boolean; not?: null; gt?: Date; lte?: Date };
    const time = value instanceof Date ? value.getTime() : -Infinity;
    if ('isSet' in filter && filter.isSet !== (value !== MISSING)) return false;
    if ('not' in filter && value === filter.not) return false;
    if (filter.gt && !(time > filter.gt.getTime())) return false;
    if (filter.lte && !(time <= filter.lte.getTime())) return false;
    return true;
  });

/** A review filter keeps reviews never removed (field null or never written) and drops removed ones */
const expectOnlyKeptReviews = (where: Where, review: Account = {}) => {
  expect(matches(review, where)).toBe(true);
  expect(matches({ ...review, deletedAt: null }, where)).toBe(true);
  expect(matches({ ...review, deletedAt: new Date() }, where)).toBe(false);
};

beforeEach(() => {
  jest.resetAllMocks();
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('banUser', () => {
  it.each([0, -3, 366, 2.5])('refuses a duration of %p days', async (days) => {
    await expect(banUser({ userId: USER_ID, reason: 'Fraud', days }, ADMIN_ID, 'ADMIN')).rejects.toMatchObject({
      message: 'Duration must be a whole number of days between 1 and 365',
      extensions: { code: 'INVALID_INPUT' },
    });
    expect(db.user.findUnique).not.toHaveBeenCalled();
  });

  it('bans for the given days, records the IP address, and returns the updated account', async () => {
    const record = account();
    db.user.findUnique.mockResolvedValue(record);
    saveReturns(record);

    const result = await banUser({ userId: USER_ID, reason: 'Repeated no-shows', days: 7 }, ADMIN_ID, 'ADMIN', IP);

    const { data, include } = db.user.update.mock.calls[0][0];
    expect((data.bannedUntil as Date).getTime() - (data.bannedAt as Date).getTime()).toBe(7 * DAY_MS);
    expect(data.tokenInvalidatedAt).toBe(data.bannedAt);
    expect(include).toEqual({ provider: true });
    expect(result).toMatchObject({
      success: true,
      message: 'User banned for 7 days',
      user: { id: USER_ID, isBanned: true, bannedReason: 'Repeated no-shows', accountStatus: 'ACTIVE' },
    });
    expect(createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'BAN_USER',
        targetId: USER_ID,
        performedBy: ADMIN_ID,
        reason: 'Repeated no-shows',
        ipAddress: IP,
        previousValue: { bannedAt: null, bannedUntil: null, banReason: null },
      })
    );
  });

  it.each([undefined, null])('bans permanently when the duration is %p', async (days) => {
    const record = account();
    db.user.findUnique.mockResolvedValue(record);
    saveReturns(record);

    const result = await banUser({ userId: USER_ID, reason: 'Scam', days }, ADMIN_ID, 'ADMIN');

    expect(db.user.update.mock.calls[0][0].data.bannedUntil).toBeNull();
    expect(result).toMatchObject({ message: 'User permanently banned', user: { isBanned: true, bannedUntil: null } });
  });

  it('treats a deleted account as not found', async () => {
    db.user.findUnique.mockResolvedValue(account({ deletedAt: new Date('2026-09-01T10:00:00.000Z') }));

    await expect(banUser({ userId: USER_ID, reason: 'Fraud', days: 7 }, ADMIN_ID, 'ADMIN')).rejects.toMatchObject({
      message: 'User not found',
      extensions: { code: 'NOT_FOUND' },
    });
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it('says "1 day" for a one-day ban', async () => {
    const record = account();
    db.user.findUnique.mockResolvedValue(record);
    saveReturns(record);

    const result = await banUser({ userId: USER_ID, reason: 'Spam', days: 1 }, ADMIN_ID, 'ADMIN');

    expect(result.message).toBe('User banned for 1 day');
    expect((createNotification as jest.Mock).mock.calls[0][0].message).toBe(
      'Your account has been banned for 1 day. Reason: Spam'
    );
  });

  it('tells the user the user-facing reason and keeps the admin note for admins', async () => {
    const record = account();
    db.user.findUnique.mockResolvedValue(record);
    saveReturns(record);

    await banUser(
      {
        userId: USER_ID,
        reason: 'Matched the chargeback ring from report #12',
        days: 30,
        userFacingReason: 'Payments were taken outside Easykonnet',
      },
      ADMIN_ID,
      'ADMIN'
    );

    const notification = (createNotification as jest.Mock).mock.calls[0][0];
    expect(notification.message).toBe('Your account has been banned for 30 days. Reason: Payments were taken outside Easykonnet');
    expect(JSON.stringify(notification)).not.toContain('chargeback ring');
    expect(JSON.stringify((sendPushToUser as jest.Mock).mock.calls[0][1])).not.toContain('chargeback ring');
    expect(db.user.update.mock.calls[0][0].data.banReason).toBe('Matched the chargeback ring from report #12');
    expect(createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'Matched the chargeback ring from report #12' })
    );
  });

  it.each([
    ['ADMIN', ADMIN_ID, 'ADMIN'],
    ['ADMIN', ADMIN_ID, 'SUPER_ADMIN'],
    ['SUPER_ADMIN', SUPER_ADMIN_ID, 'SUPER_ADMIN'],
  ])('an %s cannot ban a %s account', async (adminRole, adminId, targetRole) => {
    db.user.findUnique.mockResolvedValue(account({ role: targetRole }));

    await expect(banUser({ userId: USER_ID, reason: 'No', days: 3 }, adminId, adminRole)).rejects.toMatchObject({
      message: 'You do not have permission to ban this user',
      extensions: { code: 'FORBIDDEN' },
    });
    expect(db.user.update).not.toHaveBeenCalled();
  });
});

describe('unbanUser', () => {
  it('an ADMIN cannot lift a ban on an admin account', async () => {
    db.user.findUnique.mockResolvedValue(account({ role: 'ADMIN', bannedAt: new Date() }));

    await expect(unbanUser(USER_ID, ADMIN_ID, 'ADMIN', IP)).rejects.toMatchObject({
      message: 'You do not have permission to unban this user',
      extensions: { code: 'FORBIDDEN' },
    });
    expect(db.user.update).not.toHaveBeenCalled();
    expect(createAuditLog).not.toHaveBeenCalled();
  });

  it('checks permission before saying the account is not banned', async () => {
    db.user.findUnique.mockResolvedValue(account({ role: 'SUPER_ADMIN' }));

    await expect(unbanUser(USER_ID, ADMIN_ID, 'ADMIN')).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
  });

  it('a SUPER_ADMIN lifts the ban on an admin, with the IP address and the updated account', async () => {
    const bannedAt = new Date('2026-09-10T14:02:11Z');
    const record = account({ role: 'ADMIN', bannedAt, banReason: 'Shared their login' });
    db.user.findUnique.mockResolvedValue(record);
    saveReturns(record);

    const result = await unbanUser(USER_ID, SUPER_ADMIN_ID, 'SUPER_ADMIN', IP);

    expect(result).toMatchObject({ success: true, message: 'User unbanned successfully', user: { id: USER_ID, isBanned: false, bannedAt: null } });
    expect(createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'UNBAN_USER',
        ipAddress: IP,
        previousValue: { bannedAt, bannedUntil: null, banReason: 'Shared their login' },
      })
    );
  });
});

describe('restrictUser', () => {
  const openBookings = { where: { status: { in: ['PENDING', 'ACCEPTED', 'IN_PROGRESS'] } } };

  it.each([0, -1, 366, 1.5, undefined])('refuses a duration of %p days', async (days) => {
    await expect(
      restrictUser({ userId: USER_ID, reason: 'Chargeback', days: days as number }, ADMIN_ID, 'ADMIN')
    ).rejects.toMatchObject({
      message: 'Duration must be a whole number of days between 1 and 365',
      extensions: { code: 'INVALID_INPUT' },
    });
    expect(db.user.findUnique).not.toHaveBeenCalled();
  });

  it('treats a deleted account as not found', async () => {
    db.user.findUnique.mockResolvedValue(
      account({ deletedAt: new Date('2026-09-01T10:00:00.000Z'), _count: { bookingsAsUser: 0 } })
    );

    await expect(
      restrictUser({ userId: USER_ID, reason: 'Chargeback', days: 7 }, ADMIN_ID, 'ADMIN')
    ).rejects.toMatchObject({ message: 'User not found', extensions: { code: 'NOT_FOUND' } });
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it('a SUPER_ADMIN cannot restrict another SUPER_ADMIN', async () => {
    db.user.findUnique.mockResolvedValue(account({ role: 'SUPER_ADMIN', _count: { bookingsAsUser: 0 } }));

    await expect(
      restrictUser({ userId: USER_ID, reason: 'Review', days: 7 }, SUPER_ADMIN_ID, 'SUPER_ADMIN')
    ).rejects.toMatchObject({
      message: 'You do not have permission to restrict this user',
      extensions: { code: 'FORBIDDEN' },
    });
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it('counts open bookings as customer and as provider, and returns the updated account', async () => {
    db.user.findUnique.mockResolvedValue(
      account({ role: 'SERVICE_PROVIDER', _count: { bookingsAsUser: 1 }, provider: { _count: { bookings: 2 } } })
    );
    saveReturns(
      account({ role: 'SERVICE_PROVIDER', provider: { id: PROVIDER_ID, businessName: 'Amaka Cleaning', verificationStatus: 'VERIFIED' } })
    );

    const result = await restrictUser({ userId: USER_ID, reason: 'Chargeback under review', days: 14 }, ADMIN_ID, 'ADMIN', IP);

    expect(db.user.findUnique).toHaveBeenCalledWith({
      where: { id: USER_ID },
      include: {
        _count: { select: { bookingsAsUser: openBookings } },
        provider: { select: { _count: { select: { bookings: openBookings } } } },
      },
    });
    const { data } = db.user.update.mock.calls[0][0];
    expect((data.restrictedUntil as Date).getTime() - (data.restrictedAt as Date).getTime()).toBe(14 * DAY_MS);
    expect(result).toMatchObject({
      message: 'User restricted for 14 days',
      pendingBookingsCount: 3,
      warning: 'User has 3 pending booking(s) that will continue',
      user: { id: USER_ID, isRestricted: true, restrictionReason: 'Chargeback under review', provider: { id: PROVIDER_ID } },
    });
    expect(createAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'RESTRICT_USER', ipAddress: IP }));
  });

  it('has no warning without open bookings, and tells the user the user-facing reason', async () => {
    db.user.findUnique.mockResolvedValue(account({ _count: { bookingsAsUser: 0 }, provider: null }));
    saveReturns(account());

    const result = await restrictUser(
      { userId: USER_ID, reason: 'Admin note: linked to report #88', days: 7, userFacingReason: 'Suspicious payments' },
      ADMIN_ID,
      'ADMIN'
    );

    expect(result).toMatchObject({ pendingBookingsCount: 0, warning: null });
    const notification = (createNotification as jest.Mock).mock.calls[0][0];
    expect(notification.message).toBe(
      'Your account has been restricted for 7 days. You can still view your account but cannot make new transactions. Reason: Suspicious payments'
    );
    expect(JSON.stringify((sendPushToUser as jest.Mock).mock.calls[0][1])).not.toContain('report #88');
  });
});

describe('removeRestriction', () => {
  it('an ADMIN cannot lift a restriction on an admin account', async () => {
    db.user.findUnique.mockResolvedValue(account({ role: 'SUPER_ADMIN', restrictedAt: new Date() }));

    await expect(removeRestriction(USER_ID, ADMIN_ID, 'ADMIN')).rejects.toMatchObject({
      message: 'You do not have permission to remove this restriction',
      extensions: { code: 'FORBIDDEN' },
    });
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it('a SUPER_ADMIN can lift an older restriction on another SUPER_ADMIN', async () => {
    const record = account({ role: 'SUPER_ADMIN', restrictedAt: new Date(), restrictedUntil: new Date(Date.now() + DAY_MS) });
    db.user.findUnique.mockResolvedValue(record);
    saveReturns(record);

    const result = await removeRestriction(USER_ID, SUPER_ADMIN_ID, 'SUPER_ADMIN', IP);

    expect(result).toMatchObject({ success: true, user: { isRestricted: false, restrictedUntil: null } });
    expect(createAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'UNRESTRICT_USER', ipAddress: IP }));
  });
});

describe('managedUsers filters', () => {
  const now = Date.now();
  const past = new Date(now - 30 * DAY_MS);

  const listWhere = async (filters: Parameters<typeof getAllUsers>[0], record: Account) => {
    db.user.findMany.mockResolvedValue([{ ...record, _count: { bookingsAsUser: 0, reviews: 0 } }]);
    db.user.count.mockResolvedValue(1);
    const result = await getAllUsers(filters, { page: 1, limit: 10 });
    const args = db.user.findMany.mock.calls[db.user.findMany.mock.calls.length - 1][0];
    return { where: args.where as Where, include: args.include, item: result.items[0] };
  };

  it.each([
    ['never banned (fields never written)', withoutFields(account(), 'bannedAt', 'bannedUntil'), false],
    ['unbanned (fields cleared)', account(), false],
    ['banned permanently', account({ bannedAt: past, bannedUntil: null }), true],
    ['banned permanently, end date never written', withoutFields(account({ bannedAt: past }), 'bannedUntil'), true],
    ['banned until next week', account({ bannedAt: past, bannedUntil: new Date(now + 7 * DAY_MS) }), true],
    ['ban ended yesterday', account({ bannedAt: past, bannedUntil: new Date(now - DAY_MS) }), false],
  ])('isBanned follows the ban being in force: %s', async (_label, record, inForce) => {
    const banned = await listWhere({ isBanned: true }, record);
    const notBanned = await listWhere({ isBanned: false }, record);

    expect(matches(record, banned.where)).toBe(inForce);
    expect(matches(record, notBanned.where)).toBe(!inForce);
    expect(banned.item.isBanned).toBe(inForce);
  });

  it.each([
    ['never restricted (fields never written)', withoutFields(account(), 'restrictedAt', 'restrictedUntil'), false],
    ['restriction removed (fields cleared)', account(), false],
    ['restricted with no end date', account({ restrictedAt: past, restrictedUntil: null }), true],
    ['restricted until next week', account({ restrictedAt: past, restrictedUntil: new Date(now + 7 * DAY_MS) }), true],
    ['restriction ended yesterday', account({ restrictedAt: past, restrictedUntil: new Date(now - DAY_MS) }), false],
  ])('isRestricted follows the restriction being in force: %s', async (_label, record, inForce) => {
    const restricted = await listWhere({ isRestricted: true }, record);
    const notRestricted = await listWhere({ isRestricted: false }, record);

    expect(matches(record, restricted.where)).toBe(inForce);
    expect(matches(record, notRestricted.where)).toBe(!inForce);
    expect(restricted.item.isRestricted).toBe(inForce);
  });

  it('matches verification status, city and state on the provider profile', async () => {
    const { where } = await listWhere(
      { verificationStatus: 'VERIFIED', city: 'Lekki', state: 'Lagos', accountStatus: 'ACTIVE' },
      account()
    );

    expect(where).toMatchObject({
      status: 'ACTIVE',
      provider: {
        is: {
          verificationStatus: 'VERIFIED',
          city: { contains: 'Lekki', mode: 'insensitive' },
          state: { contains: 'Lagos', mode: 'insensitive' },
        },
      },
    });
  });

  it('finds a full Nigerian number in every form it may have been saved in', async () => {
    const { where } = await listWhere({ searchTerm: '0803 123 4567' }, account());

    expect(where.OR).toEqual(
      expect.arrayContaining([
        { phone: { contains: '0803 123 4567' } },
        { phone: { in: ['+2348031234567', '08031234567', '2348031234567'] } },
      ])
    );
  });

  it('searches phone numbers only as typed when the term is not a phone number', async () => {
    const { where } = await listWhere({ searchTerm: 'tunde' }, account());

    expect(where.OR).toHaveLength(4);
    expect(where.OR).toContainEqual({ phone: { contains: 'tunde' } });
  });

  it('leaves reviews an admin removed out of the review count', async () => {
    const { include } = await listWhere({}, account());

    expectOnlyKeptReviews(include._count.select.reviews.where);
  });
});

describe('managedProviders', () => {
  it('applies the account, date and provider profile filters', async () => {
    db.serviceProvider.findMany.mockResolvedValue([]);
    db.serviceProvider.count.mockResolvedValue(0);

    await getAllProviders(
      {
        role: 'SERVICE_PROVIDER',
        accountStatus: 'ACTIVE',
        isBanned: false,
        isRestricted: true,
        startDate: '2026-09-01T00:00:00.000Z',
        endDate: '2026-09-30T23:59:59.999Z',
        verificationStatus: 'VERIFIED',
        city: 'Lekki',
        state: 'Lagos',
      },
      { page: 2, limit: 20 }
    );

    const args = db.serviceProvider.findMany.mock.calls[0][0];
    expect(args).toMatchObject({
      skip: 20,
      take: 20,
      where: {
        verificationStatus: 'VERIFIED',
        city: { contains: 'Lekki', mode: 'insensitive' },
        state: { contains: 'Lagos', mode: 'insensitive' },
        createdAt: { gte: new Date('2026-09-01T00:00:00.000Z'), lte: new Date('2026-09-30T23:59:59.999Z') },
      },
    });
    expect(db.serviceProvider.count).toHaveBeenCalledWith({ where: args.where });

    const accountWhere = args.where.user.is as Where;
    const now = Date.now();
    const expiredBanStillRestricted = account({
      role: 'SERVICE_PROVIDER',
      bannedAt: new Date(now - 10 * DAY_MS),
      bannedUntil: new Date(now - DAY_MS),
      restrictedAt: new Date(now - DAY_MS),
      restrictedUntil: new Date(now + DAY_MS),
    });
    expect(matches(expiredBanStillRestricted, accountWhere)).toBe(true);
    expect(matches({ ...expiredBanStillRestricted, bannedUntil: null }, accountWhere)).toBe(false);
    expect(matches({ ...expiredBanStillRestricted, restrictedUntil: new Date(now - 1) }, accountWhere)).toBe(false);
    expect(matches({ ...expiredBanStillRestricted, role: 'SERVICE_USER' }, accountWhere)).toBe(false);
    expect(matches({ ...expiredBanStillRestricted, status: 'SUSPENDED' }, accountWhere)).toBe(false);
  });

  it("totalEarnings is what escrow has released to the provider's wallet, in naira", async () => {
    db.serviceProvider.findMany.mockResolvedValue([providerRow(PROVIDER_ID, USER_ID), providerRow(WALLET_ID, OTHER_USER_ID)]);
    db.serviceProvider.count.mockResolvedValue(2);
    db.review.aggregate.mockResolvedValue({ _avg: { rating: null } });
    db.wallet.findMany.mockResolvedValue([{ id: WALLET_ID, userId: USER_ID }]);
    db.walletTransaction.groupBy.mockResolvedValue([{ walletId: WALLET_ID, _sum: { amount: 1250050 } }]);

    const result = await getAllProviders({}, { page: 1, limit: 10 });

    expect(db.wallet.findMany).toHaveBeenCalledWith({
      where: { userId: { in: [USER_ID, OTHER_USER_ID] } },
      select: { id: true, userId: true },
    });
    expect(db.walletTransaction.groupBy).toHaveBeenCalledWith({
      by: ['walletId'],
      where: { walletId: { in: [WALLET_ID] }, type: 'CREDIT', source: 'SERVICE_EARNING' },
      _sum: { amount: true },
    });
    expect(result.items.map((item) => item.provider.totalEarnings)).toEqual([12500.5, 0]);
  });

  it('leaves reviews an admin removed out of the review count and the average rating', async () => {
    db.serviceProvider.findMany.mockResolvedValue([providerRow(PROVIDER_ID, USER_ID)]);
    db.serviceProvider.count.mockResolvedValue(1);
    db.review.aggregate.mockResolvedValue({ _avg: { rating: 4 } });
    db.wallet.findMany.mockResolvedValue([]);

    await getAllProviders({}, { page: 1, limit: 10 });

    expectOnlyKeptReviews(db.serviceProvider.findMany.mock.calls[0][0].include._count.select.reviews.where);
    expectOnlyKeptReviews(db.review.aggregate.mock.calls[0][0].where, { providerId: PROVIDER_ID });
    expect(matches({ providerId: OTHER_USER_ID }, db.review.aggregate.mock.calls[0][0].where)).toBe(false);
  });
});

describe('account details', () => {
  it("shows a provider's escrowed earnings as the wallet's pending balance, and leaves out removed reviews", async () => {
    db.user.findUnique.mockResolvedValue({
      ...account({ role: 'SERVICE_PROVIDER', provider: { id: PROVIDER_ID, businessName: 'Amaka Cleaning', verificationStatus: 'VERIFIED' } }),
      bookingsAsUser: [],
      reviews: [],
      wallet: { id: WALLET_ID, balance: 558000, pendingBalance: 0 },
      _count: { bookingsAsUser: 0, reviews: 0, favourites: 0 },
    });
    db.payment.aggregate.mockResolvedValue({ _sum: { amount: 0 } });
    (getEscrowedEarningsKobo as jest.Mock).mockResolvedValue(1395000);

    const result = await getUserDetails(USER_ID);

    expect(getEscrowedEarningsKobo).toHaveBeenCalledWith(USER_ID);
    expect(result.wallet).toEqual({ id: WALLET_ID, balance: 5580, pendingBalance: 13950 });
    const { include } = db.user.findUnique.mock.calls[0][0];
    expectOnlyKeptReviews(include.reviews.where);
    expectOnlyKeptReviews(include._count.select.reviews.where);
  });

  it('provider details use released earnings, the escrowed pending balance, and kept reviews only', async () => {
    db.serviceProvider.findUnique.mockResolvedValue({
      ...providerRow(PROVIDER_ID, USER_ID),
      user: { ...account({ role: 'SERVICE_PROVIDER' }), wallet: { id: WALLET_ID, balance: 558000, pendingBalance: 0, isLocked: false } },
      services: [],
      bookings: [],
      reviews: [],
      bankAccounts: [],
      _count: { services: 0, bookings: 0, reviews: 0 },
    });
    db.review.aggregate.mockResolvedValue({ _avg: { rating: 4.5 } });
    db.withdrawal.aggregate.mockResolvedValue({ _sum: { amount: 0 }, _count: 0 });
    db.wallet.findMany.mockResolvedValue([{ id: WALLET_ID, userId: USER_ID }]);
    db.walletTransaction.groupBy.mockResolvedValue([{ walletId: WALLET_ID, _sum: { amount: 2000000 } }]);
    (getEscrowedEarningsKobo as jest.Mock).mockResolvedValue(1395000);

    const result = await getProviderDetails(PROVIDER_ID);

    expect(result.wallet).toMatchObject({ balance: 5580, pendingBalance: 13950 });
    expect(result.stats).toMatchObject({ totalEarnings: 20000, averageRating: 4.5 });
    expectOnlyKeptReviews(db.review.aggregate.mock.calls[0][0].where, { providerId: PROVIDER_ID });
    const { include } = db.serviceProvider.findUnique.mock.calls[0][0];
    expectOnlyKeptReviews(include.reviews.where);
    expectOnlyKeptReviews(include._count.select.reviews.where);
  });
});
