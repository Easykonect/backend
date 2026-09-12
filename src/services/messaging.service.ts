/**
 * Messaging Service
 * Handles conversations and messages between users
 *
 * Chat Types:
 * - USER_PROVIDER: Users chatting with Service Providers (about bookings)
 * - USER_ADMIN: Users/Providers support chat with Admins
 * - ADMIN_SUPERADMIN: Admins chatting with Super Admins
 * - BOOKING_RELATED: Chat tied to a specific booking
 *
 * Safety:
 * - Customers can message providers; providers can only message customers
 *   with a current or recent booking with them; customers and providers
 *   reach admins through support chat
 * - Nobody can message someone who blocked them, or whom they blocked, and a
 *   new conversation needs the other account to be active and not banned
 * - Blocked language is masked in the stored message, so everyone (sender
 *   included) sees the masked text, and the original is kept in a report for
 *   admins
 *
 * Archiving is per participant (archivedBy). Conversations archived before
 * that have isActive false, which counts as archived for everyone in them.
 */

import { GraphQLError } from 'graphql';
import type { $Enums, Prisma } from '@prisma/client';
import prisma from '@/lib/prisma';
import { config } from '@/config';
import { UserRole, ConversationType, MessageStatus, NotificationType } from '@/constants';
import {
  assertAcceptableText,
  containsBankDetails,
  containsBlockedTerms,
  maskBlockedTerms,
} from '@/lib/content-filter';
import { emitToConversation } from '@/lib/socket';
import { createNotification } from './notification.service';
import { sendMessagePush } from './push.service';
import { getBlockedUserIds, isBlockedBetween } from './block.service';
import { flagContent } from './report.service';
import { assertTermsAccepted } from './terms.service';
import { isBanActive, sanitizeBasic } from '@/utils/security';

// ==================
// Types
// ==================

interface CreateConversationInput {
  participantId: string;
  type?: string;
  subject?: string | null;
  bookingId?: string;
  initialMessage?: string;
}

interface SendMessageInput {
  conversationId: string;
  content: string;
  attachments?: string[];
  replyToId?: string;
}

interface PaginationParams {
  page?: number;
  limit?: number;
}

const ADMIN_ROLES: string[] = [UserRole.ADMIN, UserRole.SUPER_ADMIN];

// What a message and a conversation subject can hold, after cleaning
const MAX_MESSAGE_LENGTH = 5000;
const MAX_MESSAGE_ATTACHMENTS = 10;
const MAX_SUBJECT_LENGTH = 150;

// How long a provider can still start a chat with a customer after their
// booking was cancelled or rejected
const PROVIDER_CONTACT_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

const CLOSED_BOOKING_STATUSES: $Enums.BookingStatus[] = ['CANCELLED', 'REJECTED'];
const SUPPORT_CONVERSATION_TYPES: $Enums.ConversationType[] = ['USER_ADMIN', 'ADMIN_SUPERADMIN'];

const DELETED_MESSAGE_TEXT = 'This message was deleted';

const conversationNotAllowed = (message: string) =>
  new GraphQLError(message, { extensions: { code: 'CONVERSATION_NOT_ALLOWED' } });

const conversationNotFound = () =>
  new GraphQLError('Conversation not found or access denied', {
    extensions: { code: 'NOT_FOUND' },
  });

const inputError = (code: string, message: string) =>
  new GraphQLError(message, { extensions: { code } });

// A chat not tied to a booking. On MongoDB `null` doesn't match a field that
// was never written, so both are checked.
const withoutBooking: Prisma.ConversationWhereInput = {
  OR: [{ bookingId: null }, { bookingId: { isSet: false } }],
};

// ==================
// Helper Functions
// ==================

type Recipient = {
  role: string;
  status: string;
  bannedAt: Date | null;
  bannedUntil: Date | null;
};

/**
 * A new conversation needs the other account to be active and not banned.
 * The refusal reads like a block, so it doesn't reveal the account's state.
 */
const assertReachable = (recipient: Recipient) => {
  if (recipient.status !== 'ACTIVE' || isBanActive(recipient)) {
    throw conversationNotAllowed("You can't message this user");
  }
};

/**
 * Whether a provider can start a chat with a customer: the customer has a
 * booking with them that wasn't cancelled or rejected, or one that was
 * cancelled or rejected in the last PROVIDER_CONTACT_DAYS days
 */
const hasContactableBooking = async (providerUserId: string, customerId: string) => {
  const since = new Date(Date.now() - PROVIDER_CONTACT_DAYS * DAY_MS);

  const booking = await prisma.booking.findFirst({
    where: {
      userId: customerId,
      provider: { userId: providerUserId },
      OR: [
        { status: { notIn: CLOSED_BOOKING_STATUSES } },
        { status: { in: CLOSED_BOOKING_STATUSES }, updatedAt: { gte: since } },
      ],
    },
    select: { id: true },
  });

  return Boolean(booking);
};

/**
 * Work out the conversation type from the participants' roles, refusing
 * conversations nobody should be able to start
 */
const validateConversationType = async (
  senderId: string,
  senderRole: string,
  recipientId: string,
  options: { support?: boolean } = {}
): Promise<string> => {
  // Get recipient info
  const recipient = await prisma.user.findUnique({
    where: { id: recipientId },
    select: { role: true, status: true, bannedAt: true, bannedUntil: true },
  });

  if (!recipient) {
    throw new GraphQLError('Recipient not found', {
      extensions: { code: 'NOT_FOUND' },
    });
  }

  const recipientRole = recipient.role;
  const senderIsAdmin = ADMIN_ROLES.includes(senderRole);
  const recipientIsAdmin = ADMIN_ROLES.includes(recipientRole);
  let conversationType: string;

  if (senderRole === UserRole.SERVICE_USER && recipientRole === UserRole.SERVICE_PROVIDER) {
    // Customers can ask providers about their services
    conversationType = ConversationType.USER_PROVIDER;
  } else if (senderRole === UserRole.SERVICE_PROVIDER && recipientRole === UserRole.SERVICE_USER) {
    // Providers can only message customers with a current or recent booking
    if (!(await hasContactableBooking(senderId, recipientId))) {
      throw conversationNotAllowed(
        'You can only message customers with a current or recent booking with you'
      );
    }
    conversationType = ConversationType.USER_PROVIDER;
  } else if (recipientIsAdmin && !senderIsAdmin) {
    // Customers and providers reach admins through support chat
    if (!options.support) {
      throw conversationNotAllowed('Please use support chat to contact Easykonnet');
    }
    conversationType = ConversationType.USER_ADMIN;
  } else if (
    senderIsAdmin &&
    (recipientRole === UserRole.SERVICE_USER || recipientRole === UserRole.SERVICE_PROVIDER)
  ) {
    conversationType = ConversationType.USER_ADMIN;
  } else if (
    (senderRole === UserRole.ADMIN && recipientRole === UserRole.SUPER_ADMIN) ||
    (senderRole === UserRole.SUPER_ADMIN && recipientRole === UserRole.ADMIN)
  ) {
    conversationType = ConversationType.ADMIN_SUPERADMIN;
  } else {
    // INVALID_PARTICIPANTS (a pairing that isn't allowed) is kept apart from
    // INVALID_PARTICIPANT (yourself, or not the other party on a booking):
    // apps may already handle either code
    throw new GraphQLError('Invalid conversation participants', {
      extensions: { code: 'INVALID_PARTICIPANTS' },
    });
  }

  assertReachable(recipient);

  return conversationType;
};

/**
 * Check if user can access a conversation
 */
const canAccessConversation = async (
  userId: string,
  conversationId: string
): Promise<boolean> => {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { participantIds: true },
  });

  if (!conversation) return false;
  return conversation.participantIds.includes(userId);
};

/**
 * Get user display info for messages
 */
const getUserDisplayInfo = async (userId: string) => {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      profilePhoto: true,
      role: true,
      provider: {
        select: { businessName: true },
      },
    },
  });

  if (!user) return null;

  // ConversationParticipant and MessageSender have businessName at the top level
  const { provider, ...person } = user;
  return { ...person, businessName: provider?.businessName ?? null };
};

type ArchivableConversation = { isActive?: boolean | null; archivedBy?: string[] | null };

const archivedByOf = (conversation: ArchivableConversation): string[] =>
  conversation.archivedBy ?? [];

/**
 * Whether a conversation is archived for this user
 */
const isArchivedFor = (conversation: ArchivableConversation, userId: string) =>
  conversation.isActive === false || archivedByOf(conversation).includes(userId);

/**
 * A conversation as this user sees it
 */
const forViewer = <T extends ArchivableConversation>(conversation: T, userId: string) => ({
  ...conversation,
  isArchived: isArchivedFor(conversation, userId),
});

/**
 * A new message brings the conversation back into everyone's inbox
 */
const unarchivedByNewMessage = (
  conversation: ArchivableConversation
): Prisma.ConversationUpdateInput => {
  if (conversation.isActive === false) return { isActive: true, archivedBy: [] };
  return archivedByOf(conversation).length > 0 ? { archivedBy: [] } : {};
};

/**
 * A conversation with its most recent message
 */
const findConversationWithLatestMessage = (conversationId: string) =>
  prisma.conversation.findUnique({
    where: { id: conversationId },
    include: {
      messages: {
        orderBy: { createdAt: 'desc' },
        take: 1,
      },
    },
  });

const findConversationForViewer = async (conversationId: string, userId: string) => {
  const conversation = await findConversationWithLatestMessage(conversationId);
  return conversation ? forViewer(conversation, userId) : null;
};

/**
 * A conversation the user is in, with what archiving needs
 */
const findParticipantConversation = async (userId: string, conversationId: string) => {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { participantIds: true, isActive: true, archivedBy: true },
  });

  if (!conversation || !conversation.participantIds.includes(userId)) {
    throw conversationNotFound();
  }

  return conversation;
};

/**
 * A conversation subject as plain text, refused when too long or when it has
 * blocked language. Contact details are allowed, as in chat.
 */
const cleanSubject = (subject?: string | null): string | undefined => {
  if (typeof subject !== 'string') return undefined;

  const cleaned = sanitizeBasic(subject);
  if (!cleaned) return undefined;

  if (cleaned.length > MAX_SUBJECT_LENGTH) {
    throw inputError('SUBJECT_TOO_LONG', `Subject can be at most ${MAX_SUBJECT_LENGTH} characters`);
  }

  assertAcceptableText(cleaned, 'Subject', { allowContactDetails: true });

  return cleaned;
};

/**
 * Whether an attachment is a file uploaded to Easykonnet's Cloudinary account
 */
const isOwnUploadUrl = (value: unknown): boolean => {
  const { cloudName } = config.cloudinary;
  if (!cloudName || typeof value !== 'string') return false;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }

  return (
    url.protocol === 'https:' &&
    url.hostname === 'res.cloudinary.com' &&
    !url.port &&
    !url.username &&
    !url.password &&
    url.pathname.startsWith(`/${cloudName}/`)
  );
};

/**
 * Check a message's cleaned text and its attachments
 */
const validateMessage = (content: string, attachments: string[]) => {
  if (!content && attachments.length === 0) {
    throw inputError('VALIDATION_ERROR', 'Message content or attachments required');
  }

  if (content.length > MAX_MESSAGE_LENGTH) {
    throw inputError('MESSAGE_TOO_LONG', `Messages can be at most ${MAX_MESSAGE_LENGTH} characters`);
  }

  if (attachments.length > MAX_MESSAGE_ATTACHMENTS) {
    throw inputError(
      'TOO_MANY_ATTACHMENTS',
      `A message can have at most ${MAX_MESSAGE_ATTACHMENTS} attachments`
    );
  }

  if (!attachments.every(isOwnUploadUrl)) {
    throw inputError('INVALID_ATTACHMENT', 'Attachments must be files uploaded to Easykonnet');
  }
};

/**
 * Mask blocked language in a message, noting what the filter caught
 */
const screenMessage = (text: string) => ({
  content: maskBlockedTerms(text),
  hasBlockedTerms: containsBlockedTerms(text),
  hasBankDetails: containsBankDetails(text),
});

/**
 * Report what the filter caught to admins, with the original text
 */
const flagScreenedMessage = async (
  screened: ReturnType<typeof screenMessage>,
  original: string,
  message: { id: string; senderId: string; conversationId: string }
) => {
  if (screened.hasBlockedTerms) {
    await flagContent({
      targetType: 'MESSAGE',
      targetId: message.id,
      targetUserId: message.senderId,
      reason: 'HARASSMENT',
      details: 'Automatic: blocked language, masked in the message',
      snapshot: { conversationId: message.conversationId, content: original },
    });
  }

  // Flagged on the message, so an admin can remove it and still see the conversation
  if (screened.hasBankDetails) {
    await flagContent({
      targetType: 'MESSAGE',
      targetId: message.id,
      targetUserId: message.senderId,
      reason: 'OFF_PLATFORM_PAYMENT',
      details: 'Automatic: bank details shared in chat',
      snapshot: { conversationId: message.conversationId, content: original },
    });
  }
};

/**
 * Pick the admin who answers a support chat: the one already in this user's
 * open support chat, otherwise the active admin with the fewest open support
 * chats, the earliest-created account on a tie. Admins reach super admins and
 * super admins reach admins.
 */
const findSupportAdmin = async (userId: string, userRole: string): Promise<string | null> => {
  const roles =
    userRole === UserRole.ADMIN
      ? [UserRole.SUPER_ADMIN]
      : userRole === UserRole.SUPER_ADMIN
        ? [UserRole.ADMIN]
        : ADMIN_ROLES;

  const admins = await prisma.user.findMany({
    where: {
      id: { not: userId },
      role: { in: roles as $Enums.UserRole[] },
      status: 'ACTIVE',
    },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });

  if (admins.length === 0) return null;
  const adminIds = admins.map((admin) => admin.id);

  const current = await prisma.conversation.findFirst({
    where: {
      participantIds: { has: userId, hasSome: adminIds },
      type: { in: SUPPORT_CONVERSATION_TYPES },
      isActive: true,
      ...withoutBooking,
    },
    orderBy: { lastMessageAt: 'desc' },
    select: { participantIds: true },
  });

  const currentAdminId = current?.participantIds.find(
    (id) => id !== userId && adminIds.includes(id)
  );
  if (currentAdminId) return currentAdminId;

  const openChats = await Promise.all(
    adminIds.map((adminId) =>
      prisma.conversation.count({
        where: {
          participantIds: { has: adminId },
          type: { in: SUPPORT_CONVERSATION_TYPES },
          isActive: true,
        },
      })
    )
  );

  // Admins are in creation order, so only a strictly smaller count moves on
  let chosen = 0;
  openChats.forEach((count, index) => {
    if (count < openChats[chosen]) chosen = index;
  });

  return adminIds[chosen];
};

// ==================
// Conversation Functions
// ==================

/**
 * Create or get existing conversation between two users
 */
export const createOrGetConversation = async (
  senderId: string,
  senderRole: string,
  input: CreateConversationInput,
  options: { support?: boolean } = {}
) => {
  const { participantId, bookingId } = input;
  // A blank first message counts as no message
  const initialMessage = input.initialMessage?.trim() ? input.initialMessage : undefined;

  // Validate sender is not trying to chat with themselves
  if (senderId === participantId) {
    throw new GraphQLError('Cannot create conversation with yourself', {
      extensions: { code: 'INVALID_PARTICIPANT' },
    });
  }

  const subject = cleanSubject(input.subject);

  // Checked before anything is created, so a refused first message leaves no empty conversation
  if (initialMessage) {
    validateMessage(sanitizeBasic(initialMessage), []);
  }

  // Nobody can reach someone who blocked them, or whom they blocked
  if (await isBlockedBetween(senderId, participantId)) {
    throw conversationNotAllowed("You can't message this user");
  }

  // An existing conversation between these users: the chat for this booking,
  // or without a booking, their general chat
  const existingConversation = await prisma.conversation.findFirst({
    where: {
      participantIds: {
        hasEvery: [senderId, participantId],
      },
      isActive: true,
      ...(bookingId ? { bookingId } : withoutBooking),
    },
    orderBy: { lastMessageAt: 'desc' },
    include: {
      messages: {
        orderBy: { createdAt: 'desc' },
        take: 1,
      },
    },
  });

  if (existingConversation) {
    if (!initialMessage) return forViewer(existingConversation, senderId);

    // Starting a conversation that already exists still delivers the message
    await sendMessage(senderId, senderRole, {
      conversationId: existingConversation.id,
      content: initialMessage,
    });

    return findConversationForViewer(existingConversation.id, senderId);
  }

  // Determine conversation type
  let conversationType: string;
  if (bookingId) {
    conversationType = ConversationType.BOOKING_RELATED;

    // Verify booking exists and user is involved
    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
      include: { provider: true },
    });

    if (!booking) {
      throw new GraphQLError('Booking not found', {
        extensions: { code: 'NOT_FOUND' },
      });
    }

    // Ensure sender is part of this booking
    if (booking.userId !== senderId && booking.provider.userId !== senderId) {
      throw new GraphQLError('You are not part of this booking', {
        extensions: { code: 'FORBIDDEN' },
      });
    }

    // ...and that they're messaging the other person on it
    const otherParty = booking.userId === senderId ? booking.provider.userId : booking.userId;
    if (participantId !== otherParty) {
      throw new GraphQLError('You can only message the other person on this booking', {
        extensions: { code: 'INVALID_PARTICIPANT' },
      });
    }

    const recipient = await prisma.user.findUnique({
      where: { id: participantId },
      select: { role: true, status: true, bannedAt: true, bannedUntil: true },
    });

    if (!recipient) {
      throw new GraphQLError('Recipient not found', {
        extensions: { code: 'NOT_FOUND' },
      });
    }

    assertReachable(recipient);
  } else {
    conversationType = await validateConversationType(senderId, senderRole, participantId, options);
  }

  if (initialMessage) {
    await assertTermsAccepted(senderId);
  }

  // Create new conversation
  const conversation = await prisma.conversation.create({
    data: {
      type: conversationType as $Enums.ConversationType,
      participantIds: [senderId, participantId],
      bookingId,
      subject,
      isActive: true,
    },
  });

  // The first message goes through sendMessage, like every other message
  if (initialMessage) {
    await sendMessage(senderId, senderRole, {
      conversationId: conversation.id,
      content: initialMessage,
    });
  }

  return findConversationForViewer(conversation.id, senderId);
};

/**
 * Get conversation by ID
 */
export const getConversationById = async (userId: string, conversationId: string) => {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
  });

  if (!conversation || !conversation.participantIds.includes(userId)) {
    throw conversationNotFound();
  }

  return forViewer(conversation, userId);
};

/**
 * Get user's conversations: their inbox, or with `archived` the conversations
 * they archived. Conversations with people the user blocked are left out.
 */
export const getMyConversations = async (
  userId: string,
  pagination: PaginationParams = {},
  options: { archived?: boolean } = {}
) => {
  const { page = 1, limit = 20 } = pagination;
  const skip = (page - 1) * limit;

  const blockedIds = await getBlockedUserIds(userId);
  const withBlocked: Prisma.ConversationWhereInput[] =
    blockedIds.length > 0 ? [{ participantIds: { hasSome: blockedIds } }] : [];

  const where: Prisma.ConversationWhereInput = options.archived
    ? {
        participantIds: { has: userId },
        OR: [{ isActive: false }, { archivedBy: { has: userId } }],
        ...(withBlocked.length > 0 ? { NOT: withBlocked } : {}),
      }
    : {
        participantIds: { has: userId },
        isActive: true,
        NOT: [{ archivedBy: { has: userId } }, ...withBlocked],
      };

  const [conversations, total] = await Promise.all([
    prisma.conversation.findMany({
      where,
      orderBy: { lastMessageAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.conversation.count({ where }),
  ]);

  // Enrich with participant info and unread count
  const enrichedConversations = await Promise.all(
    conversations.map(async (conv) => {
      const otherParticipantId = conv.participantIds.find((id) => id !== userId);
      const otherParticipant = otherParticipantId
        ? await getUserDisplayInfo(otherParticipantId)
        : null;

      // Every message starts with its sender in readBy, so unread means this user isn't in it
      const unreadCount = await prisma.message.count({
        where: {
          conversationId: conv.id,
          senderId: { not: userId },
          NOT: { readBy: { has: userId } },
          isDeleted: false,
          isHidden: { not: true },
        },
      });

      return {
        ...forViewer(conv, userId),
        otherParticipant,
        unreadCount,
      };
    })
  );

  const totalPages = Math.ceil(total / limit);

  return {
    conversations: enrichedConversations,
    total,
    page,
    limit,
    totalPages,
    hasNextPage: page < totalPages,
    hasPreviousPage: page > 1,
  };
};

/**
 * Archive a conversation for this user only. It leaves their inbox and unread
 * count until they unarchive it or a new message is sent in it.
 */
export const archiveConversation = async (userId: string, conversationId: string) => {
  const conversation = await findParticipantConversation(userId, conversationId);

  if (!isArchivedFor(conversation, userId)) {
    await prisma.conversation.update({
      where: { id: conversationId },
      data: { archivedBy: { push: userId } },
    });
  }

  return { success: true, message: 'Conversation archived' };
};

/**
 * Bring an archived conversation back into this user's inbox
 */
export const unarchiveConversation = async (userId: string, conversationId: string) => {
  const conversation = await findParticipantConversation(userId, conversationId);
  const archivedBy = archivedByOf(conversation);

  if (conversation.isActive === false) {
    // Archived for everyone before archiving was per person: it comes back
    // for this user and stays archived for the others
    await prisma.conversation.update({
      where: { id: conversationId },
      data: {
        isActive: true,
        archivedBy: conversation.participantIds.filter((id) => id !== userId),
      },
    });
  } else if (archivedBy.includes(userId)) {
    await prisma.conversation.update({
      where: { id: conversationId },
      data: { archivedBy: archivedBy.filter((id) => id !== userId) },
    });
  }

  return { success: true, message: 'Conversation unarchived' };
};

// ==================
// Message Functions
// ==================

/**
 * Send a message. Used by both the sendMessage mutation and the socket
 * handler, so the same checks apply to both.
 */
export const sendMessage = async (
  senderId: string,
  senderRole: string,
  input: SendMessageInput
) => {
  const { conversationId, replyToId } = input;
  const attachments = input.attachments ?? [];

  // Validate conversation access
  const conversationRecord = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { participantIds: true, isActive: true, archivedBy: true },
  });

  if (!conversationRecord || !conversationRecord.participantIds.includes(senderId)) {
    throw conversationNotFound();
  }

  const otherParticipantIds = conversationRecord.participantIds.filter((id) => id !== senderId);

  // Messages can't reach someone who blocked the sender, or whom the sender blocked
  for (const recipientId of otherParticipantIds) {
    if (await isBlockedBetween(senderId, recipientId)) {
      throw conversationNotAllowed("You can't send messages in this conversation");
    }
  }

  // Checked as plain text: tags don't count towards the length and can't make up a message
  const original = sanitizeBasic(typeof input.content === 'string' ? input.content : '');
  validateMessage(original, attachments);

  await assertTermsAccepted(senderId);

  // If replying, validate reply exists
  if (replyToId) {
    const replyTo = await prisma.message.findUnique({
      where: { id: replyToId },
    });
    if (!replyTo || replyTo.conversationId !== conversationId) {
      throw new GraphQLError('Invalid reply reference', {
        extensions: { code: 'INVALID_REPLY' },
      });
    }
  }

  // Create message, masked for everyone who sees it
  const screened = screenMessage(original);

  const message = await prisma.message.create({
    data: {
      conversationId,
      senderId,
      senderRole: senderRole as $Enums.UserRole,
      content: screened.content,
      attachments,
      status: MessageStatus.SENT,
      readBy: [senderId],
      replyToId,
    },
  });

  // Update conversation with last message info, back in the inbox of anyone who archived it
  await prisma.conversation.update({
    where: { id: conversationId },
    data: {
      lastMessageAt: new Date(),
      lastMessageText: screened.content.substring(0, 100),
      ...unarchivedByNewMessage(conversationRecord),
    },
  });

  await flagScreenedMessage(screened, original, message);

  // Enrich message with sender info — fetched up front so the push
  // notification can show "New message from <name>".
  const sender = await getUserDisplayInfo(senderId);
  const senderDisplay =
    [sender?.firstName, sender?.lastName].filter(Boolean).join(' ').trim() || 'Someone';
  const messagePreview = screened.content.substring(0, 100);

  // Deliver in real time to anyone with the conversation open
  try {
    await emitToConversation(conversationId, 'message:new', {
      id: message.id,
      conversationId: message.conversationId,
      senderId: message.senderId,
      senderRole: message.senderRole,
      senderName: senderDisplay,
      content: message.content,
      attachments: message.attachments,
      status: message.status,
      createdAt: message.createdAt,
    });
  } catch (err) {
    console.error('Failed to emit message', err);
  }

  // Send notification to other participants
  for (const recipientId of otherParticipantIds) {
    let notificationId: string | undefined;

    try {
      const notification = await createNotification({
        userId: recipientId,
        type: NotificationType.NEW_MESSAGE,
        title: 'New Message',
        message: messagePreview,
        entityType: 'conversation',
        entityId: conversationId,
        // Lets deleteMessage find the notification for this message
        metadata: { messageId: message.id },
      });
      notificationId = notification.id;
    } catch (err) {
      console.error('Failed to write message notification', err);
    }

    try {
      await sendMessagePush(recipientId, senderDisplay, messagePreview, conversationId, {
        notificationId,
      });
    } catch (err) {
      console.error('Failed to send message push', err);
    }
  }

  return {
    ...message,
    sender,
  };
};

/**
 * Get messages in a conversation. Messages hidden pending moderation are only
 * shown to the person who sent them.
 */
export const getConversationMessages = async (
  userId: string,
  conversationId: string,
  pagination: PaginationParams = {}
) => {
  const { page = 1, limit = 50 } = pagination;
  const skip = (page - 1) * limit;

  // Validate access
  const canAccess = await canAccessConversation(userId, conversationId);
  if (!canAccess) {
    throw conversationNotFound();
  }

  const visible: Prisma.MessageWhereInput = {
    conversationId,
    isDeleted: false,
    OR: [{ isHidden: { not: true } }, { senderId: userId }],
  };

  const [messages, total] = await Promise.all([
    prisma.message.findMany({
      where: visible,
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.message.count({ where: visible }),
  ]);

  // Opening the conversation reads the other person's messages on this page
  const unreadIds = new Set(
    messages
      .filter((msg) => msg.senderId !== userId && !msg.readBy.includes(userId))
      .map((msg) => msg.id)
  );
  const readAt = new Date();

  if (unreadIds.size > 0) {
    await Promise.all(
      [...unreadIds].map((id) =>
        prisma.message.update({
          where: { id },
          data: { readBy: { push: userId }, readAt, status: MessageStatus.READ },
        })
      )
    );
  }

  // Returned as they are now, read by this user
  const currentMessages = messages.map((msg) =>
    unreadIds.has(msg.id)
      ? { ...msg, readBy: [...msg.readBy, userId], readAt, status: MessageStatus.READ }
      : msg
  );

  // Enrich messages with sender info
  const enrichedMessages = await Promise.all(
    currentMessages.map(async (msg) => {
      const sender = await getUserDisplayInfo(msg.senderId);
      return {
        ...msg,
        sender,
      };
    })
  );

  const totalPages = Math.ceil(total / limit);

  return {
    messages: enrichedMessages.reverse(), // Return in chronological order
    total,
    page,
    limit,
    totalPages,
    hasNextPage: page < totalPages,
    hasPreviousPage: page > 1,
  };
};

/**
 * Mark messages as read
 */
export const markMessagesAsRead = async (
  userId: string,
  conversationId: string,
  messageIds?: string[]
) => {
  // Validate access
  const canAccess = await canAccessConversation(userId, conversationId);
  if (!canAccess) {
    throw conversationNotFound();
  }

  const whereClause: Prisma.MessageWhereInput = {
    conversationId,
    senderId: { not: userId },
  };

  if (messageIds && messageIds.length > 0) {
    whereClause.id = { in: messageIds };
  }

  // Get messages to update
  const messages = await prisma.message.findMany({
    where: whereClause,
  });

  // Update each message to add userId to readBy
  for (const msg of messages) {
    if (!msg.readBy.includes(userId)) {
      await prisma.message.update({
        where: { id: msg.id },
        data: {
          readBy: [...msg.readBy, userId],
          readAt: new Date(),
          status: MessageStatus.READ,
        },
      });
    }
  }

  return { success: true, message: 'Messages marked as read' };
};

/**
 * Point a conversation's preview at its latest message everyone can still see,
 * after one is deleted, or hidden or removed by moderation
 */
export const refreshConversationPreview = async (conversationId: string) => {
  const latest = await prisma.message.findFirst({
    where: { conversationId, isDeleted: false, isHidden: { not: true } },
    orderBy: { createdAt: 'desc' },
    select: { content: true },
  });

  await prisma.conversation.update({
    where: { id: conversationId },
    data: { lastMessageText: latest ? latest.content.substring(0, 100) : '' },
  });
};

/**
 * Delete a message (soft delete)
 */
export const deleteMessage = async (userId: string, messageId: string) => {
  const message = await prisma.message.findUnique({
    where: { id: messageId },
  });

  if (!message) {
    throw new GraphQLError('Message not found', {
      extensions: { code: 'NOT_FOUND' },
    });
  }

  if (message.senderId !== userId) {
    throw new GraphQLError('You can only delete your own messages', {
      extensions: { code: 'FORBIDDEN' },
    });
  }

  await prisma.message.update({
    where: { id: messageId },
    data: {
      isDeleted: true,
      deletedAt: new Date(),
      content: DELETED_MESSAGE_TEXT,
    },
  });

  // Don't leave the deleted text showing in the conversation list
  await refreshConversationPreview(message.conversationId);

  // Take it out of chats that are open now
  try {
    await emitToConversation(message.conversationId, 'message:deleted', {
      conversationId: message.conversationId,
      messageId,
    });
  } catch (err) {
    console.error('Failed to emit message deletion', err);
  }

  // Unread notifications for the message stop showing its text. A push that
  // was already delivered can't be recalled.
  try {
    const conversation = await prisma.conversation.findUnique({
      where: { id: message.conversationId },
      select: { participantIds: true },
    });
    const recipientIds = (conversation?.participantIds ?? []).filter((id) => id !== userId);

    if (recipientIds.length > 0) {
      await prisma.notification.updateMany({
        where: {
          userId: { in: recipientIds },
          isRead: false,
          type: NotificationType.NEW_MESSAGE,
          entityId: message.conversationId,
          metadata: { contains: messageId },
        },
        data: { message: DELETED_MESSAGE_TEXT },
      });
    }
  } catch (err) {
    console.error('Failed to update notifications for a deleted message', err);
  }

  return { success: true, message: 'Message deleted' };
};

/**
 * Get unread message count
 */
export const getUnreadMessageCount = async (userId: string) => {
  // Chats with people the user blocked, and chats they archived, are out of
  // their inbox, so they don't count
  const blockedIds = await getBlockedUserIds(userId);

  const count = await prisma.message.count({
    where: {
      conversation: {
        participantIds: { has: userId },
        isActive: true,
        NOT: [
          { archivedBy: { has: userId } },
          ...(blockedIds.length > 0 ? [{ participantIds: { hasSome: blockedIds } }] : []),
        ],
      },
      senderId: { not: userId },
      NOT: { readBy: { has: userId } },
      isDeleted: false,
      isHidden: { not: true },
    },
  });

  return { count };
};

/**
 * Start a support conversation with admin
 */
export const startSupportConversation = async (
  userId: string,
  userRole: string,
  subject: string,
  initialMessage: string
) => {
  const adminId = await findSupportAdmin(userId, userRole);

  if (!adminId) {
    throw new GraphQLError('No support staff available at the moment', {
      extensions: { code: 'NO_SUPPORT_AVAILABLE' },
    });
  }

  return createOrGetConversation(
    userId,
    userRole,
    {
      participantId: adminId,
      subject,
      initialMessage,
    },
    { support: true }
  );
};

/**
 * Get booking-related conversation. It's a query, but it creates the
 * booking's conversation the first time; the apps rely on that.
 */
export const getBookingConversation = async (
  userId: string,
  userRole: string,
  bookingId: string
) => {
  // Verify booking access
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: { provider: true },
  });

  if (!booking) {
    throw new GraphQLError('Booking not found', {
      extensions: { code: 'NOT_FOUND' },
    });
  }

  // Ensure user is part of booking
  if (booking.userId !== userId && booking.provider.userId !== userId) {
    throw new GraphQLError('You are not part of this booking', {
      extensions: { code: 'FORBIDDEN' },
    });
  }

  // Find or create conversation
  const otherParticipantId =
    booking.userId === userId ? booking.provider.userId : booking.userId;

  return createOrGetConversation(userId, userRole, {
    participantId: otherParticipantId,
    bookingId,
  });
};
