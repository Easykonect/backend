/**
 * Platform Settings Service
 *
 * Settings a Super Admin can change from the app. The commission rate starts
 * at COMMISSION_RATE and comes from the database once a Super Admin sets it.
 * Each booking keeps the commission it was created with, so a new rate only
 * applies to bookings made after the change.
 */

import { GraphQLError } from 'graphql';
import { AdminAction } from '@prisma/client';
import prisma from '@/lib/prisma';
import { config } from '@/config';
import { createAuditLog } from './audit.service';

const SETTINGS_KEY = 'platform';

// Highest commission a Super Admin can set, as a percentage
export const MAX_COMMISSION_PERCENT = 50;

/**
 * A rate as a percentage to two decimal places (0.075 → 7.5)
 */
export const toPercent = (rate: number) => Math.round(rate * 10_000) / 100;

const formatSettings = (
  settings: { commissionRate: number; updatedAt: Date; updatedBy: string | null } | null
) => ({
  commissionRate: toPercent(settings?.commissionRate ?? config.platform.commissionRate),
  updatedAt: settings?.updatedAt.toISOString() ?? null,
  updatedBy: settings?.updatedBy ?? null,
});

/**
 * The commission rate for new bookings, as a fraction (0.07 = 7%)
 */
export const getCommissionRate = async (): Promise<number> => {
  const settings = await prisma.platformSettings.findUnique({
    where: { key: SETTINGS_KEY },
  });

  return settings?.commissionRate ?? config.platform.commissionRate;
};

/**
 * Current platform settings (admin)
 */
export const getPlatformSettings = async () => {
  const settings = await prisma.platformSettings.findUnique({
    where: { key: SETTINGS_KEY },
  });

  return formatSettings(settings);
};

/**
 * Set the commission rate for new bookings (Super Admin). `percent` is a
 * percentage: 7.5 means 7.5%.
 */
export const updateCommissionRate = async (percent: number, adminId: string, adminRole: string) => {
  if (!Number.isFinite(percent) || percent < 0 || percent > MAX_COMMISSION_PERCENT) {
    throw new GraphQLError(`Commission rate must be between 0% and ${MAX_COMMISSION_PERCENT}%`, {
      extensions: { code: 'INVALID_COMMISSION_RATE' },
    });
  }

  // Stored as a fraction, to two decimal places of the percentage
  const rate = Math.round(percent * 100) / 10_000;
  const previousRate = await getCommissionRate();

  const settings = await prisma.platformSettings.upsert({
    where: { key: SETTINGS_KEY },
    create: { key: SETTINGS_KEY, commissionRate: rate, updatedBy: adminId },
    update: { commissionRate: rate, updatedBy: adminId },
  });

  // The rate has already changed; a failed log must not report it as failed
  try {
    await createAuditLog({
      action: AdminAction.UPDATE_PLATFORM_SETTINGS,
      targetType: 'PlatformSettings',
      targetId: settings.id,
      performedBy: adminId,
      performedByRole: adminRole,
      previousValue: { commissionRate: toPercent(previousRate) },
      newValue: { commissionRate: toPercent(rate) },
      reason: `Commission rate changed to ${toPercent(rate)}%`,
    });
  } catch (error) {
    console.error('Failed to write commission rate audit log:', error);
  }

  return formatSettings(settings);
};
