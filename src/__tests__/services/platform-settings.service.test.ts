/**
 * Platform settings: the commission rate a Super Admin sets
 */

jest.mock('@/lib/prisma', () => ({
  __esModule: true,
  default: { platformSettings: { findUnique: jest.fn(), upsert: jest.fn() } },
}));
jest.mock('@/config', () => ({ config: { platform: { commissionRate: 0.07 } } }));
jest.mock('@/services/audit.service', () => ({ createAuditLog: jest.fn() }));

import prisma from '@/lib/prisma';
import { createAuditLog } from '@/services/audit.service';
import {
  getCommissionRate,
  getPlatformSettings,
  toPercent,
  updateCommissionRate,
} from '@/services/platform-settings.service';

const SUPER_ADMIN_ID = '66e2b4c1f0a9d83b5c7e1a01';
const SETTINGS_ID = '66e2b4c1f0a9d83b5c7e1a09';
const updatedAt = new Date('2026-09-12T10:00:00Z');

const findUnique = prisma.platformSettings.findUnique as jest.Mock;
const upsert = prisma.platformSettings.upsert as jest.Mock;

const stored = (commissionRate: number) => ({
  id: SETTINGS_ID,
  key: 'platform',
  commissionRate,
  updatedBy: SUPER_ADMIN_ID,
  createdAt: updatedAt,
  updatedAt,
});

beforeEach(() => {
  jest.resetAllMocks();
});

describe('getCommissionRate', () => {
  it('uses the starting rate until a Super Admin sets one', async () => {
    findUnique.mockResolvedValue(null);

    await expect(getCommissionRate()).resolves.toBe(0.07);
  });

  it('uses the rate a Super Admin set', async () => {
    findUnique.mockResolvedValue(stored(0.1));

    await expect(getCommissionRate()).resolves.toBe(0.1);
    expect(findUnique).toHaveBeenCalledWith({ where: { key: 'platform' } });
  });
});

describe('getPlatformSettings', () => {
  it('shows the rate as a percentage, with who changed it and when', async () => {
    findUnique.mockResolvedValue(stored(0.075));

    await expect(getPlatformSettings()).resolves.toEqual({
      commissionRate: 7.5,
      updatedAt: updatedAt.toISOString(),
      updatedBy: SUPER_ADMIN_ID,
    });
  });

  it('shows the starting rate when none has been set', async () => {
    findUnique.mockResolvedValue(null);

    await expect(getPlatformSettings()).resolves.toEqual({ commissionRate: 7, updatedAt: null, updatedBy: null });
  });
});

describe('updateCommissionRate', () => {
  it('stores the percentage as a fraction and records the change in the audit log', async () => {
    findUnique.mockResolvedValue(null);
    upsert.mockResolvedValue(stored(0.125));

    const settings = await updateCommissionRate(12.5, SUPER_ADMIN_ID, 'SUPER_ADMIN');

    expect(upsert).toHaveBeenCalledWith({
      where: { key: 'platform' },
      create: { key: 'platform', commissionRate: 0.125, updatedBy: SUPER_ADMIN_ID },
      update: { commissionRate: 0.125, updatedBy: SUPER_ADMIN_ID },
    });
    expect(createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'UPDATE_PLATFORM_SETTINGS',
        targetId: SETTINGS_ID,
        performedBy: SUPER_ADMIN_ID,
        performedByRole: 'SUPER_ADMIN',
        previousValue: { commissionRate: 7 },
        newValue: { commissionRate: 12.5 },
      })
    );
    expect(settings.commissionRate).toBe(12.5);
  });

  it('keeps two decimal places of the percentage', async () => {
    findUnique.mockResolvedValue(stored(0.07));
    upsert.mockResolvedValue(stored(0.0712));

    await updateCommissionRate(7.123, SUPER_ADMIN_ID, 'SUPER_ADMIN');

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: { commissionRate: 0.0712, updatedBy: SUPER_ADMIN_ID } })
    );
  });

  it('allows a 0% commission', async () => {
    findUnique.mockResolvedValue(stored(0.07));
    upsert.mockResolvedValue(stored(0));

    await expect(updateCommissionRate(0, SUPER_ADMIN_ID, 'SUPER_ADMIN')).resolves.toMatchObject({ commissionRate: 0 });
  });

  it.each([-1, 50.01, Number.NaN, Number.POSITIVE_INFINITY])('refuses %s', async (percent) => {
    await expect(updateCommissionRate(percent, SUPER_ADMIN_ID, 'SUPER_ADMIN')).rejects.toMatchObject({
      extensions: { code: 'INVALID_COMMISSION_RATE' },
    });
    expect(upsert).not.toHaveBeenCalled();
    expect(createAuditLog).not.toHaveBeenCalled();
  });

  it('still saves the rate when the audit log fails', async () => {
    findUnique.mockResolvedValue(null);
    upsert.mockResolvedValue(stored(0.1));
    (createAuditLog as jest.Mock).mockRejectedValue(new Error('database unavailable'));
    jest.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(updateCommissionRate(10, SUPER_ADMIN_ID, 'SUPER_ADMIN')).resolves.toMatchObject({ commissionRate: 10 });
  });
});

describe('toPercent', () => {
  it.each([
    [0.07, 7],
    [0.075, 7.5],
    [0.1, 10],
    [0, 0],
  ])('shows a rate of %s as %s percent', (rate, percent) => {
    expect(toPercent(rate)).toBe(percent);
  });
});
