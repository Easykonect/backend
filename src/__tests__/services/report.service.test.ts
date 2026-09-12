/**
 * Report service: people reporting users and content, the content filter's
 * automated flags, the admin queue, reading a reported conversation, and an
 * admin's decision on a report
 */

jest.mock('@/lib/prisma', () => ({
  __esModule: true,
  default: {
    user: { findUnique: jest.fn(), findMany: jest.fn() },
    message: { findUnique: jest.fn(), findMany: jest.fn(), count: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
    conversation: { findUnique: jest.fn() },
    review: { findUnique: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
    service: { findUnique: jest.fn() },
    serviceProvider: { findUnique: jest.fn() },
    report: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
      updateMany: jest.fn(),
      groupBy: jest.fn(),
    },
    $transaction: jest.fn(),
  },
}));
jest.mock('@/config', () => ({ config: { moderation: { autoHideReportCount: 3 } } }));
// The security utils import the Redis client, which reads config on load
jest.mock('@/lib/redis', () => ({ __esModule: true, default: { getInstance: jest.fn() } }));
jest.mock('@/services/audit.service', () => ({ createAuditLog: jest.fn() }));
jest.mock('@/services/notification.service', () => ({
  createNotification: jest.fn(),
  createBulkNotifications: jest.fn(),
}));
jest.mock('@/services/service.service', () => ({ suspendService: jest.fn() }));
jest.mock('@/services/user-management.service', () => ({ restrictUser: jest.fn(), banUser: jest.fn() }));
jest.mock('@/services/messaging.service', () => ({ refreshConversationPreview: jest.fn() }));

import type { ModerationAction, Report, ReportTargetType } from '@prisma/client';
import { GraphQLError } from 'graphql';
import prisma from '@/lib/prisma';
import { config } from '@/config';
import { createAuditLog } from '@/services/audit.service';
import { refreshConversationPreview } from '@/services/messaging.service';
import { createBulkNotifications, createNotification } from '@/services/notification.service';
import { suspendService } from '@/services/service.service';
import { banUser, restrictUser } from '@/services/user-management.service';
import {
  createReport,
  flagContent,
  getMyReports,
  getReportById,
  getReportedConversationMessages,
  getReports,
  reasonForReportedUser,
  resolveReport,
} from '@/services/report.service';

// ==================
// Ids and fixtures
// ==================

const REPORTER_ID = '66e2b4c1f0a9d83b5c7e2a01';
const OTHER_REPORTER_ID = '66e2b4c1f0a9d83b5c7e2a02';
const THIRD_REPORTER_ID = '66e2b4c1f0a9d83b5c7e2a03';
const OFFENDER_ID = '66e2b4c1f0a9d83b5c7e2a04';
const GONE_USER_ID = '66e2b4c1f0a9d83b5c7e2a05';
const ADMIN_ID = '66e2b4c1f0a9d83b5c7e2a06';
const SUPER_ADMIN_ID = '66e2b4c1f0a9d83b5c7e2a07';

const MESSAGE_ID = '66e2b4c1f0a9d83b5c7e2a10';
const CONVERSATION_ID = '66e2b4c1f0a9d83b5c7e2a11';
const OTHER_CONVERSATION_ID = '66e2b4c1f0a9d83b5c7e2a12';
const REVIEW_ID = '66e2b4c1f0a9d83b5c7e2a13';
const SERVICE_ID = '66e2b4c1f0a9d83b5c7e2a14';
const PROVIDER_ID = '66e2b4c1f0a9d83b5c7e2a15';
const BOOKING_ID = '66e2b4c1f0a9d83b5c7e2a16';

const REPORT_ID = '66e2b4c1f0a9d83b5c7e2a20';
const SECOND_REPORT_ID = '66e2b4c1f0a9d83b5c7e2a21';
const THIRD_REPORT_ID = '66e2b4c1f0a9d83b5c7e2a22';
const FOURTH_REPORT_ID = '66e2b4c1f0a9d83b5c7e2a23';
const NEW_REPORT_ID = '66e2b4c1f0a9d83b5c7e2a24';
const EARLIER_REPORT_ID = '66e2b4c1f0a9d83b5c7e2a25';

const DAY_MS = 24 * 60 * 60 * 1000;

type MockDelegate<K extends string> = Record<K, jest.Mock>;

const db = prisma as unknown as {
  user: MockDelegate<'findUnique' | 'findMany'>;
  message: MockDelegate<'findUnique' | 'findMany' | 'count' | 'update' | 'updateMany'>;
  conversation: MockDelegate<'findUnique'>;
  review: MockDelegate<'findUnique' | 'update' | 'updateMany'>;
  service: MockDelegate<'findUnique'>;
  serviceProvider: MockDelegate<'findUnique'>;
  report: MockDelegate<'findFirst' | 'findUnique' | 'findMany' | 'count' | 'create' | 'updateMany' | 'groupBy'>;
  $transaction: jest.Mock;
};

const auditLog = createAuditLog as jest.Mock;
const notify = createNotification as jest.Mock;
const notifyMany = createBulkNotifications as jest.Mock;
const suspend = suspendService as jest.Mock;
const restrict = restrictUser as jest.Mock;
const ban = banUser as jest.Mock;
const previewRefresh = refreshConversationPreview as jest.Mock;

const moderation = config.moderation as { autoHideReportCount: number };

const code = (value: string) => ({ extensions: { code: value } });

const makeReport = (overrides: Partial<Report> = {}): Report => ({
  id: REPORT_ID,
  reporterId: REPORTER_ID,
  automated: false,
  targetType: 'MESSAGE',
  targetId: MESSAGE_ID,
  targetUserId: OFFENDER_ID,
  reason: 'OFF_PLATFORM_PAYMENT',
  details: null,
  snapshot: JSON.stringify({ conversationId: CONVERSATION_ID, content: 'Pay into my Opay account instead' }),
  status: 'OPEN',
  action: null,
  resolutionNotes: null,
  handledBy: null,
  handledAt: null,
  createdAt: new Date('2026-09-10T09:00:00.000Z'),
  updatedAt: new Date('2026-09-10T09:00:00.000Z'),
  ...overrides,
});

/** What a reporter sees of their own report */
const asMyReport = (report: Report) => ({
  id: report.id,
  targetType: report.targetType,
  targetId: report.targetId,
  reason: report.reason,
  details: report.details,
  status: report.status,
  createdAt: report.createdAt.toISOString(),
  updatedAt: report.updatedAt.toISOString(),
});

const offenderProfile = {
  id: OFFENDER_ID,
  firstName: 'Emeka',
  lastName: 'Nwosu',
  profilePhoto: null,
  role: 'SERVICE_PROVIDER',
};

const reportedMessage = (overrides: Record<string, unknown> = {}) => ({
  id: MESSAGE_ID,
  conversationId: CONVERSATION_ID,
  senderId: OFFENDER_ID,
  content: 'Pay into my Opay account instead',
  attachments: ['https://cdn.example.com/account-details.jpg'],
  createdAt: new Date('2026-09-10T08:00:00.000Z'),
  conversation: { participantIds: [REPORTER_ID, OFFENDER_ID] },
  ...overrides,
});

// Newest first, as the query asks for them
const recentConversationMessages = () => [
  {
    id: '66e2b4c1f0a9d83b5c7e2a32',
    senderId: OFFENDER_ID,
    content: 'Pay into my Opay account instead',
    attachments: [],
    createdAt: new Date('2026-09-10T08:05:00.000Z'),
  },
  {
    id: '66e2b4c1f0a9d83b5c7e2a31',
    senderId: REPORTER_ID,
    content: 'Can you come on Saturday?',
    attachments: [],
    createdAt: new Date('2026-09-10T08:00:00.000Z'),
  },
];

const reviewOf = (overrides: Record<string, unknown> = {}) => ({
  userId: OFFENDER_ID,
  rating: 1,
  comment: 'Useless, do not book',
  response: null as string | null,
  provider: { id: PROVIDER_ID, userId: REPORTER_ID },
  ...overrides,
});

const listing = {
  name: 'Deep Home Cleaning',
  description: 'Call me on 0803 000 0000 and pay cash',
  images: ['https://cdn.example.com/cleaning.jpg'],
  status: 'ACTIVE',
  provider: { userId: OFFENDER_ID },
};

const providerProfile = {
  userId: OFFENDER_ID,
  businessName: 'Sparkle Cleaners',
  businessDescription: 'Best cleaners in Lekki',
  images: [],
};

/** Make the given kind of target exist, with the reporter able to see it */
const targets: Record<ReportTargetType, { id: string; exists: () => void }> = {
  USER: { id: OFFENDER_ID, exists: () => db.user.findUnique.mockResolvedValue(offenderProfile) },
  MESSAGE: { id: MESSAGE_ID, exists: () => db.message.findUnique.mockResolvedValue(reportedMessage()) },
  CONVERSATION: {
    id: CONVERSATION_ID,
    exists: () => {
      db.conversation.findUnique.mockResolvedValue({ participantIds: [REPORTER_ID, OFFENDER_ID], bookingId: BOOKING_ID });
      db.message.findMany.mockResolvedValue(recentConversationMessages());
    },
  },
  REVIEW: { id: REVIEW_ID, exists: () => db.review.findUnique.mockResolvedValue(reviewOf()) },
  SERVICE: { id: SERVICE_ID, exists: () => db.service.findUnique.mockResolvedValue(listing) },
  PROVIDER: { id: PROVIDER_ID, exists: () => db.serviceProvider.findUnique.mockResolvedValue(providerProfile) },
};

const ALL_TARGET_TYPES: ReportTargetType[] = ['USER', 'MESSAGE', 'CONVERSATION', 'REVIEW', 'SERVICE', 'PROVIDER'];

/** The data of the report created */
const createdData = () => db.report.create.mock.calls[0][0].data;

beforeEach(() => {
  jest.resetAllMocks();
  moderation.autoHideReportCount = 3;
});

// ==================
// createReport
// ==================

describe('createReport', () => {
  beforeEach(() => {
    db.report.findFirst.mockResolvedValue(null);
    db.report.count.mockResolvedValue(0);
    db.report.create.mockImplementation(async ({ data }: { data: Partial<Report> }) =>
      makeReport({ id: NEW_REPORT_ID, ...data })
    );
    db.report.findMany.mockResolvedValue([]);
    db.user.findMany.mockResolvedValue([{ id: ADMIN_ID }, { id: SUPER_ADMIN_ID }]);
    notifyMany.mockResolvedValue({ count: 2 });
    // Hiding a message returns it
    db.message.update.mockResolvedValue({ id: MESSAGE_ID, conversationId: CONVERSATION_ID, isHidden: true });
  });

  describe('what is being reported', () => {
    it('USER: the reported user is responsible, and a copy of their profile is kept', async () => {
      targets.USER.exists();

      const result = await createReport(REPORTER_ID, { targetType: 'USER', targetId: OFFENDER_ID, reason: 'HARASSMENT' });

      expect(db.user.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: OFFENDER_ID } }));
      expect(db.report.create).toHaveBeenCalledWith({
        data: {
          reporterId: REPORTER_ID,
          targetType: 'USER',
          targetId: OFFENDER_ID,
          targetUserId: OFFENDER_ID,
          reason: 'HARASSMENT',
          details: null,
          snapshot: JSON.stringify(offenderProfile),
        },
      });
      expect(result).toEqual({
        id: NEW_REPORT_ID,
        targetType: 'USER',
        targetId: OFFENDER_ID,
        reason: 'HARASSMENT',
        details: null,
        status: 'OPEN',
        createdAt: '2026-09-10T09:00:00.000Z',
        updatedAt: '2026-09-10T09:00:00.000Z',
      });
    });

    it("SERVICE: the provider's user is responsible, and the listing is copied without the provider", async () => {
      targets.SERVICE.exists();

      await createReport(REPORTER_ID, { targetType: 'SERVICE', targetId: SERVICE_ID, reason: 'SCAM' });

      expect(db.service.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: SERVICE_ID } }));
      expect(createdData().targetUserId).toBe(OFFENDER_ID);
      expect(JSON.parse(createdData().snapshot)).toEqual({
        name: 'Deep Home Cleaning',
        description: 'Call me on 0803 000 0000 and pay cash',
        images: ['https://cdn.example.com/cleaning.jpg'],
        status: 'ACTIVE',
      });
    });

    it("PROVIDER: the provider's user is responsible, and the business profile is copied", async () => {
      targets.PROVIDER.exists();

      await createReport(REPORTER_ID, { targetType: 'PROVIDER', targetId: PROVIDER_ID, reason: 'IMPERSONATION' });

      expect(db.serviceProvider.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: PROVIDER_ID } }));
      expect(createdData().targetUserId).toBe(OFFENDER_ID);
      expect(JSON.parse(createdData().snapshot)).toEqual({
        businessName: 'Sparkle Cleaners',
        businessDescription: 'Best cleaners in Lekki',
        images: [],
      });
    });

    it('MESSAGE: the sender is responsible, and the message is copied with its conversation', async () => {
      targets.MESSAGE.exists();

      await createReport(REPORTER_ID, { targetType: 'MESSAGE', targetId: MESSAGE_ID, reason: 'OFF_PLATFORM_PAYMENT' });

      expect(db.message.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: MESSAGE_ID } }));
      expect(createdData().targetUserId).toBe(OFFENDER_ID);
      expect(JSON.parse(createdData().snapshot)).toEqual({
        conversationId: CONVERSATION_ID,
        content: 'Pay into my Opay account instead',
        attachments: ['https://cdn.example.com/account-details.jpg'],
        sentAt: '2026-09-10T08:00:00.000Z',
      });
    });

    it('MESSAGE: someone outside the conversation gets NOT_FOUND', async () => {
      db.message.findUnique.mockResolvedValue(
        reportedMessage({ conversation: { participantIds: [OTHER_REPORTER_ID, OFFENDER_ID] } })
      );

      await expect(
        createReport(REPORTER_ID, { targetType: 'MESSAGE', targetId: MESSAGE_ID, reason: 'HARASSMENT' })
      ).rejects.toMatchObject(code('NOT_FOUND'));
      expect(db.report.findFirst).not.toHaveBeenCalled();
      expect(db.report.create).not.toHaveBeenCalled();
    });

    it('MESSAGE: a message that does not exist is NOT_FOUND', async () => {
      db.message.findUnique.mockResolvedValue(null);

      await expect(
        createReport(REPORTER_ID, { targetType: 'MESSAGE', targetId: MESSAGE_ID, reason: 'HARASSMENT' })
      ).rejects.toMatchObject(code('NOT_FOUND'));
      expect(db.report.create).not.toHaveBeenCalled();
    });

    it('CONVERSATION: the other participant is responsible, and the latest messages are copied oldest first', async () => {
      targets.CONVERSATION.exists();

      await createReport(REPORTER_ID, { targetType: 'CONVERSATION', targetId: CONVERSATION_ID, reason: 'HARASSMENT' });

      expect(db.message.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { conversationId: CONVERSATION_ID }, orderBy: { createdAt: 'desc' }, take: 20 })
      );
      expect(createdData().targetUserId).toBe(OFFENDER_ID);
      const snapshot = JSON.parse(createdData().snapshot);
      expect(snapshot).toMatchObject({ bookingId: BOOKING_ID, participantIds: [REPORTER_ID, OFFENDER_ID] });
      expect(snapshot.messages.map((m: { content: string }) => m.content)).toEqual([
        'Can you come on Saturday?',
        'Pay into my Opay account instead',
      ]);
      expect(snapshot.messages[0].createdAt).toBe('2026-09-10T08:00:00.000Z');
    });

    it('CONVERSATION: someone outside the conversation gets NOT_FOUND', async () => {
      db.conversation.findUnique.mockResolvedValue({ participantIds: [OTHER_REPORTER_ID, OFFENDER_ID], bookingId: null });

      await expect(
        createReport(REPORTER_ID, { targetType: 'CONVERSATION', targetId: CONVERSATION_ID, reason: 'HARASSMENT' })
      ).rejects.toMatchObject(code('NOT_FOUND'));
      expect(db.message.findMany).not.toHaveBeenCalled();
      expect(db.report.create).not.toHaveBeenCalled();
    });

    it('CONVERSATION: a conversation that does not exist is NOT_FOUND', async () => {
      db.conversation.findUnique.mockResolvedValue(null);

      await expect(
        createReport(REPORTER_ID, { targetType: 'CONVERSATION', targetId: CONVERSATION_ID, reason: 'HARASSMENT' })
      ).rejects.toMatchObject(code('NOT_FOUND'));
      expect(db.report.create).not.toHaveBeenCalled();
    });

    it('REVIEW: the reviewer is responsible when someone else reports it', async () => {
      targets.REVIEW.exists();

      await createReport(REPORTER_ID, { targetType: 'REVIEW', targetId: REVIEW_ID, reason: 'HATE' });

      expect(createdData().targetUserId).toBe(OFFENDER_ID);
      expect(JSON.parse(createdData().snapshot)).toEqual({
        reviewerId: OFFENDER_ID,
        providerId: PROVIDER_ID,
        rating: 1,
        comment: 'Useless, do not book',
        response: null,
      });
    });

    it("REVIEW: a reviewer reporting their own review is reporting the provider's reply", async () => {
      db.review.findUnique.mockResolvedValue(
        reviewOf({
          userId: REPORTER_ID,
          response: 'You are a liar and I know where you live',
          provider: { id: PROVIDER_ID, userId: OFFENDER_ID },
        })
      );

      await createReport(REPORTER_ID, { targetType: 'REVIEW', targetId: REVIEW_ID, reason: 'HARASSMENT' });

      expect(createdData().targetUserId).toBe(OFFENDER_ID);
    });

    it('REVIEW: a reviewer reporting their own review with no reply gets CANNOT_REPORT_SELF', async () => {
      db.review.findUnique.mockResolvedValue(
        reviewOf({ userId: REPORTER_ID, response: null, provider: { id: PROVIDER_ID, userId: OFFENDER_ID } })
      );

      await expect(
        createReport(REPORTER_ID, { targetType: 'REVIEW', targetId: REVIEW_ID, reason: 'HARASSMENT' })
      ).rejects.toMatchObject(code('CANNOT_REPORT_SELF'));
      expect(db.report.create).not.toHaveBeenCalled();
    });

    it.each(ALL_TARGET_TYPES)('%s: an id that is not an ObjectId is NOT_FOUND without a lookup', async (targetType) => {
      await expect(
        createReport(REPORTER_ID, { targetType, targetId: 'not-an-object-id', reason: 'SPAM' })
      ).rejects.toMatchObject(code('NOT_FOUND'));

      expect(db.user.findUnique).not.toHaveBeenCalled();
      expect(db.message.findUnique).not.toHaveBeenCalled();
      expect(db.conversation.findUnique).not.toHaveBeenCalled();
      expect(db.review.findUnique).not.toHaveBeenCalled();
      expect(db.service.findUnique).not.toHaveBeenCalled();
      expect(db.serviceProvider.findUnique).not.toHaveBeenCalled();
      expect(db.report.create).not.toHaveBeenCalled();
    });

    it.each([[''], ['66e2b4c1f0a9d83b5c7e2a0'], ['66e2b4c1f0a9d83b5c7e2a0zz'], ['66e2b4c1f0a9d83b5c7e2a011']])(
      'treats %p as not found without a lookup',
      async (targetId) => {
        await expect(createReport(REPORTER_ID, { targetType: 'USER', targetId, reason: 'SPAM' })).rejects.toMatchObject(
          code('NOT_FOUND')
        );
        expect(db.user.findUnique).not.toHaveBeenCalled();
      }
    );
  });

  it('refuses a report of your own account', async () => {
    db.user.findUnique.mockResolvedValue({ ...offenderProfile, id: REPORTER_ID });

    await expect(
      createReport(REPORTER_ID, { targetType: 'USER', targetId: REPORTER_ID, reason: 'SPAM' })
    ).rejects.toMatchObject(code('CANNOT_REPORT_SELF'));
    expect(db.report.create).not.toHaveBeenCalled();
  });

  it('refuses a report of your own message', async () => {
    db.message.findUnique.mockResolvedValue(reportedMessage({ senderId: REPORTER_ID }));

    await expect(
      createReport(REPORTER_ID, { targetType: 'MESSAGE', targetId: MESSAGE_ID, reason: 'SPAM' })
    ).rejects.toMatchObject(code('CANNOT_REPORT_SELF'));
    expect(db.report.create).not.toHaveBeenCalled();
  });

  it('returns the open report when the same person reports the same thing again', async () => {
    targets.USER.exists();
    const existing = makeReport({ targetType: 'USER', targetId: OFFENDER_ID, reason: 'HARASSMENT', details: 'First time' });
    db.report.findFirst.mockResolvedValue(existing);

    const result = await createReport(REPORTER_ID, {
      targetType: 'USER',
      targetId: OFFENDER_ID,
      reason: 'SCAM',
      details: 'Second time',
    });

    expect(db.report.findFirst).toHaveBeenCalledWith({
      where: { reporterId: REPORTER_ID, targetType: 'USER', targetId: OFFENDER_ID, status: 'OPEN' },
    });
    expect(result).toEqual(asMyReport(existing));
    expect(db.report.create).not.toHaveBeenCalled();
    expect(notifyMany).not.toHaveBeenCalled();
  });

  it('refuses a report once 20 were made in the last 24 hours', async () => {
    targets.USER.exists();
    db.report.count.mockResolvedValue(20);

    const before = Date.now();
    await expect(
      createReport(REPORTER_ID, { targetType: 'USER', targetId: OFFENDER_ID, reason: 'SPAM' })
    ).rejects.toMatchObject(code('RATE_LIMITED'));
    const after = Date.now();

    const [{ where }] = db.report.count.mock.calls[0];
    expect(where.reporterId).toBe(REPORTER_ID);
    expect(where.createdAt.gte.getTime()).toBeGreaterThanOrEqual(before - DAY_MS);
    expect(where.createdAt.gte.getTime()).toBeLessThanOrEqual(after - DAY_MS);
    expect(db.report.create).not.toHaveBeenCalled();
  });

  it('accepts the 20th report of the day', async () => {
    targets.USER.exists();
    db.report.count.mockResolvedValue(19);

    await expect(
      createReport(REPORTER_ID, { targetType: 'USER', targetId: OFFENDER_ID, reason: 'SPAM' })
    ).resolves.toMatchObject({ id: NEW_REPORT_ID, status: 'OPEN' });
    expect(db.report.create).toHaveBeenCalledTimes(1);
  });

  describe('details', () => {
    beforeEach(() => {
      targets.USER.exists();
    });

    it('are trimmed and sanitized', async () => {
      await createReport(REPORTER_ID, {
        targetType: 'USER',
        targetId: OFFENDER_ID,
        reason: 'SCAM',
        details: '   <script>alert(1)</script>He asked me to pay into his personal account   ',
      });

      // Tags and script contents are removed; the text is stored as typed
      expect(createdData().details).toBe('He asked me to pay into his personal account');
    });

    it('keep at most 1,000 characters', async () => {
      await createReport(REPORTER_ID, {
        targetType: 'USER',
        targetId: OFFENDER_ID,
        reason: 'SCAM',
        details: `  ${'x'.repeat(1500)}  `,
      });

      expect(createdData().details).toBe('x'.repeat(1000));
    });

    it.each([['   '], [''], [null], [undefined]])('are not stored when given %p', async (details) => {
      await createReport(REPORTER_ID, { targetType: 'USER', targetId: OFFENDER_ID, reason: 'SCAM', details });

      expect(createdData().details).toBeNull();
    });
  });

  it('stores the copy of the content as a JSON string', async () => {
    targets.USER.exists();

    await createReport(REPORTER_ID, { targetType: 'USER', targetId: OFFENDER_ID, reason: 'HARASSMENT' });

    expect(typeof createdData().snapshot).toBe('string');
    expect(JSON.parse(createdData().snapshot)).toEqual(offenderProfile);
  });

  describe('hiding content that many people report', () => {
    const openReportsFrom = (...reporterIds: string[]) => reporterIds.map((reporterId) => ({ reporterId }));

    it('hides a message once 3 different people have open reports on it, counting the new one', async () => {
      targets.MESSAGE.exists();
      db.report.findMany.mockResolvedValue(openReportsFrom(OTHER_REPORTER_ID, THIRD_REPORTER_ID, REPORTER_ID));

      await createReport(REPORTER_ID, { targetType: 'MESSAGE', targetId: MESSAGE_ID, reason: 'HARASSMENT' });

      expect(db.report.findMany).toHaveBeenCalledWith({
        where: { targetType: 'MESSAGE', targetId: MESSAGE_ID, status: 'OPEN', automated: false },
        select: { reporterId: true },
      });
      expect(db.report.create.mock.invocationCallOrder[0]).toBeLessThan(db.report.findMany.mock.invocationCallOrder[0]);
      expect(db.message.update).toHaveBeenCalledWith({ where: { id: MESSAGE_ID }, data: { isHidden: true } });
    });

    it("refreshes the conversation's preview after hiding a message", async () => {
      targets.MESSAGE.exists();
      db.report.findMany.mockResolvedValue(openReportsFrom(OTHER_REPORTER_ID, THIRD_REPORTER_ID, REPORTER_ID));

      await createReport(REPORTER_ID, { targetType: 'MESSAGE', targetId: MESSAGE_ID, reason: 'HARASSMENT' });

      expect(previewRefresh).toHaveBeenCalledTimes(1);
      expect(previewRefresh).toHaveBeenCalledWith(CONVERSATION_ID);
      expect(db.message.update.mock.invocationCallOrder[0]).toBeLessThan(previewRefresh.mock.invocationCallOrder[0]);
    });

    it('refreshes no preview when a review is hidden or a message stays visible', async () => {
      targets.REVIEW.exists();
      db.report.findMany.mockResolvedValue(openReportsFrom(OTHER_REPORTER_ID, THIRD_REPORTER_ID, REPORTER_ID));
      await createReport(REPORTER_ID, { targetType: 'REVIEW', targetId: REVIEW_ID, reason: 'HATE' });

      targets.MESSAGE.exists();
      db.report.findMany.mockResolvedValue(openReportsFrom(OTHER_REPORTER_ID, REPORTER_ID));
      await createReport(REPORTER_ID, { targetType: 'MESSAGE', targetId: MESSAGE_ID, reason: 'HARASSMENT' });

      expect(db.review.update).toHaveBeenCalledTimes(1);
      expect(db.message.update).not.toHaveBeenCalled();
      expect(previewRefresh).not.toHaveBeenCalled();
    });

    it('still saves the report and tells admins when the preview cannot be refreshed', async () => {
      targets.MESSAGE.exists();
      db.report.findMany.mockResolvedValue(openReportsFrom(OTHER_REPORTER_ID, THIRD_REPORTER_ID, REPORTER_ID));
      previewRefresh.mockRejectedValue(new Error('conversation update failed'));
      const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);

      await expect(
        createReport(REPORTER_ID, { targetType: 'MESSAGE', targetId: MESSAGE_ID, reason: 'HARASSMENT' })
      ).resolves.toMatchObject({ id: NEW_REPORT_ID, status: 'OPEN' });
      expect(db.message.update).toHaveBeenCalledWith({ where: { id: MESSAGE_ID }, data: { isHidden: true } });
      expect(notifyMany).toHaveBeenCalledTimes(1);
      expect(consoleError).toHaveBeenCalled();
    });

    it.each(['MESSAGE', 'REVIEW'] as ReportTargetType[])(
      'still returns the report and alerts admins when the %s cannot be hidden',
      async (targetType) => {
        targets[targetType].exists();
        db.report.findMany.mockResolvedValue(openReportsFrom(OTHER_REPORTER_ID, THIRD_REPORTER_ID, REPORTER_ID));
        // Deleted between the lookup and hiding it
        const hide = targetType === 'MESSAGE' ? db.message.update : db.review.update;
        hide.mockRejectedValue(new Error('Record to update not found.'));
        const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);

        await expect(
          createReport(REPORTER_ID, { targetType, targetId: targets[targetType].id, reason: 'HARASSMENT' })
        ).resolves.toMatchObject({ id: NEW_REPORT_ID, status: 'OPEN' });

        expect(db.report.create).toHaveBeenCalledTimes(1);
        expect(hide).toHaveBeenCalledTimes(1);
        expect(previewRefresh).not.toHaveBeenCalled();
        expect(notifyMany).toHaveBeenCalledTimes(1);
        expect(consoleError).toHaveBeenCalled();
      }
    );

    it('hides a review once 3 different people have open reports on it', async () => {
      targets.REVIEW.exists();
      db.report.findMany.mockResolvedValue(openReportsFrom(OTHER_REPORTER_ID, THIRD_REPORTER_ID, REPORTER_ID));

      await createReport(REPORTER_ID, { targetType: 'REVIEW', targetId: REVIEW_ID, reason: 'HATE' });

      expect(db.report.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { targetType: 'REVIEW', targetId: REVIEW_ID, status: 'OPEN', automated: false } })
      );
      expect(db.review.update).toHaveBeenCalledWith({ where: { id: REVIEW_ID }, data: { isHidden: true } });
    });

    it('leaves a message visible with fewer different reporters than needed', async () => {
      targets.MESSAGE.exists();
      db.report.findMany.mockResolvedValue(openReportsFrom(OTHER_REPORTER_ID, REPORTER_ID));

      await createReport(REPORTER_ID, { targetType: 'MESSAGE', targetId: MESSAGE_ID, reason: 'HARASSMENT' });

      expect(db.message.update).not.toHaveBeenCalled();
    });

    it('counts people, not reports', async () => {
      targets.MESSAGE.exists();
      db.report.findMany.mockResolvedValue(openReportsFrom(REPORTER_ID, REPORTER_ID, OTHER_REPORTER_ID));

      await createReport(REPORTER_ID, { targetType: 'MESSAGE', targetId: MESSAGE_ID, reason: 'HARASSMENT' });

      expect(db.message.update).not.toHaveBeenCalled();
    });

    it('uses the number of reports set in config', async () => {
      moderation.autoHideReportCount = 2;
      targets.REVIEW.exists();
      db.report.findMany.mockResolvedValue(openReportsFrom(OTHER_REPORTER_ID, REPORTER_ID));

      await createReport(REPORTER_ID, { targetType: 'REVIEW', targetId: REVIEW_ID, reason: 'HATE' });

      expect(db.review.update).toHaveBeenCalledWith({ where: { id: REVIEW_ID }, data: { isHidden: true } });
    });

    it.each(['USER', 'CONVERSATION', 'SERVICE', 'PROVIDER'] as ReportTargetType[])(
      'never hides a reported %s',
      async (targetType) => {
        targets[targetType].exists();
        db.report.findMany.mockResolvedValue(openReportsFrom(OTHER_REPORTER_ID, THIRD_REPORTER_ID, REPORTER_ID));

        await createReport(REPORTER_ID, { targetType, targetId: targets[targetType].id, reason: 'HARASSMENT' });

        expect(db.report.findMany).not.toHaveBeenCalled();
        expect(db.message.update).not.toHaveBeenCalled();
        expect(db.review.update).not.toHaveBeenCalled();
      }
    );
  });

  describe('telling admins', () => {
    it('tells every active admin there is a report to review', async () => {
      targets.MESSAGE.exists();

      await createReport(REPORTER_ID, { targetType: 'MESSAGE', targetId: MESSAGE_ID, reason: 'OFF_PLATFORM_PAYMENT' });

      expect(db.user.findMany).toHaveBeenCalledWith({
        where: { role: { in: ['ADMIN', 'SUPER_ADMIN'] }, status: 'ACTIVE' },
        select: { id: true },
      });
      expect(notifyMany).toHaveBeenCalledWith(
        [ADMIN_ID, SUPER_ADMIN_ID],
        'SYSTEM_ANNOUNCEMENT',
        'New report to review',
        'A message was reported for off platform payment.',
        'report',
        NEW_REPORT_ID,
        { reportId: NEW_REPORT_ID }
      );
    });

    it('still returns the report when the admins cannot be notified', async () => {
      targets.MESSAGE.exists();
      notifyMany.mockRejectedValue(new Error('database unavailable'));
      const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);

      await expect(
        createReport(REPORTER_ID, { targetType: 'MESSAGE', targetId: MESSAGE_ID, reason: 'HARASSMENT' })
      ).resolves.toMatchObject({ id: NEW_REPORT_ID, status: 'OPEN' });
      expect(consoleError).toHaveBeenCalled();
    });

    it('still returns the report when the admins cannot be looked up', async () => {
      targets.USER.exists();
      db.user.findMany.mockRejectedValue(new Error('database unavailable'));
      jest.spyOn(console, 'error').mockImplementation(() => undefined);

      await expect(
        createReport(REPORTER_ID, { targetType: 'USER', targetId: OFFENDER_ID, reason: 'HARASSMENT' })
      ).resolves.toMatchObject({ id: NEW_REPORT_ID, status: 'OPEN' });
      expect(notifyMany).not.toHaveBeenCalled();
    });
  });
});

// ==================
// flagContent
// ==================

describe('flagContent', () => {
  const flag: Parameters<typeof flagContent>[0] = {
    targetType: 'MESSAGE',
    targetId: MESSAGE_ID,
    targetUserId: OFFENDER_ID,
    reason: 'OFF_PLATFORM_PAYMENT',
    details: 'Looks like a bank account number',
    snapshot: { conversationId: CONVERSATION_ID, content: 'Pay 0123456789 GTBank' },
  };

  it('raises an automated report with no reporter', async () => {
    db.report.findFirst.mockResolvedValue(null);
    db.report.create.mockResolvedValue(makeReport({ automated: true, reporterId: null }));

    await expect(flagContent(flag)).resolves.toBeUndefined();

    expect(db.report.findFirst).toHaveBeenCalledWith({
      where: {
        automated: true,
        targetType: 'MESSAGE',
        targetId: MESSAGE_ID,
        reason: 'OFF_PLATFORM_PAYMENT',
        status: 'OPEN',
      },
      select: { id: true },
    });
    const data = createdData();
    expect(data).toEqual({
      automated: true,
      targetType: 'MESSAGE',
      targetId: MESSAGE_ID,
      targetUserId: OFFENDER_ID,
      reason: 'OFF_PLATFORM_PAYMENT',
      details: 'Looks like a bank account number',
      snapshot: JSON.stringify(flag.snapshot),
    });
    expect(data).not.toHaveProperty('reporterId');
  });

  it('does not raise another while an automated report is open for the same content and reason', async () => {
    db.report.findFirst.mockResolvedValue({ id: REPORT_ID });

    await expect(flagContent(flag)).resolves.toBeUndefined();

    expect(db.report.create).not.toHaveBeenCalled();
  });

  it('never throws when the lookup fails', async () => {
    db.report.findFirst.mockRejectedValue(new Error('database unavailable'));
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(flagContent(flag)).resolves.toBeUndefined();
    expect(db.report.create).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalled();
  });

  it('never throws when saving the report fails', async () => {
    db.report.findFirst.mockResolvedValue(null);
    db.report.create.mockRejectedValue(new Error('database unavailable'));
    jest.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(flagContent(flag)).resolves.toBeUndefined();
  });
});

// ==================
// getMyReports
// ==================

describe('getMyReports', () => {
  it('lists only the reports the user made, newest first, without the admin details', async () => {
    const open = makeReport({ id: REPORT_ID, details: 'He keeps asking for cash' });
    const dismissed = makeReport({
      id: SECOND_REPORT_ID,
      status: 'DISMISSED',
      action: 'DISMISS',
      resolutionNotes: 'Normal price negotiation',
      handledBy: ADMIN_ID,
      handledAt: new Date('2026-09-11T10:00:00.000Z'),
    });
    db.report.findMany.mockResolvedValue([open, dismissed]);
    db.report.count.mockResolvedValue(22);

    const result = await getMyReports(REPORTER_ID, { page: 2, limit: 20 });

    expect(db.report.findMany).toHaveBeenCalledWith({
      where: { reporterId: REPORTER_ID },
      orderBy: { createdAt: 'desc' },
      skip: 20,
      take: 20,
    });
    expect(db.report.count).toHaveBeenCalledWith({ where: { reporterId: REPORTER_ID } });
    expect(result).toEqual({
      items: [asMyReport(open), asMyReport(dismissed)],
      total: 22,
      page: 2,
      limit: 20,
      totalPages: 2,
      hasNextPage: false,
      hasPreviousPage: true,
    });
    for (const field of ['snapshot', 'resolutionNotes', 'handledBy', 'action', 'targetUserId']) {
      expect(result.items[1]).not.toHaveProperty(field);
    }
  });

  it('uses the first page of 20 by default', async () => {
    db.report.findMany.mockResolvedValue([]);
    db.report.count.mockResolvedValue(0);

    const result = await getMyReports(REPORTER_ID);

    expect(db.report.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 0, take: 20 }));
    expect(result).toMatchObject({ items: [], total: 0, page: 1, limit: 20, hasNextPage: false, hasPreviousPage: false });
  });
});

// ==================
// getReports
// ==================

describe('getReports', () => {
  const summary = (id: string, firstName: string, role = 'SERVICE_USER') => ({
    id,
    firstName,
    lastName: 'Test',
    email: `${firstName.toLowerCase()}@example.com`,
    role,
    status: 'ACTIVE',
  });

  beforeEach(() => {
    db.report.findMany.mockResolvedValue([]);
    db.report.count.mockResolvedValue(0);
  });

  it('applies the filters to the list and the count', async () => {
    await getReports({ status: 'ACTIONED', targetType: 'REVIEW', reason: 'HATE' });

    const where = { status: 'ACTIONED', targetType: 'REVIEW', reason: 'HATE' };
    expect(db.report.findMany).toHaveBeenCalledWith(expect.objectContaining({ where }));
    expect(db.report.count).toHaveBeenCalledWith({ where });
  });

  it('lists every report without filters', async () => {
    await getReports({ status: null, targetType: null, reason: null });

    expect(db.report.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: {} }));
    expect(db.report.count).toHaveBeenCalledWith({ where: {} });
  });

  it('lists open reports oldest first, so nothing waits too long', async () => {
    await getReports({ status: 'OPEN' });

    expect(db.report.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: 'OPEN' }, orderBy: { createdAt: 'asc' } })
    );
  });

  it.each([[{ status: 'ACTIONED' as const }], [{ status: 'DISMISSED' as const }], [{}]])(
    'lists other reports newest first (%p)',
    async (filters) => {
      await getReports(filters);

      expect(db.report.findMany).toHaveBeenCalledWith(expect.objectContaining({ orderBy: { createdAt: 'desc' } }));
    }
  );

  it('shows who reported it, who is responsible and how many open reports the content has', async () => {
    const fromPerson = makeReport({ id: REPORT_ID });
    const automated = makeReport({ id: SECOND_REPORT_ID, reporterId: null, automated: true, targetUserId: null });
    const handled = makeReport({
      id: THIRD_REPORT_ID,
      reporterId: OTHER_REPORTER_ID,
      targetType: 'USER',
      targetId: GONE_USER_ID,
      targetUserId: GONE_USER_ID,
      reason: 'SCAM',
      status: 'ACTIONED',
      action: 'BAN_USER',
      resolutionNotes: 'Took payment and never came',
      handledBy: ADMIN_ID,
      handledAt: new Date('2026-09-11T12:00:00.000Z'),
    });
    const reporter = summary(REPORTER_ID, 'Ada');
    const offender = summary(OFFENDER_ID, 'Emeka', 'SERVICE_PROVIDER');
    const otherReporter = summary(OTHER_REPORTER_ID, 'Tunde');

    db.report.findMany.mockResolvedValue([fromPerson, automated, handled]);
    db.report.count.mockResolvedValue(3);
    // The banned user's account no longer exists
    db.user.findMany.mockResolvedValue([reporter, offender, otherReporter]);
    db.report.groupBy.mockResolvedValue([{ targetId: MESSAGE_ID, _count: { _all: 2 } }]);

    const result = await getReports();

    const [{ where: userWhere, select }] = db.user.findMany.mock.calls[0];
    expect(userWhere.id.in).toHaveLength(4);
    expect(userWhere.id.in).toEqual(expect.arrayContaining([REPORTER_ID, OFFENDER_ID, OTHER_REPORTER_ID, GONE_USER_ID]));
    expect(select).toEqual({ id: true, firstName: true, lastName: true, email: true, role: true, status: true });
    expect(db.report.groupBy).toHaveBeenCalledWith({
      by: ['targetId'],
      where: { targetId: { in: [MESSAGE_ID, GONE_USER_ID] }, status: 'OPEN' },
      _count: { _all: true },
    });

    expect(result.items).toEqual([
      {
        ...asMyReport(fromPerson),
        automated: false,
        snapshot: fromPerson.snapshot,
        action: null,
        resolutionNotes: null,
        handledBy: null,
        handledAt: null,
        reporter,
        targetUser: offender,
        openReportCount: 2,
      },
      {
        ...asMyReport(automated),
        automated: true,
        snapshot: automated.snapshot,
        action: null,
        resolutionNotes: null,
        handledBy: null,
        handledAt: null,
        reporter: null,
        targetUser: null,
        openReportCount: 2,
      },
      {
        ...asMyReport(handled),
        automated: false,
        snapshot: handled.snapshot,
        action: 'BAN_USER',
        resolutionNotes: 'Took payment and never came',
        handledBy: ADMIN_ID,
        handledAt: '2026-09-11T12:00:00.000Z',
        reporter: otherReporter,
        targetUser: null,
        openReportCount: 0,
      },
    ]);
    expect(result).toMatchObject({ total: 3, page: 1, limit: 20, totalPages: 1, hasNextPage: false, hasPreviousPage: false });
  });

  it('makes no user or count lookups for an empty page', async () => {
    const result = await getReports({ status: 'OPEN' });

    expect(result.items).toEqual([]);
    expect(db.user.findMany).not.toHaveBeenCalled();
    expect(db.report.groupBy).not.toHaveBeenCalled();
  });

  it('keeps the page size within 1..100', async () => {
    await getReports({}, { page: 0, limit: 1000 });

    expect(db.report.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 0, take: 100 }));
  });
});

// ==================
// getReportById
// ==================

describe('getReportById', () => {
  it('throws NOT_FOUND for a report that does not exist', async () => {
    db.report.findUnique.mockResolvedValue(null);

    await expect(getReportById(REPORT_ID)).rejects.toMatchObject(code('NOT_FOUND'));
    expect(db.report.findUnique).toHaveBeenCalledWith({ where: { id: REPORT_ID } });
  });

  it('throws NOT_FOUND for an id that is not an ObjectId, without a lookup', async () => {
    await expect(getReportById('not-a-report')).rejects.toMatchObject(code('NOT_FOUND'));
    expect(db.report.findUnique).not.toHaveBeenCalled();
  });

  it('returns the admin view of the report', async () => {
    db.report.findUnique.mockResolvedValue(makeReport());
    db.user.findMany.mockResolvedValue([]);
    db.report.groupBy.mockResolvedValue([{ targetId: MESSAGE_ID, _count: { _all: 1 } }]);

    await expect(getReportById(REPORT_ID)).resolves.toMatchObject({
      id: REPORT_ID,
      status: 'OPEN',
      reporter: null,
      targetUser: null,
      openReportCount: 1,
    });
  });
});

// ==================
// getReportedConversationMessages
// ==================

describe('getReportedConversationMessages', () => {
  const admin = { id: ADMIN_ID, role: 'ADMIN' };

  const offenderSender = {
    id: OFFENDER_ID,
    firstName: 'Emeka',
    lastName: 'Nwosu',
    profilePhoto: null,
    role: 'SERVICE_PROVIDER',
    provider: { businessName: 'Sparkle Cleaners' },
  };
  const reporterSender = {
    id: REPORTER_ID,
    firstName: 'Ada',
    lastName: 'Obi',
    profilePhoto: null,
    role: 'SERVICE_USER',
    provider: null,
  };

  // Newest first, as the query asks for them; one deleted, one hidden
  const history = () => [
    {
      id: '66e2b4c1f0a9d83b5c7e2a43',
      conversationId: CONVERSATION_ID,
      senderId: OFFENDER_ID,
      content: 'This message was removed for breaking the community rules',
      isDeleted: true,
      isHidden: true,
      createdAt: new Date('2026-09-10T08:10:00.000Z'),
    },
    {
      id: '66e2b4c1f0a9d83b5c7e2a42',
      conversationId: CONVERSATION_ID,
      senderId: REPORTER_ID,
      content: 'No, I will only pay in the app',
      isDeleted: false,
      isHidden: false,
      createdAt: new Date('2026-09-10T08:05:00.000Z'),
    },
    {
      id: '66e2b4c1f0a9d83b5c7e2a41',
      conversationId: CONVERSATION_ID,
      senderId: OFFENDER_ID,
      content: 'Pay into my Opay account instead',
      isDeleted: false,
      isHidden: true,
      createdAt: new Date('2026-09-10T08:00:00.000Z'),
    },
  ];

  beforeEach(() => {
    db.message.findMany.mockResolvedValue(history());
    db.message.count.mockResolvedValue(3);
    db.user.findMany.mockResolvedValue([reporterSender, offenderSender]);
    auditLog.mockResolvedValue({});
  });

  it('throws NOT_FOUND for a report that does not exist', async () => {
    db.report.findUnique.mockResolvedValue(null);

    await expect(getReportedConversationMessages(REPORT_ID, admin)).rejects.toMatchObject(code('NOT_FOUND'));
    expect(auditLog).not.toHaveBeenCalled();
    expect(db.message.findMany).not.toHaveBeenCalled();
  });

  it('throws NOT_FOUND for an id that is not an ObjectId, without a lookup', async () => {
    await expect(getReportedConversationMessages('nope', admin)).rejects.toMatchObject(code('NOT_FOUND'));
    expect(db.report.findUnique).not.toHaveBeenCalled();
  });

  it.each(['USER', 'REVIEW', 'SERVICE', 'PROVIDER'] as ReportTargetType[])(
    'refuses a report about a %s with BAD_REQUEST, logging and reading nothing',
    async (targetType) => {
      db.report.findUnique.mockResolvedValue(makeReport({ targetType, targetId: targets[targetType].id }));

      await expect(getReportedConversationMessages(REPORT_ID, admin)).rejects.toMatchObject(code('BAD_REQUEST'));
      expect(auditLog).not.toHaveBeenCalled();
      expect(db.message.findMany).not.toHaveBeenCalled();
      expect(db.message.count).not.toHaveBeenCalled();
    }
  );

  it('writes the access to the audit log before reading any messages', async () => {
    db.report.findUnique.mockResolvedValue(makeReport({ targetType: 'CONVERSATION', targetId: CONVERSATION_ID }));

    await getReportedConversationMessages(REPORT_ID, { id: SUPER_ADMIN_ID, role: 'SUPER_ADMIN' });

    expect(auditLog).toHaveBeenCalledTimes(1);
    expect(auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'VIEW_REPORTED_CONVERSATION',
        targetType: 'Conversation',
        targetId: CONVERSATION_ID,
        performedBy: SUPER_ADMIN_ID,
        performedByRole: 'SUPER_ADMIN',
        newValue: { reportId: REPORT_ID },
      })
    );
    const loggedAt = auditLog.mock.invocationCallOrder[0];
    expect(loggedAt).toBeLessThan(db.message.findMany.mock.invocationCallOrder[0]);
    expect(loggedAt).toBeLessThan(db.message.count.mock.invocationCallOrder[0]);
  });

  it('shows no messages when the access cannot be logged', async () => {
    db.report.findUnique.mockResolvedValue(makeReport({ targetType: 'CONVERSATION', targetId: CONVERSATION_ID }));
    auditLog.mockRejectedValue(new Error('database unavailable'));

    await expect(getReportedConversationMessages(REPORT_ID, admin)).rejects.toThrow('database unavailable');
    expect(db.message.findMany).not.toHaveBeenCalled();
  });

  it('includes deleted and hidden messages, oldest first, with their senders', async () => {
    db.report.findUnique.mockResolvedValue(makeReport({ targetType: 'CONVERSATION', targetId: CONVERSATION_ID }));

    const result = await getReportedConversationMessages(REPORT_ID, admin);

    // No isDeleted or isHidden filter
    expect(db.message.findMany).toHaveBeenCalledWith({
      where: { conversationId: CONVERSATION_ID },
      orderBy: { createdAt: 'desc' },
      skip: 0,
      take: 20,
    });
    expect(db.message.count).toHaveBeenCalledWith({ where: { conversationId: CONVERSATION_ID } });

    // A provider's business name comes from their provider profile
    const offender = {
      id: OFFENDER_ID,
      firstName: 'Emeka',
      lastName: 'Nwosu',
      profilePhoto: null,
      role: 'SERVICE_PROVIDER',
      businessName: 'Sparkle Cleaners',
    };
    const reporter = {
      id: REPORTER_ID,
      firstName: 'Ada',
      lastName: 'Obi',
      profilePhoto: null,
      role: 'SERVICE_USER',
      businessName: null,
    };

    const [newest, middle, oldest] = history();
    expect(result).toEqual({
      messages: [
        { ...oldest, sender: offender },
        { ...middle, sender: reporter },
        { ...newest, sender: offender },
      ],
      total: 3,
      page: 1,
      limit: 20,
      totalPages: 1,
      hasNextPage: false,
      hasPreviousPage: false,
    });
  });

  it('shows which messages are hidden, and messages saved without isHidden as not hidden', async () => {
    db.report.findUnique.mockResolvedValue(makeReport({ targetType: 'CONVERSATION', targetId: CONVERSATION_ID }));

    const stored = await getReportedConversationMessages(REPORT_ID, admin);
    expect(stored.messages.map((message) => message.isHidden)).toEqual([true, false, true]);

    db.message.findMany.mockResolvedValue(history().map(({ isHidden: _isHidden, ...message }) => message));

    const older = await getReportedConversationMessages(REPORT_ID, admin);
    expect(older.messages.map((message) => message.isHidden)).toEqual([false, false, false]);
  });

  it('shows no sender for a user who no longer exists', async () => {
    db.report.findUnique.mockResolvedValue(makeReport({ targetType: 'CONVERSATION', targetId: CONVERSATION_ID }));
    db.user.findMany.mockResolvedValue([reporterSender]);

    const result = await getReportedConversationMessages(REPORT_ID, admin);

    expect(result.messages.map((message) => message.sender)).toEqual([
      null,
      { id: REPORTER_ID, firstName: 'Ada', lastName: 'Obi', profilePhoto: null, role: 'SERVICE_USER', businessName: null },
      null,
    ]);
  });

  it('pages through the conversation', async () => {
    db.report.findUnique.mockResolvedValue(makeReport({ targetType: 'CONVERSATION', targetId: CONVERSATION_ID }));
    db.message.count.mockResolvedValue(45);

    const result = await getReportedConversationMessages(REPORT_ID, admin, { page: 2, limit: 20 });

    expect(db.message.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 20, take: 20 }));
    expect(result).toMatchObject({ total: 45, page: 2, totalPages: 3, hasNextPage: true, hasPreviousPage: true });
  });

  it("uses the reported message's conversation", async () => {
    db.report.findUnique.mockResolvedValue(
      makeReport({ snapshot: JSON.stringify({ conversationId: OTHER_CONVERSATION_ID }) })
    );
    db.message.findUnique.mockResolvedValue({ conversationId: CONVERSATION_ID });

    await getReportedConversationMessages(REPORT_ID, admin);

    expect(db.message.findUnique).toHaveBeenCalledWith({ where: { id: MESSAGE_ID }, select: { conversationId: true } });
    expect(auditLog).toHaveBeenCalledWith(expect.objectContaining({ targetId: CONVERSATION_ID }));
    expect(db.message.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { conversationId: CONVERSATION_ID } }));
  });

  it('falls back to the conversation in the copy when the message was deleted', async () => {
    db.report.findUnique.mockResolvedValue(
      makeReport({ snapshot: JSON.stringify({ conversationId: OTHER_CONVERSATION_ID, content: 'Pay me directly' }) })
    );
    db.message.findUnique.mockResolvedValue(null);

    await getReportedConversationMessages(REPORT_ID, admin);

    expect(auditLog).toHaveBeenCalledWith(expect.objectContaining({ targetId: OTHER_CONVERSATION_ID }));
    expect(db.message.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { conversationId: OTHER_CONVERSATION_ID } })
    );
    expect(db.message.count).toHaveBeenCalledWith({ where: { conversationId: OTHER_CONVERSATION_ID } });
  });

  it.each([['not json'], [JSON.stringify({ content: 'Pay me directly' })], [JSON.stringify({ conversationId: 42 })]])(
    'throws BAD_REQUEST when the message was deleted and the copy %p has no conversation',
    async (snapshot) => {
      db.report.findUnique.mockResolvedValue(makeReport({ snapshot }));
      db.message.findUnique.mockResolvedValue(null);

      await expect(getReportedConversationMessages(REPORT_ID, admin)).rejects.toMatchObject(code('BAD_REQUEST'));
      expect(auditLog).not.toHaveBeenCalled();
      expect(db.message.findMany).not.toHaveBeenCalled();
    }
  );
});

describe('reporting a review an admin removed', () => {
  it('treats it as not found and saves no report', async () => {
    db.report.findFirst.mockResolvedValue(null);
    db.report.count.mockResolvedValue(0);
    db.review.findUnique.mockResolvedValue(reviewOf({ deletedAt: new Date('2026-09-11T10:00:00.000Z') }));

    await expect(
      createReport(REPORTER_ID, { targetType: 'REVIEW', targetId: REVIEW_ID, reason: 'HATE' })
    ).rejects.toMatchObject({
      message: 'The content you reported could not be found',
      ...code('NOT_FOUND'),
    });
    expect(db.review.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: REVIEW_ID }, select: expect.objectContaining({ deletedAt: true }) })
    );
    expect(db.report.create).not.toHaveBeenCalled();
    expect(notifyMany).not.toHaveBeenCalled();
  });

  it('still accepts a report of a review that was not removed', async () => {
    db.report.findFirst.mockResolvedValue(null);
    db.report.count.mockResolvedValue(0);
    db.report.findMany.mockResolvedValue([]);
    db.user.findMany.mockResolvedValue([]);
    db.review.findUnique.mockResolvedValue(reviewOf({ deletedAt: null }));
    db.report.create.mockResolvedValue(makeReport({ targetType: 'REVIEW', targetId: REVIEW_ID, reason: 'HATE' }));

    await expect(
      createReport(REPORTER_ID, { targetType: 'REVIEW', targetId: REVIEW_ID, reason: 'HATE' })
    ).resolves.toMatchObject({ targetType: 'REVIEW', status: 'OPEN' });
  });
});

// ==================
// resolveReport
// ==================

describe('resolveReport', () => {
  const admin = { id: ADMIN_ID, role: 'ADMIN' };
  const NOTES = 'Asked the customer to pay outside the app';
  // What the reported user is told instead of the notes (makeReport's reason is OFF_PLATFORM_PAYMENT)
  const UPHELD = 'A report about asking for payment outside Easykonnet was upheld after review';

  // The open reports on the content when the claim runs
  const openReports = [
    { id: REPORT_ID, reporterId: REPORTER_ID },
    { id: SECOND_REPORT_ID, reporterId: OTHER_REPORTER_ID },
    // Raised by the content filter
    { id: THIRD_REPORT_ID, reporterId: null },
    { id: FOURTH_REPORT_ID, reporterId: REPORTER_ID },
  ];
  const openReportIds = openReports.map((open) => open.id);

  const REOPENED = { status: 'OPEN', action: null, resolutionNotes: null, handledBy: null, handledAt: null };

  // The transaction client the claim runs with
  const tx = { report: { findMany: jest.fn(), updateMany: jest.fn() } };

  const reportOn = (targetType: ReportTargetType, overrides: Partial<Report> = {}) =>
    makeReport({ targetType, targetId: targets[targetType].id, ...overrides });

  /** The report being decided, the open reports on the same content, and the content itself */
  const deciding = (report: Report) => {
    db.report.findUnique.mockResolvedValue(report);
    db.$transaction.mockImplementation(async (run: (client: typeof tx) => Promise<unknown>) => run(tx));
    tx.report.findMany.mockResolvedValue(openReports);
    tx.report.updateMany.mockResolvedValue({ count: openReports.length });
    // Reopening after a failed action
    db.report.updateMany.mockResolvedValue({ count: openReports.length });
    db.report.findFirst.mockResolvedValue(null);
    db.user.findMany.mockResolvedValue([]);
    db.report.groupBy.mockResolvedValue([]);
    db.message.updateMany.mockResolvedValue({ count: 1 });
    db.message.findUnique.mockResolvedValue({ conversationId: CONVERSATION_ID });
    db.review.updateMany.mockResolvedValue({ count: 1 });
    db.service.findUnique.mockResolvedValue({ id: SERVICE_ID });
  };

  /** The claim's updateMany arguments */
  const claimUpdate = () => tx.report.updateMany.mock.calls[0][0];

  /** Nothing was claimed, reopened, logged or announced */
  const expectUndecided = () => {
    expect(tx.report.updateMany).not.toHaveBeenCalled();
    expect(db.report.updateMany).not.toHaveBeenCalled();
    expect(auditLog).not.toHaveBeenCalled();
    expect(notifyMany).not.toHaveBeenCalled();
  };

  /** Every open report on the content was claimed with the decision in one transaction, and nothing reopened */
  const expectDecided = (
    report: Report,
    status: Report['status'],
    action: ModerationAction,
    { handledBy = ADMIN_ID, claimedIds = openReportIds }: { handledBy?: string; claimedIds?: string[] } = {}
  ) => {
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.report.findMany).toHaveBeenCalledWith({
      where: { targetType: report.targetType, targetId: report.targetId, status: 'OPEN' },
      select: { id: true, reporterId: true },
    });
    expect(tx.report.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.report.updateMany).toHaveBeenCalledWith({
      where: { id: { in: claimedIds }, status: 'OPEN' },
      data: expect.objectContaining({ status, action, handledBy }),
    });
    // Nothing is closed after acting, and nothing is reopened
    expect(db.report.updateMany).not.toHaveBeenCalled();
  };

  /** The claim was undone after the action failed, and nothing was logged or announced */
  const expectReopened = (claimedIds: string[] = openReportIds, handledBy: string = ADMIN_ID) => {
    expect(tx.report.updateMany).toHaveBeenCalledTimes(1);
    const claim = claimUpdate();
    expect(claim.where).toEqual({ id: { in: claimedIds }, status: 'OPEN' });
    expect(db.report.updateMany).toHaveBeenCalledTimes(1);
    expect(db.report.updateMany).toHaveBeenCalledWith({
      where: { id: { in: claimedIds }, handledBy, handledAt: claim.data.handledAt },
      data: REOPENED,
    });
    expect(auditLog).not.toHaveBeenCalled();
    expect(notifyMany).not.toHaveBeenCalled();
  };

  describe('checks', () => {
    it.each([[''], ['    '], ['Spam'], ['  abcd  ']])('refuses notes %p shorter than 5 characters', async (notes) => {
      deciding(reportOn('MESSAGE'));

      await expect(resolveReport(REPORT_ID, admin, { action: 'DISMISS', notes })).rejects.toMatchObject(
        code('INVALID_INPUT')
      );
      expect(db.report.findUnique).not.toHaveBeenCalled();
      expect(db.$transaction).not.toHaveBeenCalled();
      expectUndecided();
    });

    it('accepts notes of 5 characters', async () => {
      deciding(reportOn('MESSAGE'));

      await expect(resolveReport(REPORT_ID, admin, { action: 'DISMISS', notes: ' Spam! ' })).resolves.toMatchObject({
        id: REPORT_ID,
      });
    });

    it.each([[0], [366], [-7], [1.5], [Number.NaN]])('refuses a duration of %p days', async (durationDays) => {
      deciding(reportOn('USER'));

      await expect(
        resolveReport(REPORT_ID, admin, { action: 'RESTRICT_USER', notes: NOTES, durationDays })
      ).rejects.toMatchObject(code('INVALID_INPUT'));
      expect(db.report.findUnique).not.toHaveBeenCalled();
      expect(db.$transaction).not.toHaveBeenCalled();
      expect(restrict).not.toHaveBeenCalled();
      expectUndecided();
    });

    it.each([[1], [365]])('accepts a duration of %p days', async (durationDays) => {
      deciding(reportOn('USER'));

      await resolveReport(REPORT_ID, admin, { action: 'RESTRICT_USER', notes: NOTES, durationDays });

      expect(restrict).toHaveBeenCalledWith(expect.objectContaining({ days: durationDays }), ADMIN_ID, 'ADMIN');
    });

    it('throws NOT_FOUND for a report that does not exist', async () => {
      deciding(reportOn('MESSAGE'));
      db.report.findUnique.mockResolvedValue(null);

      await expect(resolveReport(REPORT_ID, admin, { action: 'DISMISS', notes: NOTES })).rejects.toMatchObject(
        code('NOT_FOUND')
      );
      expect(db.$transaction).not.toHaveBeenCalled();
      expectUndecided();
    });

    it('throws NOT_FOUND for an id that is not an ObjectId, without a lookup', async () => {
      await expect(resolveReport('not-a-report', admin, { action: 'DISMISS', notes: NOTES })).rejects.toMatchObject(
        code('NOT_FOUND')
      );
      expect(db.report.findUnique).not.toHaveBeenCalled();
      expect(db.$transaction).not.toHaveBeenCalled();
      expectUndecided();
    });

    const handled: Array<[Report['status'], ModerationAction]> = [
      ['ACTIONED', 'BAN_USER'],
      ['DISMISSED', 'DISMISS'],
    ];

    it.each(handled)('throws ALREADY_RESOLVED for a report already %s', async (status, action) => {
      deciding(reportOn('USER', { status, action, handledBy: SUPER_ADMIN_ID, handledAt: new Date() }));

      await expect(resolveReport(REPORT_ID, admin, { action: 'BAN_USER', notes: NOTES })).rejects.toMatchObject(
        code('ALREADY_RESOLVED')
      );
      expect(db.$transaction).not.toHaveBeenCalled();
      expect(ban).not.toHaveBeenCalled();
      expectUndecided();
    });
  });

  describe('claiming the reports', () => {
    it('claims every open report on the content in one transaction, with the decision, before acting', async () => {
      deciding(reportOn('USER'));

      await resolveReport(REPORT_ID, admin, { action: 'BAN_USER', notes: NOTES, durationDays: 14 });

      expect(db.$transaction).toHaveBeenCalledTimes(1);
      expect(tx.report.findMany).toHaveBeenCalledWith({
        where: { targetType: 'USER', targetId: OFFENDER_ID, status: 'OPEN' },
        select: { id: true, reporterId: true },
      });
      expect(tx.report.updateMany).toHaveBeenCalledWith({
        where: { id: { in: openReportIds }, status: 'OPEN' },
        data: {
          status: 'ACTIONED',
          action: 'BAN_USER',
          resolutionNotes: NOTES,
          handledBy: ADMIN_ID,
          handledAt: expect.any(Date),
        },
      });
      expect(tx.report.findMany.mock.invocationCallOrder[0]).toBeLessThan(tx.report.updateMany.mock.invocationCallOrder[0]);
      expect(tx.report.updateMany.mock.invocationCallOrder[0]).toBeLessThan(ban.mock.invocationCallOrder[0]);
      // Read and written only inside the transaction; nothing is closed afterwards
      expect(db.report.findMany).not.toHaveBeenCalled();
      expect(db.report.updateMany).not.toHaveBeenCalled();
    });

    it('counts and notifies from the reports it claimed', async () => {
      const report = reportOn('MESSAGE');
      deciding(report);
      tx.report.findMany.mockResolvedValue([
        { id: SECOND_REPORT_ID, reporterId: THIRD_REPORTER_ID },
        { id: REPORT_ID, reporterId: REPORTER_ID },
        { id: THIRD_REPORT_ID, reporterId: null },
      ]);

      await resolveReport(REPORT_ID, admin, { action: 'REMOVE_CONTENT', notes: NOTES });

      expectDecided(report, 'ACTIONED', 'REMOVE_CONTENT', {
        claimedIds: [SECOND_REPORT_ID, REPORT_ID, THIRD_REPORT_ID],
      });
      expect(auditLog).toHaveBeenCalledWith(
        expect.objectContaining({ previousValue: { status: 'OPEN', reportCount: 3 } })
      );
      expect(notifyMany).toHaveBeenCalledTimes(1);
      expect(notifyMany.mock.calls[0][0]).toEqual([THIRD_REPORTER_ID, REPORTER_ID]);
    });

    it('gets ALREADY_RESOLVED when another decision on the same content already closed this report', async () => {
      deciding(reportOn('MESSAGE'));
      // Read as open, but another admin's decision on the message closed it; only a newer report is open now
      tx.report.findMany.mockResolvedValue([{ id: NEW_REPORT_ID, reporterId: THIRD_REPORTER_ID }]);

      await expect(resolveReport(REPORT_ID, admin, { action: 'REMOVE_CONTENT', notes: NOTES })).rejects.toMatchObject(
        code('ALREADY_RESOLVED')
      );

      // The newer report is left open for its own decision
      expect(db.message.updateMany).not.toHaveBeenCalled();
      expect(previewRefresh).not.toHaveBeenCalled();
      expectUndecided();
    });

    const decisions: Array<[ReportTargetType, ModerationAction]> = [
      ['USER', 'BAN_USER'],
      ['USER', 'RESTRICT_USER'],
      ['MESSAGE', 'WARN_USER'],
      ['MESSAGE', 'REMOVE_CONTENT'],
      ['REVIEW', 'REMOVE_CONTENT'],
      ['SERVICE', 'SUSPEND_SERVICE'],
      ['MESSAGE', 'DISMISS'],
      ['REVIEW', 'DISMISS'],
    ];

    it.each(decisions)(
      'a %s report with nothing left to claim gets ALREADY_RESOLVED for %s, with nothing done, logged or announced',
      async (targetType, action) => {
        deciding(reportOn(targetType));
        tx.report.findMany.mockResolvedValue([]);

        await expect(resolveReport(REPORT_ID, admin, { action, notes: NOTES })).rejects.toMatchObject(
          code('ALREADY_RESOLVED')
        );

        expect(ban).not.toHaveBeenCalled();
        expect(restrict).not.toHaveBeenCalled();
        expect(notify).not.toHaveBeenCalled();
        expect(db.message.updateMany).not.toHaveBeenCalled();
        expect(db.review.updateMany).not.toHaveBeenCalled();
        expect(db.service.findUnique).not.toHaveBeenCalled();
        expect(suspend).not.toHaveBeenCalled();
        expect(previewRefresh).not.toHaveBeenCalled();
        expectUndecided();
      }
    );

    it('retries the claim after a write conflict with another admin, then finds nothing left to claim', async () => {
      deciding(reportOn('USER'));
      db.$transaction.mockImplementationOnce(async () => {
        throw new Error('WriteConflict error: this operation conflicted with another operation');
      });
      // The other admin's decision closed the reports
      tx.report.findMany.mockResolvedValue([]);

      await expect(resolveReport(REPORT_ID, admin, { action: 'BAN_USER', notes: NOTES })).rejects.toMatchObject(
        code('ALREADY_RESOLVED')
      );

      expect(db.$transaction).toHaveBeenCalledTimes(2);
      expect(ban).not.toHaveBeenCalled();
      expectUndecided();
    });
  });

  describe('DISMISS', () => {
    it('dismisses every open report on the content and shows an auto-hidden message again', async () => {
      deciding(reportOn('MESSAGE'));

      await resolveReport(REPORT_ID, admin, { action: 'DISMISS', notes: 'Normal price negotiation' });

      expect(tx.report.findMany).toHaveBeenCalledWith({
        where: { targetType: 'MESSAGE', targetId: MESSAGE_ID, status: 'OPEN' },
        select: { id: true, reporterId: true },
      });
      expect(tx.report.updateMany).toHaveBeenCalledWith({
        where: { id: { in: openReportIds }, status: 'OPEN' },
        data: {
          status: 'DISMISSED',
          action: 'DISMISS',
          resolutionNotes: 'Normal price negotiation',
          handledBy: ADMIN_ID,
          handledAt: expect.any(Date),
        },
      });
      expect(db.report.updateMany).not.toHaveBeenCalled();
      expect(db.report.findFirst).toHaveBeenCalledWith({
        where: { targetType: 'MESSAGE', targetId: MESSAGE_ID, status: 'ACTIONED', action: 'REMOVE_CONTENT' },
        select: { id: true },
      });
      expect(db.message.updateMany).toHaveBeenCalledTimes(1);
      expect(db.message.updateMany).toHaveBeenCalledWith({
        where: { id: MESSAGE_ID, isDeleted: false },
        data: { isHidden: false },
      });
      expect(tx.report.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
        db.message.updateMany.mock.invocationCallOrder[0]
      );

      // Nobody is punished
      expect(notify).not.toHaveBeenCalled();
      expect(suspend).not.toHaveBeenCalled();
      expect(restrict).not.toHaveBeenCalled();
      expect(ban).not.toHaveBeenCalled();
    });

    it("refreshes the conversation's preview after showing a message again", async () => {
      deciding(reportOn('MESSAGE'));

      await resolveReport(REPORT_ID, admin, { action: 'DISMISS', notes: 'Normal price negotiation' });

      expect(db.message.findUnique).toHaveBeenCalledWith({ where: { id: MESSAGE_ID }, select: { conversationId: true } });
      expect(previewRefresh).toHaveBeenCalledTimes(1);
      expect(previewRefresh).toHaveBeenCalledWith(CONVERSATION_ID);
      expect(db.message.updateMany.mock.invocationCallOrder[0]).toBeLessThan(previewRefresh.mock.invocationCallOrder[0]);
    });

    it('refreshes the conversation from the copy when the message is gone', async () => {
      deciding(reportOn('MESSAGE', { snapshot: JSON.stringify({ conversationId: OTHER_CONVERSATION_ID }) }));
      db.message.findUnique.mockResolvedValue(null);
      db.message.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        resolveReport(REPORT_ID, admin, { action: 'DISMISS', notes: 'Normal price negotiation' })
      ).resolves.toMatchObject({ id: REPORT_ID });
      expect(previewRefresh).toHaveBeenCalledWith(OTHER_CONVERSATION_ID);
    });

    it('still dismisses, logs and tells the reporters when the preview cannot be refreshed', async () => {
      const report = reportOn('MESSAGE');
      deciding(report);
      previewRefresh.mockRejectedValue(new Error('conversation update failed'));
      const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);

      await expect(
        resolveReport(REPORT_ID, admin, { action: 'DISMISS', notes: 'Normal price negotiation' })
      ).resolves.toMatchObject({ id: REPORT_ID });
      expectDecided(report, 'DISMISSED', 'DISMISS');
      expect(auditLog).toHaveBeenCalledTimes(1);
      expect(notifyMany).toHaveBeenCalledTimes(1);
      expect(consoleError).toHaveBeenCalled();
    });

    it('shows an auto-hidden review again, with no preview to refresh', async () => {
      const report = reportOn('REVIEW');
      deciding(report);

      await resolveReport(REPORT_ID, admin, { action: 'DISMISS', notes: 'Honest, if harsh, review' });

      expectDecided(report, 'DISMISSED', 'DISMISS');
      // A review an admin removed stays removed
      expect(db.review.updateMany).toHaveBeenCalledWith({
        where: { id: REVIEW_ID, OR: [{ deletedAt: null }, { deletedAt: { isSet: false } }] },
        data: { isHidden: false },
      });
      expect(db.review.update).not.toHaveBeenCalled();
      expect(previewRefresh).not.toHaveBeenCalled();
    });

    it.each(['MESSAGE', 'REVIEW'] as ReportTargetType[])(
      'keeps a %s hidden when an admin removed it on an earlier report',
      async (targetType) => {
        const report = reportOn(targetType);
        deciding(report);
        db.report.findFirst.mockResolvedValue({ id: EARLIER_REPORT_ID });

        await resolveReport(REPORT_ID, admin, { action: 'DISMISS', notes: 'Same as the earlier report' });

        expectDecided(report, 'DISMISSED', 'DISMISS');
        expect(db.message.updateMany).not.toHaveBeenCalled();
        expect(db.review.updateMany).not.toHaveBeenCalled();
        expect(previewRefresh).not.toHaveBeenCalled();
      }
    );

    it.each(['USER', 'CONVERSATION', 'SERVICE', 'PROVIDER'] as ReportTargetType[])(
      'changes no content for a reported %s',
      async (targetType) => {
        const report = reportOn(targetType);
        deciding(report);

        await resolveReport(REPORT_ID, admin, { action: 'DISMISS', notes: 'Nothing against the rules' });

        expectDecided(report, 'DISMISSED', 'DISMISS');
        expect(db.message.updateMany).not.toHaveBeenCalled();
        expect(db.review.updateMany).not.toHaveBeenCalled();
        expect(previewRefresh).not.toHaveBeenCalled();
      }
    );
  });

  describe('REMOVE_CONTENT', () => {
    it("deletes and hides a message, replaces its text and refreshes the conversation's preview", async () => {
      const report = reportOn('MESSAGE');
      deciding(report);

      const before = Date.now();
      await resolveReport(REPORT_ID, admin, { action: 'REMOVE_CONTENT', notes: NOTES });

      expect(db.message.updateMany).toHaveBeenCalledTimes(1);
      expect(db.message.updateMany).toHaveBeenCalledWith({
        where: { id: MESSAGE_ID },
        data: {
          isDeleted: true,
          isHidden: true,
          deletedAt: expect.any(Date),
          content: expect.stringMatching(/removed/),
        },
      });
      const [{ data }] = db.message.updateMany.mock.calls[0];
      expect(data.content).not.toContain('Opay');
      expect(data.deletedAt.getTime()).toBeGreaterThanOrEqual(before);
      expect(previewRefresh).toHaveBeenCalledTimes(1);
      expect(previewRefresh).toHaveBeenCalledWith(CONVERSATION_ID);
      expect(db.message.updateMany.mock.invocationCallOrder[0]).toBeLessThan(previewRefresh.mock.invocationCallOrder[0]);
      expectDecided(report, 'ACTIONED', 'REMOVE_CONTENT');
    });

    it('closes the reports on a message that is already gone, with no preview to refresh', async () => {
      const report = reportOn('MESSAGE');
      deciding(report);
      db.message.updateMany.mockResolvedValue({ count: 0 });
      db.message.findUnique.mockResolvedValue(null);

      await expect(resolveReport(REPORT_ID, admin, { action: 'REMOVE_CONTENT', notes: NOTES })).resolves.toMatchObject({
        id: REPORT_ID,
      });
      expectDecided(report, 'ACTIONED', 'REMOVE_CONTENT');
      expect(previewRefresh).not.toHaveBeenCalled();
      expect(auditLog).toHaveBeenCalledTimes(1);
      expect(notifyMany).toHaveBeenCalledTimes(1);
    });

    it('still removes the message, logs and tells the reporters when the preview cannot be refreshed', async () => {
      const report = reportOn('MESSAGE');
      deciding(report);
      previewRefresh.mockRejectedValue(new Error('conversation update failed'));
      const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);

      await expect(resolveReport(REPORT_ID, admin, { action: 'REMOVE_CONTENT', notes: NOTES })).resolves.toMatchObject({
        id: REPORT_ID,
      });
      expectDecided(report, 'ACTIONED', 'REMOVE_CONTENT');
      expect(auditLog).toHaveBeenCalledTimes(1);
      expect(notifyMany).toHaveBeenCalledTimes(1);
      expect(consoleError).toHaveBeenCalled();
    });

    it('hides a review', async () => {
      const report = reportOn('REVIEW');
      deciding(report);

      await resolveReport(REPORT_ID, admin, { action: 'REMOVE_CONTENT', notes: NOTES });

      expect(db.review.updateMany).toHaveBeenCalledWith({ where: { id: REVIEW_ID }, data: { isHidden: true } });
      expect(db.review.update).not.toHaveBeenCalled();
      expect(previewRefresh).not.toHaveBeenCalled();
      expectDecided(report, 'ACTIONED', 'REMOVE_CONTENT');
    });

    it('closes the reports on a review that is already gone', async () => {
      const report = reportOn('REVIEW');
      deciding(report);
      db.review.updateMany.mockResolvedValue({ count: 0 });

      await expect(resolveReport(REPORT_ID, admin, { action: 'REMOVE_CONTENT', notes: NOTES })).resolves.toMatchObject({
        id: REPORT_ID,
      });
      expectDecided(report, 'ACTIONED', 'REMOVE_CONTENT');
      expect(auditLog).toHaveBeenCalledTimes(1);
    });

    it('suspends a service', async () => {
      const report = reportOn('SERVICE');
      deciding(report);

      await resolveReport(REPORT_ID, admin, { action: 'REMOVE_CONTENT', notes: NOTES });

      expect(db.service.findUnique).toHaveBeenCalledWith({ where: { id: SERVICE_ID }, select: { id: true, status: true } });
      expect(suspend).toHaveBeenCalledWith(SERVICE_ID, UPHELD, { id: ADMIN_ID, role: 'ADMIN' });
      expectDecided(report, 'ACTIONED', 'REMOVE_CONTENT');
    });

    it('closes the reports on a service that is already gone, without suspending anything', async () => {
      const report = reportOn('SERVICE');
      deciding(report);
      db.service.findUnique.mockResolvedValue(null);

      await expect(resolveReport(REPORT_ID, admin, { action: 'REMOVE_CONTENT', notes: NOTES })).resolves.toMatchObject({
        id: REPORT_ID,
      });
      expect(suspend).not.toHaveBeenCalled();
      expectDecided(report, 'ACTIONED', 'REMOVE_CONTENT');
    });

    it.each(['USER', 'PROVIDER', 'CONVERSATION'] as ReportTargetType[])(
      'is INVALID_MODERATION_ACTION for a reported %s, and the claim is undone',
      async (targetType) => {
        deciding(reportOn(targetType));

        await expect(
          resolveReport(REPORT_ID, admin, { action: 'REMOVE_CONTENT', notes: NOTES })
        ).rejects.toMatchObject(code('INVALID_MODERATION_ACTION'));

        expect(db.message.updateMany).not.toHaveBeenCalled();
        expect(db.review.updateMany).not.toHaveBeenCalled();
        expect(suspend).not.toHaveBeenCalled();
        expectReopened();
      }
    );
  });

  describe('SUSPEND_SERVICE', () => {
    it('suspends the reported service', async () => {
      const report = reportOn('SERVICE');
      deciding(report);

      await resolveReport(REPORT_ID, admin, { action: 'SUSPEND_SERVICE', notes: NOTES });

      expect(db.service.findUnique).toHaveBeenCalledWith({ where: { id: SERVICE_ID }, select: { id: true, status: true } });
      expect(suspend).toHaveBeenCalledWith(SERVICE_ID, UPHELD, { id: ADMIN_ID, role: 'ADMIN' });
      expectDecided(report, 'ACTIONED', 'SUSPEND_SERVICE');
    });

    it('closes the reports on a service that is already gone, without suspending anything', async () => {
      const report = reportOn('SERVICE');
      deciding(report);
      db.service.findUnique.mockResolvedValue(null);

      await expect(
        resolveReport(REPORT_ID, admin, { action: 'SUSPEND_SERVICE', notes: NOTES })
      ).resolves.toMatchObject({ id: REPORT_ID });
      expect(suspend).not.toHaveBeenCalled();
      expectDecided(report, 'ACTIONED', 'SUSPEND_SERVICE');
      expect(auditLog).toHaveBeenCalledTimes(1);
      expect(notifyMany).toHaveBeenCalledTimes(1);
    });

    it.each(['USER', 'MESSAGE', 'CONVERSATION', 'REVIEW', 'PROVIDER'] as ReportTargetType[])(
      'is INVALID_MODERATION_ACTION for a reported %s, and the claim is undone',
      async (targetType) => {
        deciding(reportOn(targetType));

        await expect(
          resolveReport(REPORT_ID, admin, { action: 'SUSPEND_SERVICE', notes: NOTES })
        ).rejects.toMatchObject(code('INVALID_MODERATION_ACTION'));

        expect(db.service.findUnique).not.toHaveBeenCalled();
        expect(suspend).not.toHaveBeenCalled();
        expectReopened();
      }
    );
  });

  describe('WARN_USER', () => {
    it('sends the responsible user a warning', async () => {
      const report = reportOn('MESSAGE');
      deciding(report);

      await resolveReport(REPORT_ID, admin, { action: 'WARN_USER', notes: NOTES });

      expect(notify).toHaveBeenCalledWith({
        userId: OFFENDER_ID,
        type: 'SYSTEM_ANNOUNCEMENT',
        title: 'A warning from Easykonnet',
        message: expect.any(String),
        entityType: 'report',
        entityId: REPORT_ID,
      });
      expectDecided(report, 'ACTIONED', 'WARN_USER');
    });

    it('is INVALID_MODERATION_ACTION when no user is linked to the report, and the claim is undone', async () => {
      deciding(reportOn('MESSAGE', { reporterId: null, automated: true, targetUserId: null }));

      await expect(resolveReport(REPORT_ID, admin, { action: 'WARN_USER', notes: NOTES })).rejects.toMatchObject(
        code('INVALID_MODERATION_ACTION')
      );
      expect(notify).not.toHaveBeenCalled();
      expectReopened();
    });
  });

  describe('RESTRICT_USER', () => {
    it('restricts the responsible user for 7 days by default', async () => {
      const report = reportOn('USER');
      deciding(report);

      await resolveReport(REPORT_ID, admin, { action: 'RESTRICT_USER', notes: NOTES });

      expect(restrict).toHaveBeenCalledWith({ userId: OFFENDER_ID, reason: NOTES, userFacingReason: UPHELD, days: 7 }, ADMIN_ID, 'ADMIN');
      expectDecided(report, 'ACTIONED', 'RESTRICT_USER');
    });

    it('restricts for the number of days given, as the deciding admin', async () => {
      const report = reportOn('CONVERSATION');
      deciding(report);

      await resolveReport(
        REPORT_ID,
        { id: SUPER_ADMIN_ID, role: 'SUPER_ADMIN' },
        { action: 'RESTRICT_USER', notes: NOTES, durationDays: 30 }
      );

      expect(restrict).toHaveBeenCalledWith(
        { userId: OFFENDER_ID, reason: NOTES, userFacingReason: UPHELD, days: 30 },
        SUPER_ADMIN_ID,
        'SUPER_ADMIN'
      );
      expectDecided(report, 'ACTIONED', 'RESTRICT_USER', { handledBy: SUPER_ADMIN_ID });
    });

    it('is INVALID_MODERATION_ACTION when no user is linked to the report, and the claim is undone', async () => {
      deciding(reportOn('MESSAGE', { reporterId: null, automated: true, targetUserId: null }));

      await expect(
        resolveReport(REPORT_ID, admin, { action: 'RESTRICT_USER', notes: NOTES })
      ).rejects.toMatchObject(code('INVALID_MODERATION_ACTION'));
      expect(restrict).not.toHaveBeenCalled();
      expectReopened();
    });
  });

  describe('BAN_USER', () => {
    it('bans the responsible user for the number of days given', async () => {
      const report = reportOn('USER');
      deciding(report);

      await resolveReport(REPORT_ID, admin, { action: 'BAN_USER', notes: NOTES, durationDays: 14 });

      expect(ban).toHaveBeenCalledWith({ userId: OFFENDER_ID, reason: NOTES, userFacingReason: UPHELD, days: 14 }, ADMIN_ID, 'ADMIN');
      expectDecided(report, 'ACTIONED', 'BAN_USER');
    });

    it.each([[undefined], [null]])('bans permanently when the duration is %p', async (durationDays) => {
      deciding(reportOn('USER'));

      await resolveReport(REPORT_ID, admin, { action: 'BAN_USER', notes: NOTES, durationDays });

      expect(ban).toHaveBeenCalledTimes(1);
      const [input, adminId, adminRole] = ban.mock.calls[0];
      expect(input).toEqual({ userId: OFFENDER_ID, reason: NOTES, userFacingReason: UPHELD });
      expect(input.days).toBeUndefined();
      expect([adminId, adminRole]).toEqual([ADMIN_ID, 'ADMIN']);
    });

    it('is INVALID_MODERATION_ACTION when no user is linked to the report, and the claim is undone', async () => {
      deciding(reportOn('MESSAGE', { reporterId: null, automated: true, targetUserId: null }));

      await expect(resolveReport(REPORT_ID, admin, { action: 'BAN_USER', notes: NOTES })).rejects.toMatchObject(
        code('INVALID_MODERATION_ACTION')
      );
      expect(ban).not.toHaveBeenCalled();
      expectReopened();
    });
  });

  describe('what the reported user is told', () => {
    const wordings: Array<[Report['reason'], string]> = [
      ['HARASSMENT', 'A report about harassment was upheld after review'],
      ['HATE', 'A report about hate speech was upheld after review'],
      ['SEXUAL_CONTENT', 'A report about sexual content was upheld after review'],
      ['VIOLENCE', 'A report about violence was upheld after review'],
      ['SCAM', 'A report about a scam was upheld after review'],
      ['OFF_PLATFORM_PAYMENT', 'A report about asking for payment outside Easykonnet was upheld after review'],
      ['SPAM', 'A report about spam was upheld after review'],
      ['IMPERSONATION', 'A report about impersonation was upheld after review'],
      ['OTHER', 'A report about breaking the community rules was upheld after review'],
    ];

    it.each(wordings)('a %s report reads "%s"', (reason, wording) => {
      expect(reasonForReportedUser(reason)).toBe(wording);
    });

    it("restricts with the report's reason for the user, and keeps the notes for the account and audit log", async () => {
      deciding(reportOn('USER', { reason: 'SCAM' }));

      await resolveReport(REPORT_ID, admin, { action: 'RESTRICT_USER', notes: NOTES });

      expect(restrict).toHaveBeenCalledWith(
        { userId: OFFENDER_ID, reason: NOTES, userFacingReason: 'A report about a scam was upheld after review', days: 7 },
        ADMIN_ID,
        'ADMIN'
      );
    });

    it("suspends a service with the report's reason, never the notes, as the deciding admin", async () => {
      deciding(reportOn('SERVICE', { reason: 'SPAM' }));

      await resolveReport(REPORT_ID, { id: SUPER_ADMIN_ID, role: 'SUPER_ADMIN' }, { action: 'SUSPEND_SERVICE', notes: NOTES });

      expect(suspend).toHaveBeenCalledWith(SERVICE_ID, 'A report about spam was upheld after review', {
        id: SUPER_ADMIN_ID,
        role: 'SUPER_ADMIN',
      });
    });
  });

  describe('a service that is already suspended', () => {
    it.each(['REMOVE_CONTENT', 'SUSPEND_SERVICE'] as ModerationAction[])(
      '%s closes the reports without suspending it again',
      async (action) => {
        const report = reportOn('SERVICE');
        deciding(report);
        db.service.findUnique.mockResolvedValue({ id: SERVICE_ID, status: 'SUSPENDED' });

        await expect(resolveReport(REPORT_ID, admin, { action, notes: NOTES })).resolves.toMatchObject({ id: REPORT_ID });
        expect(suspend).not.toHaveBeenCalled();
        expectDecided(report, 'ACTIONED', action);
      }
    );

    it('closes the reports when someone suspended it a moment earlier', async () => {
      const report = reportOn('SERVICE');
      deciding(report);
      suspend.mockRejectedValue(
        new GraphQLError('Service is already suspended', { extensions: { code: 'ALREADY_SUSPENDED' } })
      );

      await expect(
        resolveReport(REPORT_ID, admin, { action: 'SUSPEND_SERVICE', notes: NOTES })
      ).resolves.toMatchObject({ id: REPORT_ID });
      expectDecided(report, 'ACTIONED', 'SUSPEND_SERVICE');
      expect(auditLog).toHaveBeenCalledTimes(1);
      expect(notifyMany).toHaveBeenCalledTimes(1);
    });
  });

  describe('a review an admin has since removed', () => {
    it('REMOVE_CONTENT closes the reports', async () => {
      const report = reportOn('REVIEW');
      deciding(report);

      await expect(
        resolveReport(REPORT_ID, admin, { action: 'REMOVE_CONTENT', notes: NOTES })
      ).resolves.toMatchObject({ id: REPORT_ID });
      expectDecided(report, 'ACTIONED', 'REMOVE_CONTENT');
      expect(auditLog).toHaveBeenCalledTimes(1);
    });

    it('DISMISS closes the reports without showing the review again', async () => {
      const report = reportOn('REVIEW');
      deciding(report);
      // The removed review doesn't match the update
      db.review.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        resolveReport(REPORT_ID, admin, { action: 'DISMISS', notes: 'It was removed already' })
      ).resolves.toMatchObject({ id: REPORT_ID });
      expectDecided(report, 'DISMISSED', 'DISMISS');
      expect(db.review.updateMany).toHaveBeenCalledWith({
        where: { id: REVIEW_ID, OR: [{ deletedAt: null }, { deletedAt: { isSet: false } }] },
        data: { isHidden: false },
      });
      expect(auditLog).toHaveBeenCalledTimes(1);
    });
  });

  describe('after the decision', () => {
    it('undoes the claim, by the same admin at the same time, and passes the error on when the action fails', async () => {
      deciding(reportOn('USER'));
      const refused = new GraphQLError('You do not have permission to ban this user', {
        extensions: { code: 'FORBIDDEN' },
      });
      ban.mockRejectedValue(refused);

      await expect(resolveReport(REPORT_ID, admin, { action: 'BAN_USER', notes: NOTES })).rejects.toBe(refused);

      expectReopened();
      const [{ where: reopenWhere }] = db.report.updateMany.mock.calls[0];
      expect(reopenWhere.handledAt).toBe(claimUpdate().data.handledAt);
      expect(tx.report.updateMany.mock.invocationCallOrder[0]).toBeLessThan(ban.mock.invocationCallOrder[0]);
      expect(ban.mock.invocationCallOrder[0]).toBeLessThan(db.report.updateMany.mock.invocationCallOrder[0]);
    });

    it('reopens only the reports it claimed', async () => {
      deciding(reportOn('USER'));
      tx.report.findMany.mockResolvedValue([
        { id: REPORT_ID, reporterId: REPORTER_ID },
        { id: SECOND_REPORT_ID, reporterId: OTHER_REPORTER_ID },
      ]);
      restrict.mockRejectedValue(new GraphQLError('User not found', { extensions: { code: 'NOT_FOUND' } }));

      await expect(
        resolveReport(REPORT_ID, admin, { action: 'RESTRICT_USER', notes: NOTES })
      ).rejects.toMatchObject(code('NOT_FOUND'));
      expectReopened([REPORT_ID, SECOND_REPORT_ID]);
    });

    it('still passes the original error on when the reports cannot be reopened', async () => {
      deciding(reportOn('USER'));
      const refused = new GraphQLError('You do not have permission to ban this user', {
        extensions: { code: 'FORBIDDEN' },
      });
      ban.mockRejectedValue(refused);
      db.report.updateMany.mockRejectedValue(new Error('database unavailable'));
      const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);

      await expect(resolveReport(REPORT_ID, admin, { action: 'BAN_USER', notes: NOTES })).rejects.toBe(refused);

      expect(db.report.updateMany).toHaveBeenCalledTimes(1);
      expect(consoleError).toHaveBeenCalled();
      expect(auditLog).not.toHaveBeenCalled();
      expect(notifyMany).not.toHaveBeenCalled();
    });

    it('undoes the claim when the service cannot be suspended', async () => {
      deciding(reportOn('SERVICE'));
      suspend.mockRejectedValue(new GraphQLError('Service not found', { extensions: { code: 'NOT_FOUND' } }));

      await expect(
        resolveReport(REPORT_ID, admin, { action: 'SUSPEND_SERVICE', notes: NOTES })
      ).rejects.toMatchObject(code('NOT_FOUND'));
      expectReopened();
    });

    it('undoes the claim when the warning cannot be sent', async () => {
      deciding(reportOn('MESSAGE'));
      notify.mockRejectedValue(new Error('database unavailable'));

      await expect(resolveReport(REPORT_ID, admin, { action: 'WARN_USER', notes: NOTES })).rejects.toThrow(
        'database unavailable'
      );
      expectReopened();
    });

    it('records the decision on every claimed report: sanitized notes, who decided and when', async () => {
      const safeNotes = 'Sent threats  twice';
      const report = reportOn('SERVICE');
      deciding(report);
      db.report.findUnique.mockResolvedValueOnce(report).mockResolvedValueOnce(
        reportOn('SERVICE', {
          status: 'ACTIONED',
          action: 'SUSPEND_SERVICE',
          resolutionNotes: safeNotes,
          handledBy: ADMIN_ID,
          handledAt: new Date('2026-09-12T10:00:00.000Z'),
        })
      );

      const before = Date.now();
      const result = await resolveReport(REPORT_ID, admin, {
        action: 'SUSPEND_SERVICE',
        notes: '  Sent <b>threats</b> <img src=x onerror=alert(1)> twice  ',
      });
      const after = Date.now();

      // The provider is told the report was upheld; the notes stay with the report
      expect(suspend).toHaveBeenCalledWith(SERVICE_ID, UPHELD, { id: ADMIN_ID, role: 'ADMIN' });
      expect(tx.report.updateMany).toHaveBeenCalledTimes(1);
      expect(tx.report.updateMany).toHaveBeenCalledWith({
        where: { id: { in: openReportIds }, status: 'OPEN' },
        data: {
          status: 'ACTIONED',
          action: 'SUSPEND_SERVICE',
          resolutionNotes: safeNotes,
          handledBy: ADMIN_ID,
          handledAt: expect.any(Date),
        },
      });
      const { handledAt } = claimUpdate().data;
      expect(handledAt.getTime()).toBeGreaterThanOrEqual(before);
      expect(handledAt.getTime()).toBeLessThanOrEqual(after);
      expect(tx.report.updateMany.mock.invocationCallOrder[0]).toBeLessThan(suspend.mock.invocationCallOrder[0]);
      expect(db.report.updateMany).not.toHaveBeenCalled();

      expect(result).toMatchObject({
        id: REPORT_ID,
        status: 'ACTIONED',
        action: 'SUSPEND_SERVICE',
        resolutionNotes: safeNotes,
        handledBy: ADMIN_ID,
        handledAt: '2026-09-12T10:00:00.000Z',
      });
    });

    it('writes RESOLVE_REPORT to the audit log', async () => {
      deciding(reportOn('USER'));

      await resolveReport(
        REPORT_ID,
        { id: SUPER_ADMIN_ID, role: 'SUPER_ADMIN' },
        { action: 'RESTRICT_USER', notes: NOTES, durationDays: 30 }
      );

      expect(auditLog).toHaveBeenCalledWith({
        action: 'RESOLVE_REPORT',
        targetType: 'Report',
        targetId: REPORT_ID,
        performedBy: SUPER_ADMIN_ID,
        performedByRole: 'SUPER_ADMIN',
        previousValue: { status: 'OPEN', reportCount: 4 },
        newValue: { action: 'RESTRICT_USER', targetType: 'USER', targetId: OFFENDER_ID, durationDays: 30 },
        reason: NOTES,
      });
    });

    it('logs no duration when none was given', async () => {
      deciding(reportOn('MESSAGE'));

      await resolveReport(REPORT_ID, admin, { action: 'WARN_USER', notes: NOTES });

      expect(auditLog).toHaveBeenCalledWith(
        expect.objectContaining({ newValue: expect.objectContaining({ action: 'WARN_USER', durationDays: null }) })
      );
    });

    it('tells each person who reported it, once, that action was taken, without the notes', async () => {
      deciding(reportOn('MESSAGE'));

      await resolveReport(REPORT_ID, admin, { action: 'REMOVE_CONTENT', notes: NOTES });

      expect(notifyMany).toHaveBeenCalledTimes(1);
      const [userIds, type, title, message, entityType, entityId] = notifyMany.mock.calls[0];
      expect(userIds).toEqual([REPORTER_ID, OTHER_REPORTER_ID]);
      expect(type).toBe('SYSTEM_ANNOUNCEMENT');
      expect(title).toBe('Update on your report');
      expect(message).toMatch(/taken action/);
      expect(message).not.toContain(NOTES);
      expect(entityType).toBe('report');
      expect(entityId).toBe(REPORT_ID);
    });

    it('tells the people who reported it when no breach was found', async () => {
      deciding(reportOn('MESSAGE'));

      await resolveReport(REPORT_ID, admin, { action: 'DISMISS', notes: 'Normal price negotiation' });

      expect(notifyMany).toHaveBeenCalledTimes(1);
      const [userIds, , , message] = notifyMany.mock.calls[0];
      expect(userIds).toEqual([REPORTER_ID, OTHER_REPORTER_ID]);
      expect(message).toMatch(/didn't find a breach/);
      expect(message).not.toMatch(/taken action/);
      expect(message).not.toContain('Normal price negotiation');
    });

    it('tells nobody when only the content filter reported it', async () => {
      const report = reportOn('MESSAGE', { reporterId: null, automated: true });
      deciding(report);
      tx.report.findMany.mockResolvedValue([{ id: REPORT_ID, reporterId: null }]);

      await resolveReport(REPORT_ID, admin, { action: 'REMOVE_CONTENT', notes: NOTES });

      expectDecided(report, 'ACTIONED', 'REMOVE_CONTENT', { claimedIds: [REPORT_ID] });
      expect(notifyMany).not.toHaveBeenCalled();
    });

    it('still resolves when the reporters cannot be notified', async () => {
      const report = reportOn('REVIEW');
      deciding(report);
      notifyMany.mockRejectedValue(new Error('database unavailable'));
      const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);

      await expect(resolveReport(REPORT_ID, admin, { action: 'REMOVE_CONTENT', notes: NOTES })).resolves.toMatchObject({
        id: REPORT_ID,
      });
      expectDecided(report, 'ACTIONED', 'REMOVE_CONTENT');
      expect(auditLog).toHaveBeenCalledTimes(1);
      expect(consoleError).toHaveBeenCalled();
    });

    it('still resolves, and tells the reporters, when the audit log fails', async () => {
      const report = reportOn('REVIEW');
      deciding(report);
      auditLog.mockRejectedValue(new Error('database unavailable'));
      const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);

      await expect(resolveReport(REPORT_ID, admin, { action: 'REMOVE_CONTENT', notes: NOTES })).resolves.toMatchObject({
        id: REPORT_ID,
      });
      expectDecided(report, 'ACTIONED', 'REMOVE_CONTENT');
      expect(notifyMany).toHaveBeenCalledTimes(1);
      expect(consoleError).toHaveBeenCalled();
    });
  });
});
