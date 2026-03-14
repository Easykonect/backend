/**
 * Messaging Service
 * Handles conversations and messages between users
 * 
 * Chat Types:
 * - USER_PROVIDER: Users chatting with Service Providers (about bookings)
 * - USER_ADMIN: Users/Providers support chat with Admins
 * - ADMIN_SUPERADMIN: Admins chatting with Super Admins
 * - BOOKING_RELATED: Chat tied to a specific booking
 */

import { GraphQLError } from 'graphql';
import prisma from '@/lib/prisma';
import { UserRole, ConversationType, MessageStatus, NotificationType } from '@/constants';
import { createNotification } from './notification.service';

// ==================
// Types
// ==================

interface CreateConversationInput {
  participantId: string;
  type?: string;
  subject?: string;
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

// ==================
// Helper Functions
// ==================

/**
 * Validate conversation type based on participant roles
 */
const validateConversationType = async (
  senderId: string,
  senderRole: string,
  recipientId: string
): Promise<string> => {
  // Get recipient info
  const recipient = await prisma.user.findUnique({
    where: { id: recipientId },
    select: { role: true },
  });

  if (!recipient) {
    throw new GraphQLError('Recipient not found', {
      extensions: { code: 'NOT_FOUND' },
    });
  }

  const recipientRole = recipient.role;

  // Determine conversation type based on roles
  if (
    (senderRole === UserRole.SERVICE_USER && recipientRole === UserRole.SERVICE_PROVIDER) ||
    (senderRole === UserRole.SERVICE_PROVIDER && recipientRole === UserRole.SERVICE_USER)
  ) {
    return ConversationType.USER_PROVIDER;
  }

  if (
    ((senderRole === UserRole.SERVICE_USER || senderRole === UserRole.SERVICE_PROVIDER) &&
      (recipientRole === UserRole.ADMIN || recipientRole === UserRole.SUPER_ADMIN)) ||
    ((senderRole === UserRole.ADMIN || senderRole === UserRole.SUPER_ADMIN) &&
      (recipientRole === UserRole.SERVICE_USER || recipientRole === UserRole.SERVICE_PROVIDER))
  ) {
    return ConversationType.USER_ADMIN;
  }

  if (
    (senderRole === UserRole.ADMIN && recipientRole === UserRole.SUPER_ADMIN) ||
    (senderRole === UserRole.SUPER_ADMIN && recipientRole === UserRole.ADMIN)
  ) {
    return ConversationType.ADMIN_SUPERADMIN;
  }

  throw new GraphQLError('Invalid conversation participants', {
    extensions: { code: 'INVALID_PARTICIPANTS' },
  });
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
  return user;
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
  input: CreateConversationInput
) => {
  const { participantId, subject, bookingId, initialMessage } = input;

  // Validate sender is not trying to chat with themselves
  if (senderId === participantId) {
    throw new GraphQLError('Cannot create conversation with yourself', {
      extensions: { code: 'INVALID_PARTICIPANT' },
    });
  }

  // Check if conversation already exists between these users
  const existingConversation = await prisma.conversation.findFirst({
    where: {
      participantIds: {
        hasEvery: [senderId, participantId],
      },
      isActive: true,
      // If booking related, match the booking
      ...(bookingId && { bookingId }),
    },
    include: {
      messages: {
        orderBy: { createdAt: 'desc' },
        take: 1,
      },
    },
  });

  if (existingConversation) {
    return existingConversation;
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
  } else {
    conversationType = await validateConversationType(senderId, senderRole, participantId);
  }

  // Create new conversation
  const conversation = await prisma.conversation.create({
    data: {
      type: conversationType as any,
      participantIds: [senderId, participantId],
      bookingId,
      subject,
      isActive: true,
    },
  });

  // If initial message provided, create it
  if (initialMessage) {
    await prisma.message.create({
      data: {
        conversationId: conversation.id,
        senderId,
        senderRole: senderRole as any,
        content: initialMessage,
        status: MessageStatus.SENT as any,
        readBy: [senderId],
      },
    });

    // Update conversation with last message info
    await prisma.conversation.update({
      where: { id: conversation.id },
      data: {
        lastMessageAt: new Date(),
        lastMessageText: initialMessage.substring(0, 100),
      },
    });

    // Send notification to recipient
    await createNotification({
      userId: participantId,
      type: NotificationType.NEW_MESSAGE,
      title: 'New Message',
      message: `You have a new message`,
      entityType: 'conversation',
      entityId: conversation.id,
    });
  }

  return prisma.conversation.findUnique({
    where: { id: conversation.id },
    include: {
      messages: {
        orderBy: { createdAt: 'desc' },
        take: 1,
      },
    },
  });
};

/**
 * Get conversation by ID
 */
export const getConversationById = async (userId: string, conversationId: string) => {
  const canAccess = await canAccessConversation(userId, conversationId);
  if (!canAccess) {
    throw new GraphQLError('Conversation not found or access denied', {
      extensions: { code: 'NOT_FOUND' },
    });
  }

  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
  });

  return conversation;
};

/**
 * Get user's conversations
 */
export const getMyConversations = async (
  userId: string,
  pagination: PaginationParams = {}
) => {
  const { page = 1, limit = 20 } = pagination;
  const skip = (page - 1) * limit;

  const [conversations, total] = await Promise.all([
    prisma.conversation.findMany({
      where: {
        participantIds: { has: userId },
        isActive: true,
      },
      orderBy: { lastMessageAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.conversation.count({
      where: {
        participantIds: { has: userId },
        isActive: true,
      },
    }),
  ]);

  // Enrich with participant info and unread count
  const enrichedConversations = await Promise.all(
    conversations.map(async (conv) => {
      const otherParticipantId = conv.participantIds.find((id) => id !== userId);
      const otherParticipant = otherParticipantId
        ? await getUserDisplayInfo(otherParticipantId)
        : null;

      const unreadCount = await prisma.message.count({
        where: {
          conversationId: conv.id,
          senderId: { not: userId },
          readBy: { isEmpty: true },
        },
      });

      return {
        ...conv,
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
 * Archive a conversation
 */
export const archiveConversation = async (userId: string, conversationId: string) => {
  const canAccess = await canAccessConversation(userId, conversationId);
  if (!canAccess) {
    throw new GraphQLError('Conversation not found or access denied', {
      extensions: { code: 'NOT_FOUND' },
    });
  }

  await prisma.conversation.update({
    where: { id: conversationId },
    data: { isActive: false },
  });

  return { success: true, message: 'Conversation archived' };
};

// ==================
// Message Functions
// ==================

/**
 * Send a message
 */
export const sendMessage = async (
  senderId: string,
  senderRole: string,
  input: SendMessageInput
) => {
  const { conversationId, content, attachments = [], replyToId } = input;

  // Validate conversation access
  const canAccess = await canAccessConversation(senderId, conversationId);
  if (!canAccess) {
    throw new GraphQLError('Conversation not found or access denied', {
      extensions: { code: 'NOT_FOUND' },
    });
  }

  // Validate content
  if (!content.trim() && attachments.length === 0) {
    throw new GraphQLError('Message content or attachments required', {
      extensions: { code: 'VALIDATION_ERROR' },
    });
  }

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

  // Create message
  const message = await prisma.message.create({
    data: {
      conversationId,
      senderId,
      senderRole: senderRole as any,
      content: content.trim(),
      attachments,
      status: MessageStatus.SENT as any,
      readBy: [senderId],
      replyToId,
    },
  });

  // Update conversation with last message info
  const conversation = await prisma.conversation.update({
    where: { id: conversationId },
    data: {
      lastMessageAt: new Date(),
      lastMessageText: content.trim().substring(0, 100),
    },
  });

  // Send notification to other participants
  const otherParticipantIds = conversation.participantIds.filter((id) => id !== senderId);
  
  for (const recipientId of otherParticipantIds) {
    await createNotification({
      userId: recipientId,
      type: NotificationType.NEW_MESSAGE,
      title: 'New Message',
      message: content.trim().substring(0, 100),
      entityType: 'conversation',
      entityId: conversationId,
    });
  }

  // Enrich message with sender info
  const sender = await getUserDisplayInfo(senderId);

  return {
    ...message,
    sender,
  };
};

/**
 * Get messages in a conversation
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
    throw new GraphQLError('Conversation not found or access denied', {
      extensions: { code: 'NOT_FOUND' },
    });
  }

  const [messages, total] = await Promise.all([
    prisma.message.findMany({
      where: {
        conversationId,
        isDeleted: false,
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.message.count({
      where: {
        conversationId,
        isDeleted: false,
      },
    }),
  ]);

  // Mark messages as read
  await prisma.message.updateMany({
    where: {
      conversationId,
      senderId: { not: userId },
      NOT: { readBy: { has: userId } },
    },
    data: {
      // Note: MongoDB doesn't support array push in updateMany
      // We'll handle this differently
      status: MessageStatus.READ as any,
    },
  });

  // Enrich messages with sender info
  const enrichedMessages = await Promise.all(
    messages.map(async (msg) => {
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
    throw new GraphQLError('Conversation not found or access denied', {
      extensions: { code: 'NOT_FOUND' },
    });
  }

  const whereClause: any = {
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
          status: MessageStatus.READ as any,
        },
      });
    }
  }

  return { success: true, message: 'Messages marked as read' };
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
      content: 'This message was deleted',
    },
  });

  return { success: true, message: 'Message deleted' };
};

/**
 * Get unread message count
 */
export const getUnreadMessageCount = async (userId: string) => {
  const count = await prisma.message.count({
    where: {
      conversation: {
        participantIds: { has: userId },
        isActive: true,
      },
      senderId: { not: userId },
      NOT: { readBy: { has: userId } },
      isDeleted: false,
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
  // Find an available admin
  const admin = await prisma.user.findFirst({
    where: {
      role: { in: [UserRole.ADMIN, UserRole.SUPER_ADMIN] as any },
      status: 'ACTIVE',
    },
    orderBy: { createdAt: 'asc' },
  });

  if (!admin) {
    throw new GraphQLError('No support staff available at the moment', {
      extensions: { code: 'NO_SUPPORT_AVAILABLE' },
    });
  }

  return createOrGetConversation(userId, userRole, {
    participantId: admin.id,
    subject,
    initialMessage,
  });
};

/**
 * Get booking-related conversation
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
