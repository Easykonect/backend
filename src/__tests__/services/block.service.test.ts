/**
 * Block service: blocking and unblocking someone, checking whether two people
 * have blocked each other, and the list of people a user has blocked
 */

jest.mock('@/lib/prisma', () => ({
  __esModule: true,
  default: {
    user: { findUnique: jest.fn(), findMany: jest.fn() },
    userBlock: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      upsert: jest.fn(),
      deleteMany: jest.fn(),
    },
  },
}));
// The security utils import the Redis client, which reads config on load
jest.mock('@/lib/redis', () => ({ __esModule: true, default: { getInstance: jest.fn() } }));

import prisma from '@/lib/prisma';
import {
  blockUser,
  getBlockedUserIds,
  getMyBlockedUsers,
  isBlockedBetween,
  unblockUser,
} from '@/services/block.service';

const CUSTOMER_ID = '66e2b4c1f0a9d83b5c7e1b01';
const PROVIDER_USER_ID = '66e2b4c1f0a9d83b5c7e1b02';
const OTHER_USER_ID = '66e2b4c1f0a9d83b5c7e1b03';
const STAFF_USER_ID = '66e2b4c1f0a9d83b5c7e1b04';
const MISSING_USER_ID = '66e2b4c1f0a9d83b5c7e1b05';
const NEWER_BLOCK_ID = '66e2b4c1f0a9d83b5c7e1b11';
const OLDER_BLOCK_ID = '66e2b4c1f0a9d83b5c7e1b12';
const MIDDLE_BLOCK_ID = '66e2b4c1f0a9d83b5c7e1b13';

// Ids that are not 24 hex characters
const MALFORMED_IDS = [
  ['not-an-id'],
  [''],
  ['66e2b4c1f0a9d83b5c7e1b0'],
  ['66e2b4c1f0a9d83b5c7e1b0g'],
  ['66e2b4c1f0a9d83b5c7e1b021'],
  ['{"$ne":null}'],
];

const findUser = prisma.user.findUnique as jest.Mock;
const findUsers = prisma.user.findMany as jest.Mock;
const findBlock = prisma.userBlock.findFirst as jest.Mock;
const findBlocks = prisma.userBlock.findMany as jest.Mock;
const countBlocks = prisma.userBlock.count as jest.Mock;
const upsertBlock = prisma.userBlock.upsert as jest.Mock;
const deleteBlocks = prisma.userBlock.deleteMany as jest.Mock;

const code = (value: string) => ({ extensions: { code: value } });

/** Give each user id a role; any other id doesn't exist */
const withRoles = (roles: Record<string, string>) => {
  findUser.mockImplementation(async ({ where }: { where: { id: string } }) =>
    roles[where.id] ? { role: roles[where.id] } : null
  );
};

beforeEach(() => {
  jest.resetAllMocks();
});

describe('blockUser', () => {
  beforeEach(() => {
    withRoles({
      [CUSTOMER_ID]: 'SERVICE_USER',
      [PROVIDER_USER_ID]: 'SERVICE_PROVIDER',
      [OTHER_USER_ID]: 'SERVICE_USER',
    });
    upsertBlock.mockResolvedValue({ id: NEWER_BLOCK_ID });
  });

  /** The reason saved with the block */
  const savedReason = () => upsertBlock.mock.calls[0][0].create.reason;

  it("refuses to block yourself, without looking anything up", async () => {
    await expect(blockUser(CUSTOMER_ID, CUSTOMER_ID)).rejects.toMatchObject(code('BAD_REQUEST'));

    expect(findUser).not.toHaveBeenCalled();
    expect(upsertBlock).not.toHaveBeenCalled();
  });

  it.each(MALFORMED_IDS)('throws NOT_FOUND for the id %p without looking anything up', async (blockedId) => {
    await expect(blockUser(CUSTOMER_ID, blockedId, 'Spam')).rejects.toMatchObject(code('NOT_FOUND'));

    expect(findUser).not.toHaveBeenCalled();
    expect(upsertBlock).not.toHaveBeenCalled();
  });

  it('looks up both people, the one being blocked first', async () => {
    await blockUser(CUSTOMER_ID, PROVIDER_USER_ID);

    expect(findUser).toHaveBeenCalledTimes(2);
    expect(findUser).toHaveBeenNthCalledWith(1, { where: { id: PROVIDER_USER_ID }, select: { role: true } });
    expect(findUser).toHaveBeenNthCalledWith(2, { where: { id: CUSTOMER_ID }, select: { role: true } });
  });

  it('throws NOT_FOUND when the user does not exist', async () => {
    await expect(blockUser(CUSTOMER_ID, MISSING_USER_ID)).rejects.toMatchObject(code('NOT_FOUND'));

    expect(upsertBlock).not.toHaveBeenCalled();
  });

  it.each(['ADMIN', 'SUPER_ADMIN'])('refuses to block a %s, so support stays reachable', async (role) => {
    withRoles({ [CUSTOMER_ID]: 'SERVICE_USER', [STAFF_USER_ID]: role });

    await expect(blockUser(CUSTOMER_ID, STAFF_USER_ID, 'Closed my dispute')).rejects.toMatchObject({
      message: expect.stringMatching(/support/),
      ...code('FORBIDDEN'),
    });
    expect(upsertBlock).not.toHaveBeenCalled();
  });

  it.each(['ADMIN', 'SUPER_ADMIN'])('does not let a %s block a user', async (role) => {
    withRoles({ [STAFF_USER_ID]: role, [PROVIDER_USER_ID]: 'SERVICE_PROVIDER' });

    await expect(blockUser(STAFF_USER_ID, PROVIDER_USER_ID, 'Abusive in the support chat')).rejects.toMatchObject({
      message: expect.stringMatching(/Admins can't block users/),
      ...code('FORBIDDEN'),
    });
    expect(upsertBlock).not.toHaveBeenCalled();
  });

  it.each(['SERVICE_USER', 'SERVICE_PROVIDER'])('lets a %s block someone', async (role) => {
    withRoles({ [CUSTOMER_ID]: role, [OTHER_USER_ID]: 'SERVICE_USER' });

    await expect(blockUser(CUSTOMER_ID, OTHER_USER_ID)).resolves.toEqual({ success: true, message: 'User blocked' });
    expect(upsertBlock).toHaveBeenCalledTimes(1);
  });

  it.each(['SERVICE_USER', 'SERVICE_PROVIDER'])('blocks a %s', async (role) => {
    withRoles({ [CUSTOMER_ID]: 'SERVICE_USER', [OTHER_USER_ID]: role });

    await expect(blockUser(CUSTOMER_ID, OTHER_USER_ID)).resolves.toEqual({ success: true, message: 'User blocked' });
    expect(upsertBlock).toHaveBeenCalledTimes(1);
  });

  it('saves the block keyed on blocker and blocked, with the reason', async () => {
    const result = await blockUser(CUSTOMER_ID, PROVIDER_USER_ID, 'Keeps messaging me after I cancelled');

    expect(upsertBlock).toHaveBeenCalledWith({
      where: { blockerId_blockedId: { blockerId: CUSTOMER_ID, blockedId: PROVIDER_USER_ID } },
      create: { blockerId: CUSTOMER_ID, blockedId: PROVIDER_USER_ID, reason: 'Keeps messaging me after I cancelled' },
      update: {},
    });
    expect(result).toEqual({ success: true, message: 'User blocked' });
  });

  it('blocking someone twice succeeds and leaves the first block unchanged', async () => {
    await blockUser(CUSTOMER_ID, PROVIDER_USER_ID, 'First reason');
    await expect(blockUser(CUSTOMER_ID, PROVIDER_USER_ID, 'Second reason')).resolves.toEqual({
      success: true,
      message: 'User blocked',
    });

    expect(upsertBlock).toHaveBeenCalledTimes(2);
    for (const [args] of upsertBlock.mock.calls) {
      expect(args.update).toEqual({});
      expect(args.where).toEqual({ blockerId_blockedId: { blockerId: CUSTOMER_ID, blockedId: PROVIDER_USER_ID } });
    }
  });

  it('trims the reason before keeping at most 500 characters of it', async () => {
    await blockUser(CUSTOMER_ID, PROVIDER_USER_ID, `   ${'a'.repeat(600)}   `);

    expect(savedReason()).toBe('a'.repeat(500));
  });

  it('trims a short reason', async () => {
    await blockUser(CUSTOMER_ID, PROVIDER_USER_ID, '  Rude on the phone  ');

    expect(savedReason()).toBe('Rude on the phone');
  });

  describe('the reason is stored as plain text', () => {
    it('removes tags and keeps & and quotes as typed', async () => {
      await blockUser(CUSTOMER_ID, PROVIDER_USER_ID, '<b>Rude</b> & "loud" on the <i>phone</i>');

      expect(savedReason()).toBe('Rude & "loud" on the phone');
    });

    it('drops scripts along with their contents', async () => {
      await blockUser(CUSTOMER_ID, PROVIDER_USER_ID, '<script>alert(1)</script>Sent me spam');

      expect(savedReason()).toBe('Sent me spam');
    });

    it('keeps stray angle brackets escaped', async () => {
      await blockUser(CUSTOMER_ID, PROVIDER_USER_ID, 'Charged 2 < 3 times');

      expect(savedReason()).toBe('Charged 2 &lt; 3 times');
    });

    it('stores no reason when nothing is left after removing the markup', async () => {
      await blockUser(CUSTOMER_ID, PROVIDER_USER_ID, '  <script>alert(1)</script> <br> ');

      expect(savedReason()).toBeUndefined();
    });
  });

  it.each([['   '], [''], [null], [undefined]])('stores no reason when given %p', async (reason) => {
    await blockUser(CUSTOMER_ID, PROVIDER_USER_ID, reason);

    const [{ create }] = upsertBlock.mock.calls[0];
    expect(create.reason).toBeUndefined();
    expect(create).toEqual({ blockerId: CUSTOMER_ID, blockedId: PROVIDER_USER_ID });
  });
});

describe('unblockUser', () => {
  it('deletes only the block this user placed on that person', async () => {
    deleteBlocks.mockResolvedValue({ count: 1 });

    await expect(unblockUser(CUSTOMER_ID, PROVIDER_USER_ID)).resolves.toEqual({
      success: true,
      message: 'User unblocked',
    });

    expect(deleteBlocks).toHaveBeenCalledTimes(1);
    expect(deleteBlocks).toHaveBeenCalledWith({ where: { blockerId: CUSTOMER_ID, blockedId: PROVIDER_USER_ID } });
  });

  it('succeeds when there was no block', async () => {
    deleteBlocks.mockResolvedValue({ count: 0 });

    await expect(unblockUser(CUSTOMER_ID, PROVIDER_USER_ID)).resolves.toEqual({
      success: true,
      message: 'User unblocked',
    });
  });

  it.each(MALFORMED_IDS)('throws NOT_FOUND for the id %p without touching the database', async (blockedId) => {
    await expect(unblockUser(CUSTOMER_ID, blockedId)).rejects.toMatchObject(code('NOT_FOUND'));

    expect(deleteBlocks).not.toHaveBeenCalled();
  });
});

describe('isBlockedBetween', () => {
  it('checks both directions in one query', async () => {
    findBlock.mockResolvedValue(null);

    await isBlockedBetween(CUSTOMER_ID, PROVIDER_USER_ID);

    expect(findBlock).toHaveBeenCalledTimes(1);
    const [{ where, select }] = findBlock.mock.calls[0];
    expect(Object.keys(where)).toEqual(['OR']);
    expect(where.OR).toHaveLength(2);
    expect(where.OR).toEqual(
      expect.arrayContaining([
        { blockerId: CUSTOMER_ID, blockedId: PROVIDER_USER_ID },
        { blockerId: PROVIDER_USER_ID, blockedId: CUSTOMER_ID },
      ])
    );
    expect(select).toEqual({ id: true });
  });

  it('is true when either person has blocked the other', async () => {
    findBlock.mockResolvedValue({ id: NEWER_BLOCK_ID });

    await expect(isBlockedBetween(CUSTOMER_ID, PROVIDER_USER_ID)).resolves.toBe(true);
  });

  it('is false when neither has', async () => {
    findBlock.mockResolvedValue(null);

    await expect(isBlockedBetween(CUSTOMER_ID, PROVIDER_USER_ID)).resolves.toBe(false);
  });
});

describe('getBlockedUserIds', () => {
  it('lists the ids of the people the user blocked', async () => {
    findBlocks.mockResolvedValue([{ blockedId: PROVIDER_USER_ID }, { blockedId: OTHER_USER_ID }]);

    await expect(getBlockedUserIds(CUSTOMER_ID)).resolves.toEqual([PROVIDER_USER_ID, OTHER_USER_ID]);
    expect(findBlocks).toHaveBeenCalledWith({ where: { blockerId: CUSTOMER_ID }, select: { blockedId: true } });
  });

  it('is empty when the user has blocked nobody', async () => {
    findBlocks.mockResolvedValue([]);

    await expect(getBlockedUserIds(CUSTOMER_ID)).resolves.toEqual([]);
  });
});

describe('getMyBlockedUsers', () => {
  const provider = {
    id: PROVIDER_USER_ID,
    firstName: 'Chinedu',
    lastName: 'Okafor',
    profilePhoto: 'https://cdn.example.com/chinedu.jpg',
  };
  const other = { id: OTHER_USER_ID, firstName: 'Bola', lastName: 'Adeyemi', profilePhoto: null };

  const newer = {
    id: NEWER_BLOCK_ID,
    blockedId: PROVIDER_USER_ID,
    reason: 'Kept calling at night',
    createdAt: new Date('2026-09-11T20:00:00.000Z'),
  };
  const middle = {
    id: MIDDLE_BLOCK_ID,
    blockedId: MISSING_USER_ID,
    reason: null,
    createdAt: new Date('2026-09-05T12:00:00.000Z'),
  };
  const older = {
    id: OLDER_BLOCK_ID,
    blockedId: OTHER_USER_ID,
    reason: null,
    createdAt: new Date('2026-09-01T08:30:00.000Z'),
  };

  const itemFor = (block: typeof newer | typeof older, user: typeof provider | typeof other) => ({
    id: block.id,
    user,
    reason: block.reason,
    blockedAt: block.createdAt.toISOString(),
  });

  /** `count` blocks, newest first, each on an account that exists */
  const manyBlocks = (count: number) => {
    const hex = (prefix: string, i: number) => `${prefix}${i.toString(16).padStart(4, '0')}`;
    const blocks = Array.from({ length: count }, (_, i) => ({
      id: hex('66e2b4c1f0a9d83b5c7e', i),
      blockedId: hex('66e2b4c1f0a9d83b5c7f', i),
      reason: null,
      createdAt: new Date(Date.UTC(2026, 8, 1) - i * 60_000),
    }));
    findBlocks.mockResolvedValue(blocks);
    findUsers.mockResolvedValue(
      blocks.map((block, i) => ({ id: block.blockedId, firstName: `User${i}`, lastName: 'Test', profilePhoto: null }))
    );
    return blocks;
  };

  it('lists the blocked people newest first, with the reason and when they were blocked', async () => {
    findBlocks.mockResolvedValue([newer, older]);
    // Users can come back in any order
    findUsers.mockResolvedValue([other, provider]);

    const result = await getMyBlockedUsers(CUSTOMER_ID);

    expect(findBlocks).toHaveBeenCalledWith({
      where: { blockerId: CUSTOMER_ID },
      orderBy: { createdAt: 'desc' },
      select: { id: true, blockedId: true, reason: true, createdAt: true },
    });
    // Deleted accounts are left out by the query, like accounts that no longer exist
    expect(findUsers).toHaveBeenCalledWith({
      where: {
        id: { in: [PROVIDER_USER_ID, OTHER_USER_ID] },
        OR: [{ deletedAt: null }, { deletedAt: { isSet: false } }],
      },
      select: { id: true, firstName: true, lastName: true, profilePhoto: true },
    });
    expect(countBlocks).not.toHaveBeenCalled();
    expect(result).toEqual({
      items: [itemFor(newer, provider), itemFor(older, other)],
      total: 2,
      page: 1,
      totalPages: 1,
      hasNextPage: false,
    });
  });

  it('leaves blocks on accounts that no longer exist out of the list and the total', async () => {
    findBlocks.mockResolvedValue([newer, middle, older]);
    findUsers.mockResolvedValue([other, provider]);

    await expect(getMyBlockedUsers(CUSTOMER_ID)).resolves.toEqual({
      items: [itemFor(newer, provider), itemFor(older, other)],
      total: 2,
      page: 1,
      totalPages: 1,
      hasNextPage: false,
    });
  });

  it('keeps pages full when an account in between no longer exists', async () => {
    findBlocks.mockResolvedValue([newer, middle, older]);
    findUsers.mockResolvedValue([provider, other]);

    const first = await getMyBlockedUsers(CUSTOMER_ID, { page: 1, limit: 1 });
    expect(first).toEqual({ items: [itemFor(newer, provider)], total: 2, page: 1, totalPages: 2, hasNextPage: true });

    const second = await getMyBlockedUsers(CUSTOMER_ID, { page: 2, limit: 1 });
    expect(second).toEqual({ items: [itemFor(older, other)], total: 2, page: 2, totalPages: 2, hasNextPage: false });
  });

  it('is empty when the user has blocked nobody, without looking up users', async () => {
    findBlocks.mockResolvedValue([]);

    await expect(getMyBlockedUsers(CUSTOMER_ID)).resolves.toEqual({
      items: [],
      total: 0,
      page: 1,
      totalPages: 0,
      hasNextPage: false,
    });
    expect(findUsers).not.toHaveBeenCalled();
  });

  it('pages through the list', async () => {
    const blocks = manyBlocks(25);

    const result = await getMyBlockedUsers(CUSTOMER_ID, { page: 2, limit: 10 });

    expect(result.items.map((item) => item.id)).toEqual(blocks.slice(10, 20).map((block) => block.id));
    expect(result).toMatchObject({ total: 25, page: 2, totalPages: 3, hasNextPage: true });
  });

  it('has no next page on the last page', async () => {
    const blocks = manyBlocks(25);

    const result = await getMyBlockedUsers(CUSTOMER_ID, { page: 3, limit: 10 });

    expect(result.items.map((item) => item.id)).toEqual(blocks.slice(20).map((block) => block.id));
    expect(result).toMatchObject({ total: 25, page: 3, totalPages: 3, hasNextPage: false });
  });

  const clamped: Array<[{ page?: number | null; limit?: number | null }, { page: number; first: number; count: number }]> = [
    [{ page: 0, limit: 0 }, { page: 1, first: 0, count: 1 }],
    [{ page: -2, limit: -5 }, { page: 1, first: 0, count: 1 }],
    [{ page: 3, limit: 500 }, { page: 3, first: 200, count: 50 }],
    [{ page: 1, limit: 100 }, { page: 1, first: 0, count: 100 }],
    [{ page: null, limit: null }, { page: 1, first: 0, count: 20 }],
    [{}, { page: 1, first: 0, count: 20 }],
  ];

  it.each(clamped)('keeps the limit within 1..100 and the page at least 1 for %p', async (pagination, expected) => {
    const blocks = manyBlocks(250);

    const result = await getMyBlockedUsers(CUSTOMER_ID, pagination);

    expect(result.page).toBe(expected.page);
    expect(result.items).toHaveLength(expected.count);
    expect(result.items[0].id).toBe(blocks[expected.first].id);
    expect(result.total).toBe(250);
  });
});
