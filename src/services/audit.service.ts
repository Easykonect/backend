/**
 * Admin Audit Service
 * 
 * Logs all administrative actions for accountability and compliance.
 * Every admin action that modifies user data, payments, or system settings
 * should be logged here.
 */

import prisma from '@/lib/prisma';
import { AdminAction } from '@prisma/client';

// ==========================================
// Types
// ==========================================

interface CreateAuditLogInput {
  action: AdminAction;
  targetType: string;
  targetId: string;
  performedBy: string;
  performedByRole: string;
  previousValue?: Record<string, any> | null;
  newValue?: Record<string, any> | null;
  reason?: string;
  ipAddress?: string;
  userAgent?: string;
}

interface AuditLogFilters {
  action?: AdminAction;
  targetType?: string;
  targetId?: string;
  performedBy?: string;
  startDate?: string;
  endDate?: string;
}

interface PaginationInput {
  page: number;
  limit: number;
}

// ==========================================
// Helper Functions
// ==========================================

/**
 * Safely stringify object for storage
 */
const safeStringify = (obj: Record<string, any> | null | undefined): string | null => {
  if (!obj) return null;
  try {
    return JSON.stringify(obj);
  } catch {
    return null;
  }
};

/**
 * Safely parse stored JSON
 */
const safeParse = (str: string | null): Record<string, any> | null => {
  if (!str) return null;
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
};

/**
 * Format audit log for response
 */
const formatAuditLog = (log: any) => ({
  id: log.id,
  action: log.action,
  targetType: log.targetType,
  targetId: log.targetId,
  performedBy: log.performedBy,
  performedByRole: log.performedByRole,
  previousValue: safeParse(log.previousValue),
  newValue: safeParse(log.newValue),
  reason: log.reason,
  ipAddress: log.ipAddress,
  userAgent: log.userAgent,
  createdAt: log.createdAt.toISOString(),
});

// ==========================================
// Audit Log Functions
// ==========================================

/**
 * Create an audit log entry
 */
export const createAuditLog = async (input: CreateAuditLogInput) => {
  const {
    action,
    targetType,
    targetId,
    performedBy,
    performedByRole,
    previousValue,
    newValue,
    reason,
    ipAddress,
    userAgent,
  } = input;

  const auditLog = await prisma.adminAuditLog.create({
    data: {
      action,
      targetType,
      targetId,
      performedBy,
      performedByRole,
      previousValue: safeStringify(previousValue),
      newValue: safeStringify(newValue),
      reason,
      ipAddress,
      userAgent,
    },
  });

  return formatAuditLog(auditLog);
};

/**
 * Get audit logs with filters and pagination
 */
export const getAuditLogs = async (
  filters: AuditLogFilters,
  pagination: PaginationInput
) => {
  const { page, limit } = pagination;
  const skip = (page - 1) * limit;

  // Build where clause
  const where: any = {};

  if (filters.action) {
    where.action = filters.action;
  }

  if (filters.targetType) {
    where.targetType = filters.targetType;
  }

  if (filters.targetId) {
    where.targetId = filters.targetId;
  }

  if (filters.performedBy) {
    where.performedBy = filters.performedBy;
  }

  if (filters.startDate || filters.endDate) {
    where.createdAt = {};
    if (filters.startDate) {
      where.createdAt.gte = new Date(filters.startDate);
    }
    if (filters.endDate) {
      where.createdAt.lte = new Date(filters.endDate);
    }
  }

  const [logs, total] = await Promise.all([
    prisma.adminAuditLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.adminAuditLog.count({ where }),
  ]);

  return {
    logs: logs.map(formatAuditLog),
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
      hasNext: page * limit < total,
      hasPrev: page > 1,
    },
  };
};

/**
 * Get audit logs for a specific target entity
 */
export const getAuditLogsForTarget = async (
  targetType: string,
  targetId: string,
  pagination: PaginationInput
) => {
  return getAuditLogs({ targetType, targetId }, pagination);
};

/**
 * Get audit logs for a specific admin
 */
export const getAdminActivityLog = async (
  adminId: string,
  pagination: PaginationInput
) => {
  return getAuditLogs({ performedBy: adminId }, pagination);
};

/**
 * Get recent admin actions (for dashboard)
 */
export const getRecentAdminActions = async (limit: number = 10) => {
  const logs = await prisma.adminAuditLog.findMany({
    orderBy: { createdAt: 'desc' },
    take: limit,
  });

  return logs.map(formatAuditLog);
};

/**
 * Get action counts by type (for analytics)
 */
export const getActionStats = async (startDate?: string, endDate?: string) => {
  const where: any = {};

  if (startDate || endDate) {
    where.createdAt = {};
    if (startDate) {
      where.createdAt.gte = new Date(startDate);
    }
    if (endDate) {
      where.createdAt.lte = new Date(endDate);
    }
  }

  const logs = await prisma.adminAuditLog.groupBy({
    by: ['action'],
    where,
    _count: { action: true },
  });

  return logs.map((log) => ({
    action: log.action,
    count: log._count.action,
  }));
};

/**
 * Delete old audit logs (for data retention compliance)
 * Should be run as a scheduled job
 */
export const deleteOldAuditLogs = async (retentionDays: number = 365) => {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - retentionDays);

  const result = await prisma.adminAuditLog.deleteMany({
    where: {
      createdAt: { lt: cutoffDate },
    },
  });

  return {
    deletedCount: result.count,
    cutoffDate: cutoffDate.toISOString(),
  };
};
