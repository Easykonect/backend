/**
 * Report Service
 *
 * People report users and content that break the community rules, and the
 * content filter raises reports automatically. Each report keeps a copy of
 * the content as it was, so the evidence survives edits and deletion. Admins
 * work through the queue oldest first; every decision is audit-logged and the
 * people who reported are told the outcome.
 */

import { GraphQLError } from 'graphql';
import {
  AdminAction,
  type ModerationAction,
  type Prisma,
  type Report,
  type ReportReason,
  type ReportStatus,
  type ReportTargetType,
} from '@prisma/client';
import prisma from '@/lib/prisma';
import { config } from '@/config';
import { withTransaction } from '@/lib/transaction';
import { NotificationType } from '@/constants';
import { sanitizeBasic } from '@/utils/security';
import { createAuditLog } from './audit.service';
import { createBulkNotifications, createNotification } from './notification.service';

// ==================
// Types
// ==================

interface CreateReportInput {
  targetType: ReportTargetType;
  targetId: string;
  reason: ReportReason;
  details?: string | null;
}

interface ContentFlag {
  targetType: ReportTargetType;
  targetId: string;
  targetUserId: string | null;
  reason: ReportReason;
  details: string;
  snapshot: Record<string, unknown>;
}

interface ReportFilters {
  status?: ReportStatus | null;
  targetType?: ReportTargetType | null;
  reason?: ReportReason | null;
}

interface ResolveReportInput {
  action: ModerationAction;
  notes: string;
  // How long a restriction or ban lasts; a ban without one is permanent
  durationDays?: number | null;
}

interface PaginationParams {
  page?: number | null;
  limit?: number | null;
}

// ==================
// Constants
// ==================

const MAX_REPORTS_PER_DAY = 20;
const MAX_DETAILS_LENGTH = 1000;
const SNAPSHOT_MESSAGE_COUNT = 20;
const DEFAULT_RESTRICTION_DAYS = 7;
const OBJECT_ID = /^[0-9a-f]{24}$/i;

const userSummarySelect = {
  id: true,
  firstName: true,
  lastName: true,
  email: true,
  role: true,
  status: true,
} satisfies Prisma.UserSelect;

// ==================
// Helpers
// ==================

const paginate = (pagination: PaginationParams = {}) => {
  const page = Math.max(pagination.page ?? 1, 1);
  const limit = Math.min(Math.max(pagination.limit ?? 20, 1), 100);
  return { page, limit, skip: (page - 1) * limit };
};

const pageInfo = (total: number, page: number, limit: number) => {
  const totalPages = Math.ceil(total / limit);
  return { total, page, limit, totalPages, hasNextPage: page < totalPages, hasPreviousPage: page > 1 };
};

const label = (value: string) => value.toLowerCase().replace(/_/g, ' ');

const targetNotFound = () =>
  new GraphQLError('The content you reported could not be found', {
    extensions: { code: 'NOT_FOUND' },
  });

const invalidAction = (message: string) =>
  new GraphQLError(message, { extensions: { code: 'INVALID_MODERATION_ACTION' } });

/**
 * Find what's being reported, check the reporter can see it, and copy it.
 * `reporterId` is null for automated flags, which skip the visibility check.
 */
const describeTarget = async (
  targetType: ReportTargetType,
  targetId: string,
  reporterId: string | null
): Promise<{ targetUserId: string | null; snapshot: Record<string, unknown> }> => {
  if (!OBJECT_ID.test(targetId)) throw targetNotFound();

  switch (targetType) {
    case 'USER': {
      const user = await prisma.user.findUnique({
        where: { id: targetId },
        select: { id: true, firstName: true, lastName: true, profilePhoto: true, role: true },
      });
      if (!user) throw targetNotFound();
      return { targetUserId: user.id, snapshot: user };
    }

    case 'MESSAGE': {
      const message = await prisma.message.findUnique({
        where: { id: targetId },
        include: { conversation: { select: { participantIds: true } } },
      });
      if (!message || (reporterId && !message.conversation.participantIds.includes(reporterId))) {
        throw targetNotFound();
      }
      return {
        targetUserId: message.senderId,
        snapshot: {
          conversationId: message.conversationId,
          content: message.content,
          attachments: message.attachments,
          sentAt: message.createdAt.toISOString(),
        },
      };
    }

    case 'CONVERSATION': {
      const conversation = await prisma.conversation.findUnique({
        where: { id: targetId },
        select: { participantIds: true, bookingId: true },
      });
      if (!conversation || (reporterId && !conversation.participantIds.includes(reporterId))) {
        throw targetNotFound();
      }
      const messages = await prisma.message.findMany({
        where: { conversationId: targetId },
        orderBy: { createdAt: 'desc' },
        take: SNAPSHOT_MESSAGE_COUNT,
        select: { id: true, senderId: true, content: true, attachments: true, createdAt: true },
      });
      return {
        targetUserId: conversation.participantIds.find((id) => id !== reporterId) ?? null,
        snapshot: {
          bookingId: conversation.bookingId,
          participantIds: conversation.participantIds,
          messages: messages.reverse().map((m) => ({ ...m, createdAt: m.createdAt.toISOString() })),
        },
      };
    }

    case 'REVIEW': {
      const review = await prisma.review.findUnique({
        where: { id: targetId },
        select: {
          userId: true,
          rating: true,
          comment: true,
          response: true,
          deletedAt: true,
          provider: { select: { id: true, userId: true } },
        },
      });
      // A review an admin removed is gone for everyone
      if (!review || review.deletedAt) throw targetNotFound();
      // A reviewer reporting their own review is reporting the provider's reply
      const aboutResponse = reporterId === review.userId && Boolean(review.response);
      return {
        targetUserId: aboutResponse ? review.provider.userId : review.userId,
        snapshot: {
          reviewerId: review.userId,
          providerId: review.provider.id,
          rating: review.rating,
          comment: review.comment,
          response: review.response,
        },
      };
    }

    case 'SERVICE': {
      const service = await prisma.service.findUnique({
        where: { id: targetId },
        select: {
          name: true,
          description: true,
          images: true,
          status: true,
          provider: { select: { userId: true } },
        },
      });
      if (!service) throw targetNotFound();
      const { provider, ...listing } = service;
      return { targetUserId: provider.userId, snapshot: listing };
    }

    case 'PROVIDER': {
      const provider = await prisma.serviceProvider.findUnique({
        where: { id: targetId },
        select: { userId: true, businessName: true, businessDescription: true, images: true },
      });
      if (!provider) throw targetNotFound();
      const { userId, ...profile } = provider;
      return { targetUserId: userId, snapshot: profile };
    }
  }

  throw targetNotFound();
};

const formatMyReport = (report: Report) => ({
  id: report.id,
  targetType: report.targetType,
  targetId: report.targetId,
  reason: report.reason,
  details: report.details,
  status: report.status,
  createdAt: report.createdAt.toISOString(),
  updatedAt: report.updatedAt.toISOString(),
});

/**
 * The admin view: the people involved, and how many open reports the same
 * content has
 */
const formatAdminReports = async (reports: Report[]) => {
  const userIds = [
    ...new Set(
      reports.flatMap((report) => [report.reporterId, report.targetUserId]).filter((id): id is string => Boolean(id))
    ),
  ];
  const targetIds = [...new Set(reports.map((report) => report.targetId))];

  const [users, openCounts] = await Promise.all([
    userIds.length > 0
      ? prisma.user.findMany({ where: { id: { in: userIds } }, select: userSummarySelect })
      : Promise.resolve([]),
    targetIds.length > 0
      ? prisma.report.groupBy({
          by: ['targetId'],
          where: { targetId: { in: targetIds }, status: 'OPEN' },
          _count: { _all: true },
        })
      : Promise.resolve([]),
  ]);

  const usersById = new Map(users.map((user) => [user.id, user]));
  const openCountByTarget = new Map(openCounts.map((group) => [group.targetId, group._count._all]));

  return reports.map((report) => ({
    ...formatMyReport(report),
    automated: report.automated,
    snapshot: report.snapshot,
    action: report.action,
    resolutionNotes: report.resolutionNotes,
    handledBy: report.handledBy,
    handledAt: report.handledAt?.toISOString() ?? null,
    reporter: report.reporterId ? usersById.get(report.reporterId) ?? null : null,
    targetUser: report.targetUserId ? usersById.get(report.targetUserId) ?? null : null,
    openReportCount: openCountByTarget.get(report.targetId) ?? 0,
  }));
};

/**
 * Hide a message or review once enough different people have reported it,
 * until an admin reviews it
 */
const hideIfReportedOften = async (targetType: ReportTargetType, targetId: string) => {
  if (targetType !== 'MESSAGE' && targetType !== 'REVIEW') return;

  const reports = await prisma.report.findMany({
    where: { targetType, targetId, status: 'OPEN', automated: false },
    select: { reporterId: true },
  });

  const reporters = new Set(reports.map((report) => report.reporterId));
  if (reporters.size < (config.moderation?.autoHideReportCount ?? 3)) return;

  if (targetType === 'MESSAGE') {
    const message = await prisma.message.update({ where: { id: targetId }, data: { isHidden: true } });
    await refreshPreview(message.conversationId);
  } else {
    await prisma.review.update({ where: { id: targetId }, data: { isHidden: true } });
  }
};

/**
 * Show content again that was hidden automatically
 */
const unhideContent = async (report: Report) => {
  // Content an admin removed on an earlier report stays removed
  const removedEarlier = await prisma.report.findFirst({
    where: {
      targetType: report.targetType,
      targetId: report.targetId,
      status: 'ACTIONED',
      action: 'REMOVE_CONTENT',
    },
    select: { id: true },
  });

  if (removedEarlier) return;

  if (report.targetType === 'MESSAGE') {
    await prisma.message.updateMany({
      where: { id: report.targetId, isDeleted: false },
      data: { isHidden: false },
    });
    await refreshPreview(await reportedConversationId(report));
  } else if (report.targetType === 'REVIEW') {
    // A review an admin removed stays removed
    await prisma.review.updateMany({
      where: { id: report.targetId, OR: [{ deletedAt: null }, { deletedAt: { isSet: false } }] },
      data: { isHidden: false },
    });
  }
};

/**
 * Tell every active admin there's something to review
 */
const alertAdmins = async (report: Report) => {
  try {
    const admins = await prisma.user.findMany({
      where: { role: { in: ['ADMIN', 'SUPER_ADMIN'] }, status: 'ACTIVE' },
      select: { id: true },
    });

    await createBulkNotifications(
      admins.map((admin) => admin.id),
      NotificationType.SYSTEM_ANNOUNCEMENT,
      'New report to review',
      `A ${label(report.targetType)} was reported for ${label(report.reason)}.`,
      'report',
      report.id,
      { reportId: report.id }
    );
  } catch (error) {
    console.error('Failed to alert admins about a report:', error);
  }
};

// ==================
// Reporting
// ==================

/**
 * Report a user or their content. A second report of the same thing by the
 * same person returns the open report instead of creating another.
 */
export const createReport = async (reporterId: string, input: CreateReportInput) => {
  const { targetType, targetId, reason } = input;
  const details = input.details?.trim()
    ? sanitizeBasic(input.details.trim().slice(0, MAX_DETAILS_LENGTH))
    : null;

  const { targetUserId, snapshot } = await describeTarget(targetType, targetId, reporterId);

  if (targetUserId === reporterId) {
    throw new GraphQLError("You can't report your own account or content", {
      extensions: { code: 'CANNOT_REPORT_SELF' },
    });
  }

  const existing = await prisma.report.findFirst({
    where: { reporterId, targetType, targetId, status: 'OPEN' },
  });

  if (existing) {
    return formatMyReport(existing);
  }

  const recentReports = await prisma.report.count({
    where: { reporterId, createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
  });

  if (recentReports >= MAX_REPORTS_PER_DAY) {
    throw new GraphQLError("You've sent a lot of reports today. Please try again tomorrow.", {
      extensions: { code: 'RATE_LIMITED' },
    });
  }

  const report = await prisma.report.create({
    data: {
      reporterId,
      targetType,
      targetId,
      targetUserId,
      reason,
      details,
      snapshot: JSON.stringify(snapshot),
    },
  });

  // The report is saved either way; content deleted meanwhile has nothing to hide
  try {
    await hideIfReportedOften(targetType, targetId);
  } catch (error) {
    console.error('Failed to hide reported content:', error);
  }
  await alertAdmins(report);

  return formatMyReport(report);
};

/**
 * Raise a report from the content filter, unless one is already open for the
 * same content and reason. Never throws: flagging must not stop the content
 * being posted.
 */
export const flagContent = async (flag: ContentFlag): Promise<void> => {
  try {
    const open = await prisma.report.findFirst({
      where: {
        automated: true,
        targetType: flag.targetType,
        targetId: flag.targetId,
        reason: flag.reason,
        status: 'OPEN',
      },
      select: { id: true },
    });

    if (open) return;

    await prisma.report.create({
      data: {
        automated: true,
        targetType: flag.targetType,
        targetId: flag.targetId,
        targetUserId: flag.targetUserId,
        reason: flag.reason,
        details: flag.details,
        snapshot: JSON.stringify(flag.snapshot),
      },
    });
  } catch (error) {
    console.error('Failed to flag content for review:', error);
  }
};

/**
 * Reports a user has made, newest first
 */
export const getMyReports = async (userId: string, pagination: PaginationParams = {}) => {
  const { page, limit, skip } = paginate(pagination);

  const [reports, total] = await Promise.all([
    prisma.report.findMany({
      where: { reporterId: userId },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.report.count({ where: { reporterId: userId } }),
  ]);

  return { items: reports.map(formatMyReport), ...pageInfo(total, page, limit) };
};

// ==================
// Admin
// ==================

/**
 * The report queue (admin). Open reports come oldest first, so nothing waits
 * too long; handled reports newest first.
 */
export const getReports = async (filters: ReportFilters = {}, pagination: PaginationParams = {}) => {
  const { page, limit, skip } = paginate(pagination);

  const where: Prisma.ReportWhereInput = {
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.targetType ? { targetType: filters.targetType } : {}),
    ...(filters.reason ? { reason: filters.reason } : {}),
  };

  const [reports, total] = await Promise.all([
    prisma.report.findMany({
      where,
      orderBy: { createdAt: filters.status === 'OPEN' ? 'asc' : 'desc' },
      skip,
      take: limit,
    }),
    prisma.report.count({ where }),
  ]);

  return { items: await formatAdminReports(reports), ...pageInfo(total, page, limit) };
};

/**
 * One report (admin)
 */
export const getReportById = async (reportId: string) => {
  const report = OBJECT_ID.test(reportId)
    ? await prisma.report.findUnique({ where: { id: reportId } })
    : null;

  if (!report) {
    throw new GraphQLError('Report not found', {
      extensions: { code: 'NOT_FOUND' },
    });
  }

  const [formatted] = await formatAdminReports([report]);
  return formatted;
};

const reportedConversationId = async (report: Report): Promise<string | null> => {
  if (report.targetType === 'CONVERSATION') return report.targetId;
  if (report.targetType !== 'MESSAGE') return null;

  const message = await prisma.message.findUnique({
    where: { id: report.targetId },
    select: { conversationId: true },
  });
  if (message) return message.conversationId;

  try {
    const snapshot = JSON.parse(report.snapshot) as { conversationId?: unknown };
    return typeof snapshot.conversationId === 'string' ? snapshot.conversationId : null;
  } catch {
    return null;
  }
};

/**
 * The conversation a report is about, including deleted and hidden messages
 * (admin). Every access is written to the audit log.
 */
export const getReportedConversationMessages = async (
  reportId: string,
  admin: { id: string; role: string },
  pagination: PaginationParams = {}
) => {
  const report = OBJECT_ID.test(reportId)
    ? await prisma.report.findUnique({ where: { id: reportId } })
    : null;

  if (!report) {
    throw new GraphQLError('Report not found', {
      extensions: { code: 'NOT_FOUND' },
    });
  }

  const conversationId = await reportedConversationId(report);

  if (!conversationId) {
    throw new GraphQLError('This report is not about a conversation', {
      extensions: { code: 'BAD_REQUEST' },
    });
  }

  // Reading someone's messages is logged before anything is returned
  await createAuditLog({
    action: AdminAction.VIEW_REPORTED_CONVERSATION,
    targetType: 'Conversation',
    targetId: conversationId,
    performedBy: admin.id,
    performedByRole: admin.role,
    newValue: { reportId },
    reason: `Reviewing report ${reportId}`,
  });

  const { page, limit, skip } = paginate(pagination);

  const [messages, total] = await Promise.all([
    prisma.message.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.message.count({ where: { conversationId } }),
  ]);

  const senders = await prisma.user.findMany({
    where: { id: { in: [...new Set(messages.map((message) => message.senderId))] } },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      profilePhoto: true,
      role: true,
      provider: { select: { businessName: true } },
    },
  });
  // A provider's business name is on their provider profile
  const sendersById = new Map(
    senders.map(({ provider, ...sender }) => [sender.id, { ...sender, businessName: provider?.businessName ?? null }])
  );

  return {
    messages: messages.reverse().map((message) => ({
      ...message,
      // Messages saved before moderation existed have no isHidden
      isHidden: message.isHidden ?? false,
      sender: sendersById.get(message.senderId) ?? null,
    })),
    ...pageInfo(total, page, limit),
  };
};

/**
 * Point a conversation's preview at its latest visible message after
 * moderation hides, removes or restores one. A failure here doesn't undo the
 * moderation.
 */
const refreshPreview = async (conversationId: string | null) => {
  if (!conversationId) return;

  try {
    const { refreshConversationPreview } = await import('./messaging.service');
    await refreshConversationPreview(conversationId);
  } catch (error) {
    console.error('Failed to refresh conversation preview:', error);
  }
};

/**
 * Suspend a reported service, as the deciding admin. One the provider has
 * since deleted is already gone, and one that's already suspended stays so.
 */
const suspendReportedService = async (
  serviceId: string,
  reason: string,
  admin: { id: string; role: string }
) => {
  const service = await prisma.service.findUnique({ where: { id: serviceId }, select: { id: true, status: true } });
  if (!service || service.status === 'SUSPENDED') return;

  const { suspendService } = await import('./service.service');
  try {
    await suspendService(serviceId, reason, { id: admin.id, role: admin.role });
  } catch (error) {
    // Suspended by someone else a moment ago
    if (error instanceof GraphQLError && error.extensions.code === 'ALREADY_SUSPENDED') return;
    throw error;
  }
};

const requireTargetUser = (report: Report) => {
  if (!report.targetUserId) {
    throw invalidAction('No user is linked to this report');
  }
  return report.targetUserId;
};

// How a report's reason reads to the person it was about
const REASON_FOR_USER: Record<ReportReason, string> = {
  HARASSMENT: 'harassment',
  HATE: 'hate speech',
  SEXUAL_CONTENT: 'sexual content',
  VIOLENCE: 'violence',
  SCAM: 'a scam',
  OFF_PLATFORM_PAYMENT: 'asking for payment outside Easykonnet',
  SPAM: 'spam',
  IMPERSONATION: 'impersonation',
  OTHER: 'breaking the community rules',
};

/**
 * The reason given to the reported user when their account or service is
 * restricted, banned or suspended. The admin's notes stay on the report and in
 * the audit log.
 */
export const reasonForReportedUser = (reason: ReportReason): string =>
  `A report about ${REASON_FOR_USER[reason] ?? REASON_FOR_USER.OTHER} was upheld after review`;

/**
 * Carry out an admin's decision on reported content
 */
const applyModerationAction = async (
  report: Report,
  action: ModerationAction,
  notes: string,
  admin: { id: string; role: string },
  durationDays: number | null
) => {
  // The reported user is told the report was upheld, never the admin's notes
  const userReason = reasonForReportedUser(report.reason);

  switch (action) {
    case 'DISMISS':
      return;

    case 'REMOVE_CONTENT':
      // Content that has since been deleted counts as removed
      if (report.targetType === 'MESSAGE') {
        const { count } = await prisma.message.updateMany({
          where: { id: report.targetId },
          data: {
            isDeleted: true,
            isHidden: true,
            deletedAt: new Date(),
            content: 'This message was removed for breaking the community rules',
          },
        });
        if (count > 0) await refreshPreview(await reportedConversationId(report));
        return;
      }
      if (report.targetType === 'REVIEW') {
        await prisma.review.updateMany({ where: { id: report.targetId }, data: { isHidden: true } });
        return;
      }
      if (report.targetType === 'SERVICE') {
        await suspendReportedService(report.targetId, userReason, admin);
        return;
      }
      throw invalidAction('Only messages, reviews and services can be removed. Warn, restrict or ban the user instead.');

    case 'SUSPEND_SERVICE':
      if (report.targetType !== 'SERVICE') {
        throw invalidAction('Only a reported service can be suspended');
      }
      await suspendReportedService(report.targetId, userReason, admin);
      return;

    case 'WARN_USER':
      await createNotification({
        userId: requireTargetUser(report),
        type: NotificationType.SYSTEM_ANNOUNCEMENT,
        title: 'A warning from Easykonnet',
        message:
          'Something you posted was reported and reviewed, and it breaks our community rules. Further problems can lead to your account being restricted or banned.',
        entityType: 'report',
        entityId: report.id,
      });
      return;

    case 'RESTRICT_USER': {
      const { restrictUser } = await import('./user-management.service');
      await restrictUser(
        { userId: requireTargetUser(report), reason: notes, userFacingReason: userReason, days: durationDays ?? DEFAULT_RESTRICTION_DAYS },
        admin.id,
        admin.role
      );
      return;
    }

    case 'BAN_USER': {
      const { banUser } = await import('./user-management.service');
      await banUser(
        { userId: requireTargetUser(report), reason: notes, userFacingReason: userReason, days: durationDays ?? undefined },
        admin.id,
        admin.role
      );
      return;
    }
  }
};

/**
 * Decide a report (admin). The decision applies to every open report about
 * the same content.
 */
export const resolveReport = async (
  reportId: string,
  admin: { id: string; role: string },
  input: ResolveReportInput
) => {
  const notes = input.notes?.trim();

  if (!notes || notes.length < 5) {
    throw new GraphQLError('Add a note explaining the decision (at least 5 characters)', {
      extensions: { code: 'INVALID_INPUT' },
    });
  }

  if (
    input.durationDays != null &&
    (!Number.isInteger(input.durationDays) || input.durationDays < 1 || input.durationDays > 365)
  ) {
    throw new GraphQLError('Duration must be a whole number of days between 1 and 365', {
      extensions: { code: 'INVALID_INPUT' },
    });
  }

  const report = OBJECT_ID.test(reportId)
    ? await prisma.report.findUnique({ where: { id: reportId } })
    : null;

  if (!report) {
    throw new GraphQLError('Report not found', {
      extensions: { code: 'NOT_FOUND' },
    });
  }

  if (report.status !== 'OPEN') {
    throw new GraphQLError('This report has already been handled', {
      extensions: { code: 'ALREADY_RESOLVED' },
    });
  }

  const safeNotes = sanitizeBasic(notes);
  const dismissed = input.action === 'DISMISS';
  const decision = {
    status: dismissed ? ('DISMISSED' as const) : ('ACTIONED' as const),
    action: input.action,
    resolutionNotes: safeNotes,
    handledBy: admin.id,
    handledAt: new Date(),
  };

  // Claim every open report about this content in one transaction before acting.
  // Two admins deciding it at once, through this report or another one about the
  // same content, conflict there; the one that retries finds nothing left to claim.
  const claimedReports = await withTransaction(async (tx) => {
    const open = await tx.report.findMany({
      where: { targetType: report.targetType, targetId: report.targetId, status: 'OPEN' },
      select: { id: true, reporterId: true },
    });

    if (!open.some((openReport) => openReport.id === report.id)) return [];

    await tx.report.updateMany({
      where: { id: { in: open.map((openReport) => openReport.id) }, status: 'OPEN' },
      data: decision,
    });

    return open;
  });

  if (claimedReports.length === 0) {
    throw new GraphQLError('This report has already been handled', {
      extensions: { code: 'ALREADY_RESOLVED' },
    });
  }

  try {
    await applyModerationAction(report, input.action, safeNotes, admin, input.durationDays ?? null);
  } catch (error) {
    // Reopen the reports so the decision can be made again
    try {
      await prisma.report.updateMany({
        where: {
          id: { in: claimedReports.map((claimedReport) => claimedReport.id) },
          handledBy: admin.id,
          handledAt: decision.handledAt,
        },
        data: { status: 'OPEN', action: null, resolutionNotes: null, handledBy: null, handledAt: null },
      });
    } catch (reopenError) {
      console.error('Failed to reopen reports after a failed moderation action:', reopenError);
    }
    throw error;
  }

  // Content hidden automatically comes back when its reports are dismissed
  if (dismissed) {
    await unhideContent(report);
  }

  try {
    await createAuditLog({
      action: AdminAction.RESOLVE_REPORT,
      targetType: 'Report',
      targetId: report.id,
      performedBy: admin.id,
      performedByRole: admin.role,
      previousValue: { status: 'OPEN', reportCount: claimedReports.length },
      newValue: {
        action: input.action,
        targetType: report.targetType,
        targetId: report.targetId,
        durationDays: input.durationDays ?? null,
      },
      reason: safeNotes,
    });
  } catch (error) {
    console.error('Failed to write report audit log:', error);
  }

  // Tell the people who reported it what happened, without the details
  const reporterIds = [
    ...new Set(claimedReports.map((claimedReport) => claimedReport.reporterId).filter((id): id is string => Boolean(id))),
  ];

  if (reporterIds.length > 0) {
    try {
      await createBulkNotifications(
        reporterIds,
        NotificationType.SYSTEM_ANNOUNCEMENT,
        'Update on your report',
        dismissed
          ? "We've reviewed your report and didn't find a breach of our community rules."
          : "We've reviewed your report and taken action. Thank you for helping keep Easykonnet safe.",
        'report',
        report.id
      );
    } catch (error) {
      console.error('Failed to notify reporters:', error);
    }
  }

  return getReportById(report.id);
};
