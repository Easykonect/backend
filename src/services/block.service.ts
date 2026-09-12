/**
 * Block Service
 *
 * Lets people block someone who bothers them. Once either person has blocked
 * the other, neither can start a conversation, send a message or book the
 * other, and the blocker stops seeing the other's listings. The blocked person
 * is never told; they only see generic errors.
 */

import { GraphQLError } from 'graphql';
import prisma from '@/lib/prisma';
import { UserRole } from '@/constants';

interface PaginationParams {
  page?: number | null;
  limit?: number | null;
}

const ADMIN_ROLES: string[] = [UserRole.ADMIN, UserRole.SUPER_ADMIN];
const OBJECT_ID = /^[0-9a-f]{24}$/i;
const MAX_REASON_LENGTH = 500;

const userNotFound = () =>
  new GraphQLError('User not found', {
    extensions: { code: 'NOT_FOUND' },
  });

/**
 * Whether either user has blocked the other
 */
export const isBlockedBetween = async (userId: string, otherUserId: string): Promise<boolean> => {
  const block = await prisma.userBlock.findFirst({
    where: {
      OR: [
        { blockerId: userId, blockedId: otherUserId },
        { blockerId: otherUserId, blockedId: userId },
      ],
    },
    select: { id: true },
  });

  return Boolean(block);
};

/**
 * IDs of the users someone has blocked
 */
export const getBlockedUserIds = async (userId: string): Promise<string[]> => {
  const blocks = await prisma.userBlock.findMany({
    where: { blockerId: userId },
    select: { blockedId: true },
  });

  return blocks.map((block) => block.blockedId);
};

/**
 * Block a user. Blocking someone already blocked changes nothing.
 */
export const blockUser = async (blockerId: string, blockedId: string, reason?: string | null) => {
  if (blockerId === blockedId) {
    throw new GraphQLError("You can't block yourself", {
      extensions: { code: 'BAD_REQUEST' },
    });
  }

  if (!OBJECT_ID.test(blockedId)) throw userNotFound();

  const [target, blocker] = await Promise.all([
    prisma.user.findUnique({ where: { id: blockedId }, select: { role: true } }),
    prisma.user.findUnique({ where: { id: blockerId }, select: { role: true } }),
  ]);

  if (!target) throw userNotFound();

  // Support staff have to stay reachable
  if (ADMIN_ROLES.includes(target.role)) {
    throw new GraphQLError("Easykonnet support accounts can't be blocked", {
      extensions: { code: 'FORBIDDEN' },
    });
  }

  // Admins act through reports, restrictions and bans. A block would also cut
  // the user off from support, since support chats go to an admin.
  if (blocker && ADMIN_ROLES.includes(blocker.role)) {
    throw new GraphQLError("Admins can't block users. Restrict or ban the account instead.", {
      extensions: { code: 'FORBIDDEN' },
    });
  }

  // Loaded here rather than at the top: the security utils load the Redis
  // client, which the services that only check blocks don't otherwise need
  const { sanitizeStrict } = await import('@/utils/security');
  const safeReason = reason ? sanitizeStrict(reason.trim().slice(0, MAX_REASON_LENGTH)).trim() : '';

  await prisma.userBlock.upsert({
    where: { blockerId_blockedId: { blockerId, blockedId } },
    create: { blockerId, blockedId, reason: safeReason || undefined },
    update: {},
  });

  return { success: true, message: 'User blocked' };
};

/**
 * Unblock a user
 */
export const unblockUser = async (blockerId: string, blockedId: string) => {
  if (!OBJECT_ID.test(blockedId)) throw userNotFound();

  await prisma.userBlock.deleteMany({
    where: { blockerId, blockedId },
  });

  return { success: true, message: 'User unblocked' };
};

/**
 * The people a user has blocked, newest first. Blocks on accounts that no
 * longer exist or were deleted are left out of both the list and the total, so
 * pages stay full.
 */
export const getMyBlockedUsers = async (userId: string, pagination: PaginationParams = {}) => {
  const page = Math.max(pagination.page ?? 1, 1);
  const limit = Math.min(Math.max(pagination.limit ?? 20, 1), 100);

  const blocks = await prisma.userBlock.findMany({
    where: { blockerId: userId },
    orderBy: { createdAt: 'desc' },
    select: { id: true, blockedId: true, reason: true, createdAt: true },
  });

  const users = blocks.length > 0
    ? await prisma.user.findMany({
        where: {
          id: { in: blocks.map((block) => block.blockedId) },
          OR: [{ deletedAt: null }, { deletedAt: { isSet: false } }],
        },
        select: { id: true, firstName: true, lastName: true, profilePhoto: true },
      })
    : [];
  const usersById = new Map(users.map((user) => [user.id, user]));

  const items = blocks.flatMap((block) => {
    const user = usersById.get(block.blockedId);
    return user
      ? [{ id: block.id, user, reason: block.reason, blockedAt: block.createdAt.toISOString() }]
      : [];
  });

  const total = items.length;
  const totalPages = Math.ceil(total / limit);

  return {
    items: items.slice((page - 1) * limit, page * limit),
    total,
    page,
    totalPages,
    hasNextPage: page < totalPages,
  };
};
