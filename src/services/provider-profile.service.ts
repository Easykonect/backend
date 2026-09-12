/**
 * Provider profile helpers shared by the provider and service services: the
 * profile shape returned to GraphQL, rating and like counts, and the record
 * keeping around admin decisions.
 */

import { GraphQLError } from 'graphql';
import type { AdminAction } from '@prisma/client';
import prisma from '@/lib/prisma';
import { UserRole } from '@/constants';
import { sanitizeBasic, MAX_LENGTHS } from '@/utils/security';
import { createAuditLog } from '@/services/audit.service';

// ==================
// Types
// ==================

export interface ProviderStats {
  averageRating: number;
  totalReviews: number;
  likeCount: number;
}

/**
 * The admin behind a moderation decision
 */
export interface ModerationActor {
  id: string;
  role: string;
  ipAddress?: string;
  userAgent?: string;
}

export interface ProviderRecord {
  id: string;
  userId: string;
  businessName: string;
  businessDescription: string | null;
  verificationStatus: string;
  rejectionReason?: string | null;
  address: string;
  city: string;
  state: string;
  country: string;
  latitude: number | null;
  longitude: number | null;
  documents?: string[] | null;
  images?: string[] | null;
  createdAt: Date;
  updatedAt: Date;
}

const ADMIN_ROLES: string[] = [UserRole.ADMIN, UserRole.SUPER_ADMIN];

export const isAdminRole = (role?: string | null): boolean => Boolean(role && ADMIN_ROLES.includes(role));

// ==================
// Profile
// ==================

/**
 * Average rating (one decimal place), review count and like count for each
 * provider, in two queries. Providers without reviews or likes get zeros.
 * Hidden reviews still count toward the rating, as in browse.
 */
export const loadProviderStats = async (providerIds: string[]): Promise<Map<string, ProviderStats>> => {
  const ids = [...new Set(providerIds)];
  const stats = new Map<string, ProviderStats>(
    ids.map((id) => [id, { averageRating: 0, totalReviews: 0, likeCount: 0 }])
  );

  if (ids.length === 0) return stats;

  const [ratings, likes] = await Promise.all([
    prisma.review.groupBy({
      by: ['providerId'],
      where: { providerId: { in: ids } },
      _avg: { rating: true },
      _count: { _all: true },
    }),
    prisma.providerLike.groupBy({
      by: ['providerId'],
      where: { providerId: { in: ids } },
      _count: { _all: true },
    }),
  ]);

  for (const row of ratings) {
    const entry = stats.get(row.providerId);
    if (!entry) continue;
    entry.averageRating = Math.round((row._avg.rating ?? 0) * 10) / 10;
    entry.totalReviews = row._count._all;
  }

  for (const row of likes) {
    const entry = stats.get(row.providerId);
    if (entry) entry.likeCount = row._count._all;
  }

  return stats;
};

/**
 * A provider profile as the ServiceProviderProfile type returns it
 */
export const formatProviderProfile = (provider: ProviderRecord, stats?: ProviderStats) => ({
  id: provider.id,
  // Not in the schema; lets field resolvers recognise the owner
  userId: provider.userId,
  businessName: provider.businessName,
  businessDescription: provider.businessDescription,
  verificationStatus: provider.verificationStatus,
  // Only returned to the provider and admins (see the type resolvers)
  rejectionReason: provider.rejectionReason ?? null,
  address: provider.address,
  city: provider.city,
  state: provider.state,
  country: provider.country,
  latitude: provider.latitude,
  longitude: provider.longitude,
  documents: provider.documents ?? [],
  images: provider.images ?? [],
  averageRating: stats?.averageRating ?? null,
  totalReviews: stats?.totalReviews ?? null,
  likeCount: stats?.likeCount ?? null,
  // Depends on the viewer, so it isn't worked out here
  isLiked: null,
  createdAt: provider.createdAt.toISOString(),
  updatedAt: provider.updatedAt.toISOString(),
});

// ==================
// Moderation
// ==================

/**
 * The reason for a moderation decision, which the provider is shown: plain
 * text, 1 to 1000 characters
 */
export const validateModerationReason = (reason: string): string => {
  const text = sanitizeBasic(reason);

  if (!text) {
    throw new GraphQLError('A reason is required', {
      extensions: { code: 'INVALID_INPUT' },
    });
  }

  if (text.length > MAX_LENGTHS.MEDIUM_TEXT) {
    throw new GraphQLError(`Reason must be at most ${MAX_LENGTHS.MEDIUM_TEXT} characters`, {
      extensions: { code: 'INVALID_INPUT' },
    });
  }

  return text;
};

/**
 * Run a notification step. A failure is logged and doesn't undo the decision,
 * which is already saved.
 */
export const notifySafely = async (label: string, send: () => Promise<unknown>): Promise<void> => {
  try {
    await send();
  } catch (error) {
    console.error(`Failed to send ${label}:`, error);
  }
};

/**
 * Write the audit log entry for an admin's decision. Nothing is written when
 * the caller gives no actor.
 */
export const recordModeration = async (
  actor: ModerationActor | undefined,
  entry: {
    action: AdminAction;
    targetType: string;
    targetId: string;
    previousValue: Record<string, unknown>;
    newValue: Record<string, unknown>;
    reason?: string;
  }
): Promise<void> => {
  if (!actor) return;

  try {
    await createAuditLog({
      ...entry,
      performedBy: actor.id,
      performedByRole: actor.role,
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
    });
  } catch (error) {
    // The decision is already saved
    console.error(`Failed to write the ${entry.action} audit log:`, error);
  }
};
