/**
 * Messaging Service Tests
 *
 * Covers:
 *   - who can start a conversation: nobody across a block, providers only with
 *     customers who have a current or recent booking with them, admins only
 *     through support chat, booking chats only with the other person on the
 *     booking, and never with an account that isn't active or is banned
 *   - a conversation's first message, whether the conversation is new or
 *     already exists, is sent like any other message
 *   - without a booking only a general chat is reused
 *   - subjects are cleaned, filtered and limited
 *   - sendMessage: access, blocks, masking blocked language, flagging what the
 *     filter caught, length and attachment limits, real-time delivery, the
 *     community terms, and linking each notification to its push
 *   - the sender and other participant carry the provider's business name
 *   - archiving is per person, and a new message brings a conversation back
 *   - conversation lists leave out people the user blocked and count unread
 *     messages still visible; the unread badge leaves out blocked chats too
 *   - message lists leave out deleted messages and hidden ones sent by someone
 *     else, and mark the other person's unread messages as read, returning
 *     them as read
 *   - a conversation's preview follows its latest visible message
 *   - deleting a message tells open chats and clears its notification's text
 *   - support chats go to the admin with the fewest open support chats
 */

// ==================
// Mocks
// ==================

jest.mock('@/lib/prisma', () => ({
  __esModule: true,
  default: {
    user: { findUnique: jest.fn(), findFirst: jest.fn(), findMany: jest.fn() },
    userBlock: { findFirst: jest.fn(), findMany: jest.fn() },
    booking: { findFirst: jest.fn(), findUnique: jest.fn() },
    conversation: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    message: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    notification: { updateMany: jest.fn() },
  },
}));

jest.mock('@/config', () => ({
  config: {
    redisUrl: 'redis://localhost:6379',
    moderation: { termsVersion: '2026-09', requireTermsAcceptance: false },
    cloudinary: { cloudName: 'easykonnet' },
  },
}));

jest.mock('@/lib/redis', () => ({
  __esModule: true,
  default: { getInstance: jest.fn() },
}));

jest.mock('@/lib/socket', () => ({ emitToConversation: jest.fn() }));
jest.mock('@/services/push.service', () => ({ sendMessagePush: jest.fn() }));
jest.mock('@/services/notification.service', () => ({ createNotification: jest.fn() }));
jest.mock('@/services/report.service', () => ({ flagContent: jest.fn() }));

import prisma from '@/lib/prisma';
import { config } from '@/config';
import { emitToConversation } from '@/lib/socket';
import { sendMessagePush } from '@/services/push.service';
import { createNotification } from '@/services/notification.service';
import { flagContent } from '@/services/report.service';
import {
  archiveConversation,
  createOrGetConversation,
  deleteMessage,
  getConversationById,
  getConversationMessages,
  getMyConversations,
  getUnreadMessageCount,
  refreshConversationPreview,
  sendMessage,
  startSupportConversation,
  unarchiveConversation,
} from '@/services/messaging.service';

// ==================
// Fixtures
// ==================

const customerId = '507f1f77bcf86cd700000001';
const providerUserId = '507f1f77bcf86cd700000002';
const adminId = '507f1f77bcf86cd700000003';
const strangerId = '507f1f77bcf86cd700000004';
const secondAdminId = '507f1f77bcf86cd700000005';
const thirdAdminId = '507f1f77bcf86cd700000006';
const superAdminId = '507f1f77bcf86cd700000007';
// A conversation that already exists between the customer and the provider
const conversationId = '507f1f77bcf86cd700000010';
// The id given to a conversation created during a test
const newConversationId = '507f1f77bcf86cd700000011';
const bookingId = '507f1f77bcf86cd700000020';
const now = new Date('2026-09-12T10:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

const db = prisma as unknown as Record<string, Record<string, jest.Mock>>;
const moderation = (config as unknown as { moderation: { requireTermsAcceptance: boolean } }).moderation;

type Person = {
  role: string;
  firstName: string;
  lastName: string;
  provider?: { businessName: string } | null;
};

const people: Record<string, Person> = {
  [customerId]: { role: 'SERVICE_USER', firstName: 'Chi', lastName: 'Eze' },
  [providerUserId]: {
    role: 'SERVICE_PROVIDER',
    firstName: 'Ada',
    lastName: 'Obi',
    provider: { businessName: 'Ada Cleaning' },
  },
  [adminId]: { role: 'ADMIN', firstName: 'Tolu', lastName: 'Support' },
  [secondAdminId]: { role: 'ADMIN', firstName: 'Kemi', lastName: 'Support' },
  [thirdAdminId]: { role: 'ADMIN', firstName: 'Musa', lastName: 'Support' },
  [superAdminId]: { role: 'SUPER_ADMIN', firstName: 'Ngozi', lastName: 'Lead' },
  [strangerId]: { role: 'SERVICE_USER', firstName: 'Bola', lastName: 'Ade' },
};

type Party = 'sender' | 'recipient';
type ConversationRow = { id: string; participantIds: string[] };

// Only this direction is blocked
const blockOnly = (blockerId: string, blockedId: string) => {
  db.userBlock.findFirst.mockImplementation(
    async ({ where }: { where: { OR: { blockerId: string; blockedId: string }[] } }) =>
      where.OR.some((pair) => pair.blockerId === blockerId && pair.blockedId === blockedId)
        ? { id: 'block-1' }
        : null
  );
};

// Users as prisma returns them, optionally with some accounts changed
const personWithTerms = (
  acceptedTermsVersion: string | null,
  changes: Record<string, Record<string, unknown>> = {}
) =>
  async ({ where }: { where: { id: string } }) => {
    const person = people[where.id];
    return person
      ? {
          id: where.id,
          profilePhoto: null,
          provider: null,
          status: 'ACTIVE',
          bannedAt: null,
          bannedUntil: null,
          acceptedTermsVersion,
          ...person,
          ...changes[where.id],
        }
      : null;
  };

// Conversations created in the current test, so sendMessage sees who is in them
let created: Map<string, ConversationRow>;

beforeEach(() => {
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  moderation.requireTermsAcceptance = false;
  created = new Map();

  db.user.findUnique.mockImplementation(personWithTerms(null));
  db.user.findMany.mockResolvedValue([]);
  db.userBlock.findFirst.mockResolvedValue(null);
  db.userBlock.findMany.mockResolvedValue([]);
  db.conversation.findFirst.mockResolvedValue(null);
  db.conversation.findUnique.mockImplementation(
    async ({ where }: { where: { id: string } }) =>
      created.get(where.id) ?? { id: where.id, participantIds: [customerId, providerUserId] }
  );
  db.conversation.create.mockImplementation(async ({ data }: { data: { participantIds: string[] } }) => {
    const conversation = { id: newConversationId, ...data };
    created.set(newConversationId, conversation);
    return conversation;
  });
  db.conversation.update.mockResolvedValue({});
  db.conversation.count.mockResolvedValue(0);
  db.message.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: 'message-1',
    attachments: [],
    isDeleted: false,
    isHidden: false,
    createdAt: now,
    updatedAt: now,
    ...data,
  }));
  db.message.update.mockResolvedValue({});
  db.notification.updateMany.mockResolvedValue({ count: 1 });
  (emitToConversation as jest.Mock).mockResolvedValue(undefined);
  (createNotification as jest.Mock).mockResolvedValue({ id: 'notification-1' });
  (sendMessagePush as jest.Mock).mockResolvedValue(undefined);
  (flagContent as jest.Mock).mockResolvedValue(undefined);
});

const storedContent = () => db.message.create.mock.calls[0][0].data.content;

const latestMessageInclude = { messages: { orderBy: { createdAt: 'desc' }, take: 1 } };
const linkedPush = { notificationId: 'notification-1' };

// ==================
// createOrGetConversation
// ==================

describe('createOrGetConversation', () => {
  it.each<[Party, Party]>([
    ['sender', 'recipient'],
    ['recipient', 'sender'],
  ])(
    'refuses with CONVERSATION_NOT_ALLOWED when the %s has blocked the %s, even if they already have a conversation',
    async (blocker, blocked) => {
      const ids = { sender: customerId, recipient: providerUserId };
      blockOnly(ids[blocker], ids[blocked]);
      db.conversation.findFirst.mockResolvedValue({
        id: conversationId,
        participantIds: [customerId, providerUserId],
        messages: [],
      });

      await expect(
        createOrGetConversation(customerId, 'SERVICE_USER', {
          participantId: providerUserId,
          initialMessage: 'Hello again',
        })
      ).rejects.toMatchObject({ extensions: { code: 'CONVERSATION_NOT_ALLOWED' } });
      expect(db.conversation.create).not.toHaveBeenCalled();
      expect(db.message.create).not.toHaveBeenCalled();
    }
  );

  it('refuses a conversation with yourself with INVALID_PARTICIPANT', async () => {
    await expect(
      createOrGetConversation(customerId, 'SERVICE_USER', { participantId: customerId })
    ).rejects.toMatchObject({ extensions: { code: 'INVALID_PARTICIPANT' } });
  });

  it('refuses a pairing that is not allowed with INVALID_PARTICIPANTS', async () => {
    await expect(
      createOrGetConversation(customerId, 'SERVICE_USER', { participantId: strangerId })
    ).rejects.toMatchObject({
      message: 'Invalid conversation participants',
      extensions: { code: 'INVALID_PARTICIPANTS' },
    });
  });

  describe('provider to customer', () => {
    it('is refused when the customer has no current or recent booking with the provider', async () => {
      db.booking.findFirst.mockResolvedValue(null);

      await expect(
        createOrGetConversation(providerUserId, 'SERVICE_PROVIDER', { participantId: customerId })
      ).rejects.toMatchObject({
        message: 'You can only message customers with a current or recent booking with you',
        extensions: { code: 'CONVERSATION_NOT_ALLOWED' },
      });
      expect(db.booking.findFirst).toHaveBeenCalledWith({
        where: {
          userId: customerId,
          provider: { userId: providerUserId },
          OR: [
            { status: { notIn: ['CANCELLED', 'REJECTED'] } },
            { status: { in: ['CANCELLED', 'REJECTED'] }, updatedAt: { gte: expect.any(Date) } },
          ],
        },
        select: { id: true },
      });
      expect(db.conversation.create).not.toHaveBeenCalled();
    });

    it('counts cancelled and rejected bookings for 30 days', async () => {
      db.booking.findFirst.mockResolvedValue(null);

      await createOrGetConversation(providerUserId, 'SERVICE_PROVIDER', { participantId: customerId }).catch(
        () => undefined
      );

      const since: Date = db.booking.findFirst.mock.calls[0][0].where.OR[1].updatedAt.gte;
      expect(Math.round((Date.now() - since.getTime()) / DAY_MS)).toBe(30);
    });

    it('is allowed once the customer has a qualifying booking', async () => {
      db.booking.findFirst.mockResolvedValue({ id: bookingId });

      await createOrGetConversation(providerUserId, 'SERVICE_PROVIDER', { participantId: customerId });

      expect(db.conversation.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ type: 'USER_PROVIDER', participantIds: [providerUserId, customerId] }),
      });
    });
  });

  describe('accounts that are not active', () => {
    it.each(['SUSPENDED', 'DEACTIVATED', 'PENDING'])(
      "refuses a new conversation with a %s account, as if blocked",
      async (status) => {
        db.user.findUnique.mockImplementation(personWithTerms(null, { [providerUserId]: { status } }));

        await expect(
          createOrGetConversation(customerId, 'SERVICE_USER', { participantId: providerUserId })
        ).rejects.toMatchObject({
          message: "You can't message this user",
          extensions: { code: 'CONVERSATION_NOT_ALLOWED' },
        });
        expect(db.conversation.create).not.toHaveBeenCalled();
      }
    );

    it('refuses a new conversation with a banned account', async () => {
      db.user.findUnique.mockImplementation(
        personWithTerms(null, {
          [providerUserId]: { bannedAt: new Date(Date.now() - DAY_MS), bannedUntil: null },
        })
      );

      await expect(
        createOrGetConversation(customerId, 'SERVICE_USER', { participantId: providerUserId })
      ).rejects.toMatchObject({ extensions: { code: 'CONVERSATION_NOT_ALLOWED' } });
    });

    it('allows an account whose ban has ended', async () => {
      db.user.findUnique.mockImplementation(
        personWithTerms(null, {
          [providerUserId]: {
            bannedAt: new Date(Date.now() - 10 * DAY_MS),
            bannedUntil: new Date(Date.now() - DAY_MS),
          },
        })
      );

      await createOrGetConversation(customerId, 'SERVICE_USER', { participantId: providerUserId });

      expect(db.conversation.create).toHaveBeenCalledTimes(1);
    });

    it('refuses a new booking chat with a deactivated account', async () => {
      db.booking.findUnique.mockResolvedValue({
        id: bookingId,
        userId: customerId,
        provider: { id: 'provider-1', userId: providerUserId },
      });
      db.user.findUnique.mockImplementation(
        personWithTerms(null, { [providerUserId]: { status: 'DEACTIVATED' } })
      );

      await expect(
        createOrGetConversation(customerId, 'SERVICE_USER', { participantId: providerUserId, bookingId })
      ).rejects.toMatchObject({ extensions: { code: 'CONVERSATION_NOT_ALLOWED' } });
      expect(db.conversation.create).not.toHaveBeenCalled();
    });
  });

  describe('contacting admins', () => {
    const members: [string, string][] = [
      ['SERVICE_USER', customerId],
      ['SERVICE_PROVIDER', providerUserId],
    ];

    it.each(members)('refuses a %s messaging an admin directly', async (senderRole, senderId) => {
      await expect(
        createOrGetConversation(senderId, senderRole, { participantId: adminId })
      ).rejects.toMatchObject({ extensions: { code: 'CONVERSATION_NOT_ALLOWED' } });
      expect(db.conversation.create).not.toHaveBeenCalled();
    });

    it.each(members)('lets a %s reach an admin through startSupportConversation', async (senderRole, senderId) => {
      db.user.findMany.mockResolvedValue([{ id: adminId }]);

      await expect(
        startSupportConversation(senderId, senderRole, 'Payment issue', 'My payment has not shown up')
      ).resolves.toMatchObject({ id: newConversationId });

      expect(db.conversation.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          type: 'USER_ADMIN',
          participantIds: [senderId, adminId],
          subject: 'Payment issue',
        }),
      });
      expect(storedContent()).toBe('My payment has not shown up');
      expect(createNotification).toHaveBeenCalledWith(
        expect.objectContaining({ userId: adminId, message: 'My payment has not shown up' })
      );
    });
  });

  describe('booking conversations', () => {
    const booking = { id: bookingId, userId: customerId, provider: { id: 'provider-1', userId: providerUserId } };

    it.each([
      ['SERVICE_USER', customerId],
      ['SERVICE_PROVIDER', providerUserId],
    ])(
      'refuses with INVALID_PARTICIPANT when a %s on the booking targets someone who is not on it',
      async (senderRole, senderId) => {
        db.booking.findUnique.mockResolvedValue(booking);

        await expect(
          createOrGetConversation(senderId, senderRole, { participantId: strangerId, bookingId })
        ).rejects.toMatchObject({ extensions: { code: 'INVALID_PARTICIPANT' } });
        expect(db.conversation.create).not.toHaveBeenCalled();
      }
    );

    it('opens a booking conversation with the other person on the booking', async () => {
      db.booking.findUnique.mockResolvedValue(booking);

      await createOrGetConversation(providerUserId, 'SERVICE_PROVIDER', { participantId: customerId, bookingId });

      expect(db.conversation.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          type: 'BOOKING_RELATED',
          bookingId,
          participantIds: [providerUserId, customerId],
        }),
      });
    });
  });

  describe('which existing conversation is reused', () => {
    it('without a booking, only a general chat between the two people', async () => {
      await createOrGetConversation(customerId, 'SERVICE_USER', { participantId: providerUserId });

      expect(db.conversation.findFirst).toHaveBeenCalledWith({
        where: {
          participantIds: { hasEvery: [customerId, providerUserId] },
          isActive: true,
          OR: [{ bookingId: null }, { bookingId: { isSet: false } }],
        },
        orderBy: { lastMessageAt: 'desc' },
        include: latestMessageInclude,
      });
    });

    it("with a booking, that booking's chat", async () => {
      db.conversation.findFirst.mockResolvedValue({
        id: conversationId,
        participantIds: [customerId, providerUserId],
        bookingId,
        messages: [],
      });

      await createOrGetConversation(customerId, 'SERVICE_USER', { participantId: providerUserId, bookingId });

      expect(db.conversation.findFirst.mock.calls[0][0].where).toEqual({
        participantIds: { hasEvery: [customerId, providerUserId] },
        isActive: true,
        bookingId,
      });
    });
  });

  describe('subjects', () => {
    const start = (subject: string) =>
      createOrGetConversation(customerId, 'SERVICE_USER', { participantId: providerUserId, subject });

    it('are stored as plain text', async () => {
      await start('  <b>Deep cleaning</b> for a 3-bedroom flat & kitchen ');

      expect(db.conversation.create.mock.calls[0][0].data.subject).toBe(
        'Deep cleaning for a 3-bedroom flat & kitchen'
      );
    });

    it('are refused over 150 characters', async () => {
      await expect(start('a'.repeat(151))).rejects.toMatchObject({
        message: 'Subject can be at most 150 characters',
        extensions: { code: 'SUBJECT_TOO_LONG' },
      });
      expect(db.conversation.create).not.toHaveBeenCalled();
    });

    it('can be exactly 150 characters', async () => {
      await start('a'.repeat(150));

      expect(db.conversation.create.mock.calls[0][0].data.subject).toHaveLength(150);
    });

    it('are refused when they contain blocked language', async () => {
      await expect(start('Fix it, you wanker')).rejects.toMatchObject({
        message: "Subject contains language that isn't allowed on Easykonnet",
        extensions: { code: 'INAPPROPRIATE_CONTENT' },
      });
      expect(db.conversation.create).not.toHaveBeenCalled();
    });

    it('can include contact details, as chat can', async () => {
      await start('Call me on 08031234567');

      expect(db.conversation.create.mock.calls[0][0].data.subject).toBe('Call me on 08031234567');
    });

    it('are left out when blank', async () => {
      await start('   ');

      expect(db.conversation.create.mock.calls[0][0].data.subject).toBeUndefined();
    });
  });

  describe('an existing conversation', () => {
    const existing = { id: conversationId, participantIds: [customerId, providerUserId], messages: [] };

    beforeEach(() => {
      db.conversation.findFirst.mockResolvedValue(existing);
    });

    it('is returned as it is when there is no initial message, and nothing is sent', async () => {
      await expect(
        createOrGetConversation(customerId, 'SERVICE_USER', { participantId: providerUserId })
      ).resolves.toEqual({ ...existing, isArchived: false });

      expect(db.conversation.create).not.toHaveBeenCalled();
      expect(db.message.create).not.toHaveBeenCalled();
      expect(db.conversation.update).not.toHaveBeenCalled();
      expect(emitToConversation).not.toHaveBeenCalled();
      expect(createNotification).not.toHaveBeenCalled();
      expect(sendMessagePush).not.toHaveBeenCalled();
    });

    it('says when the caller archived it', async () => {
      db.conversation.findFirst.mockResolvedValue({ ...existing, isActive: true, archivedBy: [customerId] });

      await expect(
        createOrGetConversation(customerId, 'SERVICE_USER', { participantId: providerUserId })
      ).resolves.toMatchObject({ id: conversationId, isArchived: true });
    });

    it('delivers an initial message to it and returns it with its latest message', async () => {
      const withLatest = { ...existing, messages: [{ id: 'message-1', content: 'Are you free on Saturday?' }] };
      db.conversation.findUnique.mockImplementation(
        async ({ where, include }: { where: { id: string }; include?: unknown }) =>
          include ? withLatest : { id: where.id, participantIds: existing.participantIds }
      );

      const result = await createOrGetConversation(customerId, 'SERVICE_USER', {
        participantId: providerUserId,
        initialMessage: 'Are you free on Saturday?',
      });

      expect(result).toEqual({ ...withLatest, isArchived: false });
      expect(db.conversation.findUnique).toHaveBeenCalledWith({
        where: { id: conversationId },
        include: latestMessageInclude,
      });
      expect(db.conversation.create).not.toHaveBeenCalled();
      expect(db.message.create).toHaveBeenCalledTimes(1);
      expect(db.message.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          conversationId,
          senderId: customerId,
          content: 'Are you free on Saturday?',
        }),
      });
      expect(emitToConversation).toHaveBeenCalledWith(
        conversationId,
        'message:new',
        expect.objectContaining({ content: 'Are you free on Saturday?' })
      );
      expect(createNotification).toHaveBeenCalledWith(
        expect.objectContaining({ userId: providerUserId, message: 'Are you free on Saturday?' })
      );
      expect(sendMessagePush).toHaveBeenCalledWith(
        providerUserId,
        'Chi Eze',
        'Are you free on Saturday?',
        conversationId,
        linkedPush
      );
    });

    it('screens the initial message like any other', async () => {
      await createOrGetConversation(customerId, 'SERVICE_USER', {
        participantId: providerUserId,
        initialMessage: 'Fix it, you wanker',
      });

      expect(storedContent()).toBe('Fix it, you ******');
      expect(flagContent).toHaveBeenCalledWith(
        expect.objectContaining({
          targetType: 'MESSAGE',
          reason: 'HARASSMENT',
          snapshot: { conversationId, content: 'Fix it, you wanker' },
        })
      );
    });

    it('does not deliver the initial message when the sender has not accepted the required terms', async () => {
      moderation.requireTermsAcceptance = true;

      await expect(
        createOrGetConversation(customerId, 'SERVICE_USER', {
          participantId: providerUserId,
          initialMessage: 'Hello there',
        })
      ).rejects.toMatchObject({ extensions: { code: 'TERMS_NOT_ACCEPTED' } });
      expect(db.message.create).not.toHaveBeenCalled();
    });
  });

  describe("a new conversation's first message", () => {
    it('is masked, flagged, delivered in real time, notified with its preview and pushed', async () => {
      const original = 'Fix it properly, you wanker';
      const masked = 'Fix it properly, you ******';

      const result = await createOrGetConversation(customerId, 'SERVICE_USER', {
        participantId: providerUserId,
        initialMessage: original,
      });

      expect(result).toMatchObject({ id: newConversationId, isArchived: false });
      expect(db.conversation.findUnique).toHaveBeenLastCalledWith({
        where: { id: newConversationId },
        include: latestMessageInclude,
      });
      expect(db.message.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ conversationId: newConversationId, senderId: customerId, content: masked }),
      });
      expect(db.conversation.update).toHaveBeenCalledWith({
        where: { id: newConversationId },
        data: { lastMessageAt: expect.any(Date), lastMessageText: masked },
      });
      expect(emitToConversation).toHaveBeenCalledWith(
        newConversationId,
        'message:new',
        expect.objectContaining({ id: 'message-1', content: masked, senderName: 'Chi Eze' })
      );
      expect(createNotification).toHaveBeenCalledWith(
        expect.objectContaining({ userId: providerUserId, message: masked, entityId: newConversationId })
      );
      expect(sendMessagePush).toHaveBeenCalledWith(providerUserId, 'Chi Eze', masked, newConversationId, linkedPush);

      const delivered = [
        (emitToConversation as jest.Mock).mock.calls,
        (createNotification as jest.Mock).mock.calls,
        (sendMessagePush as jest.Mock).mock.calls,
      ];
      expect(JSON.stringify(delivered)).not.toContain('wanker');

      expect(flagContent).toHaveBeenCalledTimes(1);
      expect(flagContent).toHaveBeenCalledWith({
        targetType: 'MESSAGE',
        targetId: 'message-1',
        targetUserId: customerId,
        reason: 'HARASSMENT',
        details: expect.any(String),
        snapshot: { conversationId: newConversationId, content: original },
      });
    });

    it('flags bank details on the message for off-platform payment', async () => {
      const original = 'Send the money to my account 0123456789 instead';

      await createOrGetConversation(customerId, 'SERVICE_USER', {
        participantId: providerUserId,
        initialMessage: original,
      });

      expect(storedContent()).toBe(original);
      expect(flagContent).toHaveBeenCalledTimes(1);
      expect(flagContent).toHaveBeenCalledWith({
        targetType: 'MESSAGE',
        targetId: 'message-1',
        targetUserId: customerId,
        reason: 'OFF_PLATFORM_PAYMENT',
        details: expect.any(String),
        snapshot: { conversationId: newConversationId, content: original },
      });
    });

    it('checks the community terms before the conversation is created', async () => {
      moderation.requireTermsAcceptance = true;

      await expect(
        createOrGetConversation(customerId, 'SERVICE_USER', {
          participantId: providerUserId,
          initialMessage: 'Hello there',
        })
      ).rejects.toMatchObject({ extensions: { code: 'TERMS_NOT_ACCEPTED' } });
      expect(db.conversation.create).not.toHaveBeenCalled();
      expect(db.message.create).not.toHaveBeenCalled();
    });

    it.each<[string, string, string]>([
      ['over 5000 characters', 'a'.repeat(5001), 'MESSAGE_TOO_LONG'],
      ['only tags', '<p></p>', 'VALIDATION_ERROR'],
    ])('is refused when %s, before any conversation is looked up or created', async (_name, initialMessage, code) => {
      await expect(
        createOrGetConversation(customerId, 'SERVICE_USER', { participantId: providerUserId, initialMessage })
      ).rejects.toMatchObject({ extensions: { code } });

      expect(db.conversation.findFirst).not.toHaveBeenCalled();
      expect(db.conversation.create).not.toHaveBeenCalled();
      expect(db.message.create).not.toHaveBeenCalled();
    });

    it('is not needed: without one the conversation is created and nothing is sent', async () => {
      await expect(
        createOrGetConversation(customerId, 'SERVICE_USER', { participantId: providerUserId })
      ).resolves.toMatchObject({ id: newConversationId });

      expect(db.conversation.create).toHaveBeenCalledTimes(1);
      expect(db.message.create).not.toHaveBeenCalled();
      expect(emitToConversation).not.toHaveBeenCalled();
      expect(createNotification).not.toHaveBeenCalled();
    });
  });

  describe('a blank initial message', () => {
    const blanks = ['   ', '\n\t '];

    it.each(blanks)(
      'counts as none for a new conversation (%j): it is created without sending anything or checking the terms',
      async (initialMessage) => {
        // The terms would be refused if they were checked
        moderation.requireTermsAcceptance = true;

        await expect(
          createOrGetConversation(customerId, 'SERVICE_USER', { participantId: providerUserId, initialMessage })
        ).resolves.toMatchObject({ id: newConversationId });

        expect(db.conversation.create).toHaveBeenCalledTimes(1);
        expect(db.message.create).not.toHaveBeenCalled();
        expect(db.conversation.update).not.toHaveBeenCalled();
        expect(emitToConversation).not.toHaveBeenCalled();
        expect(createNotification).not.toHaveBeenCalled();
        expect(sendMessagePush).not.toHaveBeenCalled();
      }
    );

    it.each(blanks)(
      'counts as none for an existing conversation (%j): it is returned without sending anything or a VALIDATION_ERROR',
      async (initialMessage) => {
        const existing = { id: conversationId, participantIds: [customerId, providerUserId], messages: [] };
        db.conversation.findFirst.mockResolvedValue(existing);

        await expect(
          createOrGetConversation(customerId, 'SERVICE_USER', { participantId: providerUserId, initialMessage })
        ).resolves.toEqual({ ...existing, isArchived: false });

        expect(db.conversation.create).not.toHaveBeenCalled();
        expect(db.message.create).not.toHaveBeenCalled();
        expect(db.conversation.update).not.toHaveBeenCalled();
        expect(emitToConversation).not.toHaveBeenCalled();
        expect(createNotification).not.toHaveBeenCalled();
        expect(sendMessagePush).not.toHaveBeenCalled();
      }
    );
  });
});

// ==================
// sendMessage
// ==================

describe('sendMessage', () => {
  const send = (content: string, senderId = customerId, senderRole = 'SERVICE_USER') =>
    sendMessage(senderId, senderRole, { conversationId, content });

  it('returns NOT_FOUND to someone who is not in the conversation', async () => {
    db.conversation.findUnique.mockResolvedValue({ id: conversationId, participantIds: [providerUserId, strangerId] });

    await expect(send('Hello there')).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } });
    expect(db.message.create).not.toHaveBeenCalled();
  });

  it.each<[Party, Party]>([
    ['sender', 'recipient'],
    ['recipient', 'sender'],
  ])('refuses with CONVERSATION_NOT_ALLOWED when the %s has blocked the %s', async (blocker, blocked) => {
    const ids = { sender: customerId, recipient: providerUserId };
    blockOnly(ids[blocker], ids[blocked]);

    await expect(send('Hello there')).rejects.toMatchObject({ extensions: { code: 'CONVERSATION_NOT_ALLOWED' } });
    expect(db.message.create).not.toHaveBeenCalled();
    expect(db.conversation.update).not.toHaveBeenCalled();
    expect(emitToConversation).not.toHaveBeenCalled();
    expect(createNotification).not.toHaveBeenCalled();
    expect(sendMessagePush).not.toHaveBeenCalled();
  });

  it('masks blocked language everywhere the recipient sees it and flags the original for admins', async () => {
    const original = 'You are a bastard, fix it';
    const masked = 'You are a *******, fix it';

    const result = await send(original);

    expect(storedContent()).toBe(masked);
    expect(result.content).toBe(masked);
    expect(db.conversation.update).toHaveBeenCalledWith({
      where: { id: conversationId },
      data: { lastMessageAt: expect.any(Date), lastMessageText: masked },
    });
    expect(createNotification).toHaveBeenCalledWith(
      expect.objectContaining({ userId: providerUserId, message: masked })
    );
    expect(sendMessagePush).toHaveBeenCalledWith(providerUserId, 'Chi Eze', masked, conversationId, linkedPush);
    expect(emitToConversation).toHaveBeenCalledWith(
      conversationId,
      'message:new',
      expect.objectContaining({ content: masked })
    );

    expect(flagContent).toHaveBeenCalledTimes(1);
    expect(flagContent).toHaveBeenCalledWith({
      targetType: 'MESSAGE',
      targetId: 'message-1',
      targetUserId: customerId,
      reason: 'HARASSMENT',
      details: expect.any(String),
      snapshot: { conversationId, content: original },
    });
  });

  it('flags the message for off-platform payment when bank details are shared', async () => {
    const original = 'Pay into my account 0123456789 and skip the app';

    await send(original, providerUserId, 'SERVICE_PROVIDER');

    expect(storedContent()).toBe(original);
    expect(flagContent).toHaveBeenCalledTimes(1);
    expect(flagContent).toHaveBeenCalledWith({
      targetType: 'MESSAGE',
      targetId: 'message-1',
      targetUserId: providerUserId,
      reason: 'OFF_PLATFORM_PAYMENT',
      details: expect.any(String),
      snapshot: { conversationId, content: original },
    });
  });

  it('raises both flags on the message when it has blocked language and bank details', async () => {
    const original = 'Pay my account 0123456789 now, you bastard';

    await send(original);

    expect(storedContent()).toBe('Pay my account 0123456789 now, you *******');
    expect(flagContent).toHaveBeenCalledTimes(2);
    for (const reason of ['HARASSMENT', 'OFF_PLATFORM_PAYMENT']) {
      expect(flagContent).toHaveBeenCalledWith(
        expect.objectContaining({
          targetType: 'MESSAGE',
          targetId: 'message-1',
          reason,
          snapshot: { conversationId, content: original },
        })
      );
    }
  });

  it('does not flag an ordinary message', async () => {
    await send('Can you come at 10am tomorrow?');

    expect(storedContent()).toBe('Can you come at 10am tomorrow?');
    expect(flagContent).not.toHaveBeenCalled();
  });

  it('stores ampersands and quotes as typed', async () => {
    await send(`Bring the mop & bucket, it's "urgent"`);

    expect(storedContent()).toBe(`Bring the mop & bucket, it's "urgent"`);
  });

  it('delivers the message in real time to the conversation', async () => {
    await send('On my way now');

    expect(emitToConversation).toHaveBeenCalledTimes(1);
    expect(emitToConversation).toHaveBeenCalledWith(conversationId, 'message:new', {
      id: 'message-1',
      conversationId,
      senderId: customerId,
      senderRole: 'SERVICE_USER',
      senderName: 'Chi Eze',
      content: 'On my way now',
      attachments: [],
      status: 'SENT',
      createdAt: now,
    });
  });

  it("notes the message on its notification and links the notification to the push", async () => {
    await send('On my way now');

    expect(createNotification).toHaveBeenCalledWith({
      userId: providerUserId,
      type: 'NEW_MESSAGE',
      title: 'New Message',
      message: 'On my way now',
      entityType: 'conversation',
      entityId: conversationId,
      metadata: { messageId: 'message-1' },
    });
    expect(sendMessagePush).toHaveBeenCalledWith(providerUserId, 'Chi Eze', 'On my way now', conversationId, {
      notificationId: 'notification-1',
    });
  });

  it('still pushes, without a link, when writing the notification fails', async () => {
    (createNotification as jest.Mock).mockRejectedValue(new Error('write failed'));

    await send('On my way now');

    expect(sendMessagePush).toHaveBeenCalledWith(providerUserId, 'Chi Eze', 'On my way now', conversationId, {
      notificationId: undefined,
    });
  });

  it('still sends, notifies and pushes when the real-time emit fails', async () => {
    (emitToConversation as jest.Mock).mockRejectedValue(new Error('Redis unavailable'));

    await expect(send('On my way now')).resolves.toMatchObject({ id: 'message-1', content: 'On my way now' });
    expect(createNotification).toHaveBeenCalledWith(expect.objectContaining({ userId: providerUserId }));
    expect(sendMessagePush).toHaveBeenCalledWith(providerUserId, 'Chi Eze', 'On my way now', conversationId, linkedPush);
  });

  it('returns the sender with their business name', async () => {
    const result = await send('Your booking is confirmed', providerUserId, 'SERVICE_PROVIDER');

    expect(result.sender).toMatchObject({ id: providerUserId, firstName: 'Ada', businessName: 'Ada Cleaning' });
    expect(result.sender).not.toHaveProperty('provider');
  });

  it('refuses with TERMS_NOT_ACCEPTED when the terms are required and the sender has not accepted them', async () => {
    moderation.requireTermsAcceptance = true;

    await expect(send('Hello there')).rejects.toMatchObject({ extensions: { code: 'TERMS_NOT_ACCEPTED' } });
    expect(db.message.create).not.toHaveBeenCalled();
  });

  it('sends once the sender has accepted the current terms', async () => {
    moderation.requireTermsAcceptance = true;
    db.user.findUnique.mockImplementation(personWithTerms('2026-09'));

    await expect(send('Hello there')).resolves.toMatchObject({ id: 'message-1' });
  });

  describe('limits', () => {
    const upload = (name: string) => `https://res.cloudinary.com/easykonnet/image/upload/v1789205400/chat/${name}.jpg`;
    const sendWith = (content: string, attachments?: string[]) =>
      sendMessage(customerId, 'SERVICE_USER', { conversationId, content, attachments });

    it('refuses a message over 5000 characters, sending nothing', async () => {
      await expect(sendWith('a'.repeat(5001))).rejects.toMatchObject({
        message: 'Messages can be at most 5000 characters',
        extensions: { code: 'MESSAGE_TOO_LONG' },
      });
      expect(db.message.create).not.toHaveBeenCalled();
      expect(createNotification).not.toHaveBeenCalled();
    });

    it('counts the length after removing tags', async () => {
      await sendWith(`<b>${'a'.repeat(5000)}</b>`);

      expect(storedContent()).toHaveLength(5000);
    });

    it('refuses a message with only tags and no attachments', async () => {
      await expect(sendWith('<p></p>')).rejects.toMatchObject({
        message: 'Message content or attachments required',
        extensions: { code: 'VALIDATION_ERROR' },
      });
    });

    it('refuses more than 10 attachments', async () => {
      const attachments = Array.from({ length: 11 }, (_, i) => upload(`photo-${i}`));

      await expect(sendWith('Photos of the leak', attachments)).rejects.toMatchObject({
        message: 'A message can have at most 10 attachments',
        extensions: { code: 'TOO_MANY_ATTACHMENTS' },
      });
      expect(db.message.create).not.toHaveBeenCalled();
    });

    it.each([
      ['plain http', 'http://res.cloudinary.com/easykonnet/image/upload/v1/chat/a.jpg'],
      ['another Cloudinary account', 'https://res.cloudinary.com/another-cloud/image/upload/v1/chat/a.jpg'],
      ['another host', 'https://example.com/easykonnet/image/upload/a.jpg'],
      ['a port', 'https://res.cloudinary.com:8443/easykonnet/image/upload/a.jpg'],
      ['credentials in the URL', 'https://evil.example@res.cloudinary.com/easykonnet/image/upload/a.jpg'],
      ['something that is not a URL', 'photo.jpg'],
    ])('refuses an attachment on %s', async (_name, attachment) => {
      await expect(sendWith('See attached', [upload('ok'), attachment])).rejects.toMatchObject({
        message: 'Attachments must be files uploaded to Easykonnet',
        extensions: { code: 'INVALID_ATTACHMENT' },
      });
      expect(db.message.create).not.toHaveBeenCalled();
    });

    it("stores up to 10 files from Easykonnet's Cloudinary account, with or without text", async () => {
      const attachments = Array.from({ length: 10 }, (_, i) => upload(`photo-${i}`));

      await sendWith('', attachments);

      expect(db.message.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ content: '', attachments }),
      });
    });
  });
});

// ==================
// Archiving
// ==================

describe('archiving', () => {
  const conversationWith = (fields: Record<string, unknown>) => ({
    id: conversationId,
    participantIds: [customerId, providerUserId],
    isActive: true,
    ...fields,
  });

  it('archives the conversation for the caller only', async () => {
    db.conversation.findUnique.mockResolvedValue(conversationWith({ archivedBy: [] }));

    await expect(archiveConversation(customerId, conversationId)).resolves.toEqual({
      success: true,
      message: 'Conversation archived',
    });
    expect(db.conversation.update).toHaveBeenCalledWith({
      where: { id: conversationId },
      data: { archivedBy: { push: customerId } },
    });
  });

  it('changes nothing when the caller already archived it', async () => {
    db.conversation.findUnique.mockResolvedValue(conversationWith({ archivedBy: [customerId] }));

    await expect(archiveConversation(customerId, conversationId)).resolves.toMatchObject({ success: true });
    expect(db.conversation.update).not.toHaveBeenCalled();
  });

  it.each([
    ['archive', archiveConversation],
    ['unarchive', unarchiveConversation],
  ])('returns NOT_FOUND when someone outside the conversation tries to %s it', async (_name, action) => {
    db.conversation.findUnique.mockResolvedValue(conversationWith({}));

    await expect(action(strangerId, conversationId)).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } });
    expect(db.conversation.update).not.toHaveBeenCalled();
  });

  it('unarchives it for the caller only', async () => {
    db.conversation.findUnique.mockResolvedValue(conversationWith({ archivedBy: [customerId, providerUserId] }));

    await expect(unarchiveConversation(customerId, conversationId)).resolves.toEqual({
      success: true,
      message: 'Conversation unarchived',
    });
    expect(db.conversation.update).toHaveBeenCalledWith({
      where: { id: conversationId },
      data: { archivedBy: [providerUserId] },
    });
  });

  it("changes nothing when unarchiving a conversation the caller didn't archive", async () => {
    db.conversation.findUnique.mockResolvedValue(conversationWith({ archivedBy: [providerUserId] }));

    await unarchiveConversation(customerId, conversationId);

    expect(db.conversation.update).not.toHaveBeenCalled();
  });

  it('brings back a conversation archived for everyone, for the caller only', async () => {
    // Archived before archiving was per person: no archivedBy, isActive false
    db.conversation.findUnique.mockResolvedValue({ participantIds: [customerId, providerUserId], isActive: false });

    await unarchiveConversation(customerId, conversationId);

    expect(db.conversation.update).toHaveBeenCalledWith({
      where: { id: conversationId },
      data: { isActive: true, archivedBy: [providerUserId] },
    });
  });

  it('a new message brings the conversation back for everyone who archived it', async () => {
    db.conversation.findUnique.mockResolvedValue(conversationWith({ archivedBy: [providerUserId, customerId] }));

    await sendMessage(customerId, 'SERVICE_USER', { conversationId, content: 'Are you still available?' });

    expect(db.conversation.update).toHaveBeenCalledWith({
      where: { id: conversationId },
      data: {
        lastMessageAt: expect.any(Date),
        lastMessageText: 'Are you still available?',
        archivedBy: [],
      },
    });
  });

  it('a new message reactivates a conversation archived for everyone', async () => {
    db.conversation.findUnique.mockResolvedValue(conversationWith({ isActive: false }));

    await sendMessage(customerId, 'SERVICE_USER', { conversationId, content: 'Are you still available?' });

    expect(db.conversation.update.mock.calls[0][0].data).toMatchObject({ isActive: true, archivedBy: [] });
  });

  it('conversation(id) says whether the viewer archived it', async () => {
    db.conversation.findUnique.mockResolvedValue(conversationWith({ archivedBy: [customerId] }));

    await expect(getConversationById(customerId, conversationId)).resolves.toMatchObject({ isArchived: true });
    await expect(getConversationById(providerUserId, conversationId)).resolves.toMatchObject({ isArchived: false });
    await expect(getConversationById(strangerId, conversationId)).rejects.toMatchObject({
      extensions: { code: 'NOT_FOUND' },
    });
  });
});

// ==================
// getMyConversations
// ==================

describe('getMyConversations', () => {
  beforeEach(() => {
    db.conversation.findMany.mockResolvedValue([]);
    db.conversation.count.mockResolvedValue(0);
  });

  it('filters by the user and leaves out conversations they archived', async () => {
    await getMyConversations(customerId);

    const where = {
      participantIds: { has: customerId },
      isActive: true,
      NOT: [{ archivedBy: { has: customerId } }],
    };
    expect(db.userBlock.findMany).toHaveBeenCalledWith({
      where: { blockerId: customerId },
      select: { blockedId: true },
    });
    expect(db.conversation.findMany).toHaveBeenCalledWith(expect.objectContaining({ where }));
    expect(db.conversation.count).toHaveBeenCalledWith({ where });
  });

  it('leaves out conversations with people the user blocked, in both the list and the count', async () => {
    db.userBlock.findMany.mockResolvedValue([{ blockedId: providerUserId }, { blockedId: strangerId }]);

    await getMyConversations(customerId);

    const where = {
      participantIds: { has: customerId },
      isActive: true,
      NOT: [{ archivedBy: { has: customerId } }, { participantIds: { hasSome: [providerUserId, strangerId] } }],
    };
    expect(db.conversation.findMany).toHaveBeenCalledWith(expect.objectContaining({ where }));
    expect(db.conversation.count).toHaveBeenCalledWith({ where });
  });

  it('lists the conversations the user archived, including ones archived for everyone', async () => {
    await getMyConversations(customerId, {}, { archived: true });

    const where = {
      participantIds: { has: customerId },
      OR: [{ isActive: false }, { archivedBy: { has: customerId } }],
    };
    expect(db.conversation.findMany).toHaveBeenCalledWith(expect.objectContaining({ where }));
    expect(db.conversation.count).toHaveBeenCalledWith({ where });
  });

  it("counts the other person's unread messages that are still visible, with their business name", async () => {
    db.conversation.findMany.mockResolvedValue([
      { id: conversationId, participantIds: [customerId, providerUserId], isActive: true, archivedBy: [] },
    ]);
    db.conversation.count.mockResolvedValue(1);
    db.message.count.mockResolvedValue(2);

    const result = await getMyConversations(customerId);

    expect(db.message.count).toHaveBeenCalledWith({
      where: {
        conversationId,
        senderId: { not: customerId },
        NOT: { readBy: { has: customerId } },
        isDeleted: false,
        isHidden: { not: true },
      },
    });
    expect(result.conversations[0]).toMatchObject({
      id: conversationId,
      unreadCount: 2,
      isArchived: false,
      otherParticipant: expect.objectContaining({ id: providerUserId, businessName: 'Ada Cleaning' }),
    });
    expect(result.conversations[0].otherParticipant).not.toHaveProperty('provider');
  });

  it('gives a null business name for someone without a provider profile', async () => {
    db.conversation.findMany.mockResolvedValue([{ id: conversationId, participantIds: [providerUserId, customerId] }]);
    db.message.count.mockResolvedValue(0);

    const result = await getMyConversations(providerUserId);

    expect(result.conversations[0].otherParticipant).toMatchObject({ id: customerId, businessName: null });
  });
});

// ==================
// getConversationMessages
// ==================

describe('getConversationMessages', () => {
  const messageRow = (overrides: Record<string, unknown>) => ({
    id: 'message-x',
    conversationId,
    senderId: providerUserId,
    content: 'Hello',
    status: 'SENT',
    readBy: [providerUserId],
    readAt: null,
    isDeleted: false,
    isHidden: false,
    createdAt: now,
    ...overrides,
  });

  it('leaves out deleted messages, and hidden messages unless the viewer sent them', async () => {
    db.message.findMany.mockResolvedValue([]);
    db.message.count.mockResolvedValue(0);

    await getConversationMessages(customerId, conversationId);

    const visible = {
      conversationId,
      isDeleted: false,
      OR: [{ isHidden: { not: true } }, { senderId: customerId }],
    };
    expect(db.message.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: visible }));
    expect(db.message.count).toHaveBeenCalledWith({ where: visible });
  });

  it("marks only the other person's unread messages on the page as read", async () => {
    db.message.findMany.mockResolvedValue([
      messageRow({ id: 'unread-from-provider' }),
      messageRow({ id: 'read-from-provider', readBy: [providerUserId, customerId] }),
      messageRow({ id: 'mine', senderId: customerId, readBy: [customerId] }),
    ]);
    db.message.count.mockResolvedValue(3);

    const result = await getConversationMessages(customerId, conversationId);

    expect(db.message.update).toHaveBeenCalledTimes(1);
    expect(db.message.update).toHaveBeenCalledWith({
      where: { id: 'unread-from-provider' },
      data: { readBy: { push: customerId }, readAt: expect.any(Date), status: 'READ' },
    });
    expect(db.message.updateMany).not.toHaveBeenCalled();
    expect(result.messages).toHaveLength(3);
  });

  it('returns the messages it marked as read with their new read state', async () => {
    db.message.findMany.mockResolvedValue([
      messageRow({ id: 'unread-from-provider' }),
      messageRow({ id: 'mine', senderId: customerId, readBy: [customerId] }),
    ]);
    db.message.count.mockResolvedValue(2);

    const result = await getConversationMessages(customerId, conversationId);

    const marked = result.messages.find((msg) => msg.id === 'unread-from-provider');
    const readAt = db.message.update.mock.calls[0][0].data.readAt;
    expect(marked).toMatchObject({ status: 'READ', readBy: [providerUserId, customerId], readAt });
    expect(result.messages.find((msg) => msg.id === 'mine')).toMatchObject({ status: 'SENT', readBy: [customerId] });
  });

  it('updates nothing when every message is already read', async () => {
    db.message.findMany.mockResolvedValue([
      messageRow({ id: 'read-from-provider', readBy: [providerUserId, customerId] }),
      messageRow({ id: 'mine', senderId: customerId, readBy: [customerId] }),
    ]);
    db.message.count.mockResolvedValue(2);

    await getConversationMessages(customerId, conversationId);

    expect(db.message.update).not.toHaveBeenCalled();
    expect(db.message.updateMany).not.toHaveBeenCalled();
  });
});

// ==================
// getUnreadMessageCount
// ==================

describe('getUnreadMessageCount', () => {
  beforeEach(() => {
    db.message.count.mockResolvedValue(4);
  });

  it("counts visible unread messages from others in the user's inbox conversations", async () => {
    await expect(getUnreadMessageCount(customerId)).resolves.toEqual({ count: 4 });

    expect(db.message.count).toHaveBeenCalledWith({
      where: {
        conversation: {
          participantIds: { has: customerId },
          isActive: true,
          NOT: [{ archivedBy: { has: customerId } }],
        },
        senderId: { not: customerId },
        NOT: { readBy: { has: customerId } },
        isDeleted: false,
        isHidden: { not: true },
      },
    });
  });

  it('leaves out conversations with people the user blocked', async () => {
    db.userBlock.findMany.mockResolvedValue([{ blockedId: providerUserId }, { blockedId: strangerId }]);

    await getUnreadMessageCount(customerId);

    expect(db.userBlock.findMany).toHaveBeenCalledWith({
      where: { blockerId: customerId },
      select: { blockedId: true },
    });
    expect(db.message.count.mock.calls[0][0].where.conversation).toEqual({
      participantIds: { has: customerId },
      isActive: true,
      NOT: [{ archivedBy: { has: customerId } }, { participantIds: { hasSome: [providerUserId, strangerId] } }],
    });
  });
});

// ==================
// Conversation preview
// ==================

describe('refreshConversationPreview', () => {
  it('shows the first 100 characters of the latest message everyone can still see', async () => {
    const content = `${'a'.repeat(60)} ${'b'.repeat(60)}`;
    db.message.findFirst.mockResolvedValue({ content });

    await refreshConversationPreview(conversationId);

    expect(db.message.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { conversationId, isDeleted: false, isHidden: { not: true } },
        orderBy: { createdAt: 'desc' },
      })
    );
    expect(db.conversation.update).toHaveBeenCalledWith({
      where: { id: conversationId },
      data: { lastMessageText: `${'a'.repeat(60)} ${'b'.repeat(39)}` },
    });
  });

  it('clears the preview when no visible message is left', async () => {
    db.message.findFirst.mockResolvedValue(null);

    await refreshConversationPreview(conversationId);

    expect(db.conversation.update).toHaveBeenCalledWith({
      where: { id: conversationId },
      data: { lastMessageText: '' },
    });
  });
});

describe('deleteMessage', () => {
  const ownMessage = {
    id: 'message-1',
    conversationId,
    senderId: customerId,
    content: 'Pay into my account 0123456789',
    readBy: [customerId],
    isDeleted: false,
    isHidden: false,
    createdAt: now,
  };

  beforeEach(() => {
    db.message.findUnique.mockResolvedValue(ownMessage);
    db.message.findFirst.mockResolvedValue({ content: 'See you on Saturday' });
  });

  it("soft-deletes the sender's message, then points the preview at the latest message left", async () => {
    await expect(deleteMessage(customerId, 'message-1')).resolves.toEqual({
      success: true,
      message: 'Message deleted',
    });

    expect(db.message.update).toHaveBeenCalledWith({
      where: { id: 'message-1' },
      data: expect.objectContaining({ isDeleted: true, deletedAt: expect.any(Date) }),
    });
    expect(db.message.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { conversationId, isDeleted: false, isHidden: { not: true } } })
    );
    expect(db.conversation.update).toHaveBeenCalledWith({
      where: { id: conversationId },
      data: { lastMessageText: 'See you on Saturday' },
    });
    // Looked up after the delete is saved, so the deleted message can't be picked
    expect(db.message.update.mock.invocationCallOrder[0]).toBeLessThan(
      db.message.findFirst.mock.invocationCallOrder[0]
    );
  });

  it('tells everyone with the chat open that the message was deleted', async () => {
    await deleteMessage(customerId, 'message-1');

    expect(emitToConversation).toHaveBeenCalledWith(conversationId, 'message:deleted', {
      conversationId,
      messageId: 'message-1',
    });
  });

  it("replaces the text of the other person's unread notification for the message", async () => {
    await deleteMessage(customerId, 'message-1');

    expect(db.notification.updateMany).toHaveBeenCalledWith({
      where: {
        userId: { in: [providerUserId] },
        isRead: false,
        type: 'NEW_MESSAGE',
        entityId: conversationId,
        metadata: { contains: 'message-1' },
      },
      data: { message: 'This message was deleted' },
    });
  });

  it('still succeeds when the socket emit and the notification update fail', async () => {
    (emitToConversation as jest.Mock).mockRejectedValue(new Error('Redis unavailable'));
    db.notification.updateMany.mockRejectedValue(new Error('write failed'));

    await expect(deleteMessage(customerId, 'message-1')).resolves.toMatchObject({ success: true });
  });

  it("changes nothing for someone else's message", async () => {
    await expect(deleteMessage(providerUserId, 'message-1')).rejects.toMatchObject({
      extensions: { code: 'FORBIDDEN' },
    });

    expect(db.message.update).not.toHaveBeenCalled();
    expect(db.conversation.update).not.toHaveBeenCalled();
    expect(emitToConversation).not.toHaveBeenCalled();
    expect(db.notification.updateMany).not.toHaveBeenCalled();
  });
});

// ==================
// Support chats
// ==================

describe('startSupportConversation', () => {
  const admins = [{ id: adminId }, { id: secondAdminId }, { id: thirdAdminId }];
  const openChatsBy = (counts: Record<string, number>) =>
    db.conversation.count.mockImplementation(
      async ({ where }: { where: { participantIds: { has: string } } }) => counts[where.participantIds.has] ?? 0
    );
  const startSupport = () =>
    startSupportConversation(customerId, 'SERVICE_USER', 'Refund question', 'My refund is not in my wallet');

  beforeEach(() => {
    db.user.findMany.mockResolvedValue(admins);
  });

  it('goes to the active admin with the fewest open support chats', async () => {
    openChatsBy({ [adminId]: 3, [secondAdminId]: 1, [thirdAdminId]: 2 });

    await startSupport();

    expect(db.user.findMany).toHaveBeenCalledWith({
      where: { id: { not: customerId }, role: { in: ['ADMIN', 'SUPER_ADMIN'] }, status: 'ACTIVE' },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    expect(db.conversation.count).toHaveBeenCalledWith({
      where: {
        participantIds: { has: secondAdminId },
        type: { in: ['USER_ADMIN', 'ADMIN_SUPERADMIN'] },
        isActive: true,
      },
    });
    expect(db.conversation.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ type: 'USER_ADMIN', participantIds: [customerId, secondAdminId] }),
    });
  });

  it('goes to the earliest-created admin on a tie', async () => {
    openChatsBy({ [adminId]: 2, [secondAdminId]: 1, [thirdAdminId]: 1 });

    await startSupport();

    expect(db.conversation.create.mock.calls[0][0].data.participantIds).toEqual([customerId, secondAdminId]);
  });

  it('creates the chat with an empty archivedBy list so it appears in the inbox', async () => {
    await startSupport();

    expect(db.conversation.create.mock.calls[0][0].data.archivedBy).toEqual([]);
  });

  it("stays with the admin already in the user's open support chat", async () => {
    const supportChat = { id: conversationId, participantIds: [customerId, thirdAdminId], messages: [] };
    db.conversation.findFirst.mockImplementation(async ({ where }: { where: Record<string, unknown> }) =>
      where.type ? { participantIds: supportChat.participantIds } : supportChat
    );
    db.conversation.findUnique.mockImplementation(
      async ({ where, include }: { where: { id: string }; include?: unknown }) =>
        include ? supportChat : { id: where.id, participantIds: supportChat.participantIds }
    );

    await startSupport();

    expect(db.conversation.findFirst.mock.calls[0][0]).toEqual({
      where: {
        // one operator per list filter: Prisma rejects { has, hasSome } together
        AND: [
          { participantIds: { has: customerId } },
          { participantIds: { hasSome: [adminId, secondAdminId, thirdAdminId] } },
        ],
        type: { in: ['USER_ADMIN', 'ADMIN_SUPERADMIN'] },
        isActive: true,
        OR: [{ bookingId: null }, { bookingId: { isSet: false } }],
      },
      orderBy: { lastMessageAt: 'desc' },
      select: { participantIds: true },
    });
    expect(db.conversation.count).not.toHaveBeenCalled();
    expect(db.conversation.create).not.toHaveBeenCalled();
    expect(createNotification).toHaveBeenCalledWith(expect.objectContaining({ userId: thirdAdminId }));
  });

  it("sends an admin's support chat to a super admin", async () => {
    db.user.findMany.mockResolvedValue([{ id: superAdminId }]);

    await startSupportConversation(adminId, 'ADMIN', 'Refund approval', 'Please approve this refund');

    expect(db.user.findMany.mock.calls[0][0].where).toEqual({
      id: { not: adminId },
      role: { in: ['SUPER_ADMIN'] },
      status: 'ACTIVE',
    });
    expect(db.conversation.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ type: 'ADMIN_SUPERADMIN', participantIds: [adminId, superAdminId] }),
    });
  });

  it('refuses with NO_SUPPORT_AVAILABLE when no admin is active', async () => {
    db.user.findMany.mockResolvedValue([]);

    await expect(startSupport()).rejects.toMatchObject({
      message: 'No support staff available at the moment',
      extensions: { code: 'NO_SUPPORT_AVAILABLE' },
    });
    expect(db.conversation.create).not.toHaveBeenCalled();
  });
});
