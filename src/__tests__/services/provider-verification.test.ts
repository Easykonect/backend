/**
 * Provider Verification, Profile and Role Switching Tests
 *
 * Covers:
 *   - approveProvider only works on a provider pending verification
 *   - rejectProvider saves the reason on the profile
 *   - both tell the provider in the app and by push, and write the audit log
 *   - the business address is required; names and places allow & , / ( )
 *   - updateProviderProfile saves profilePhoto to the account
 *   - provider profiles return their gallery, owner, and rating and like counts
 *   - switchActiveRole follows the same rule as myActiveRole.canSwitch
 */

jest.mock('@/lib/prisma', () => ({
  __esModule: true,
  default: {
    user: { findUnique: jest.fn(), update: jest.fn() },
    serviceProvider: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    review: { groupBy: jest.fn() },
    providerLike: { groupBy: jest.fn() },
    $transaction: jest.fn(),
  },
}));

jest.mock('@/lib/auth', () => ({ generateToken: jest.fn(), generateRefreshToken: jest.fn() }));
jest.mock('@/services/token.service', () => ({ storeRefreshToken: jest.fn() }));
jest.mock('@/lib/email', () => ({
  sendProviderApprovedEmail: jest.fn(),
  sendProviderRejectedEmail: jest.fn(),
  sendProviderSubmissionEmail: jest.fn(),
}));
jest.mock('@/services/report.service', () => ({ flagContent: jest.fn() }));
jest.mock('@/services/notification.service', () => ({
  notifyVerificationApproved: jest.fn(),
  notifyVerificationRejected: jest.fn(),
}));
jest.mock('@/services/push.service', () => ({ sendVerificationPush: jest.fn() }));
jest.mock('@/services/audit.service', () => ({ createAuditLog: jest.fn() }));

import prisma from '@/lib/prisma';
import { sendProviderApprovedEmail, sendProviderRejectedEmail } from '@/lib/email';
import { notifyVerificationApproved, notifyVerificationRejected } from '@/services/notification.service';
import { sendVerificationPush } from '@/services/push.service';
import { createAuditLog } from '@/services/audit.service';
import {
  approveProvider,
  becomeProvider,
  getActiveRole,
  getPendingProviders,
  getUserWithProvider,
  rejectProvider,
  switchActiveRole,
  updateProviderProfile,
} from '@/services/provider.service';

// ==================
// Fixtures
// ==================

const USER_ID = '6502a4c8d0e1f2a3b4c5d6e7';
const PROVIDER_ID = '6502a4c8d0e1f2a3b4c5d6f0';
const REASON = 'The CAC certificate you uploaded is unreadable. Please upload a clear scan and resubmit.';

const ADMIN = {
  id: '64f1c2a9e4b0a1b2c3d4e5aa',
  role: 'SUPER_ADMIN',
  ipAddress: '203.0.113.9',
  userAgent: 'EasykonnetDashboard/1.0',
};

const dates = {
  createdAt: new Date('2026-09-08T11:40:00.000Z'),
  updatedAt: new Date('2026-09-10T09:00:00.000Z'),
};

const account = {
  id: USER_ID,
  email: 'chinedu.eze@example.com',
  password: 'hashed',
  firstName: 'Chinedu',
  lastName: 'Eze',
  phone: '+2348059876543',
  profilePhoto: null as string | null,
  role: 'SERVICE_PROVIDER',
  activeRole: null as string | null,
  status: 'ACTIVE',
  isEmailVerified: true,
  pushEnabled: true,
  lastLoginAt: null,
  ...dates,
};

const profile = (overrides: Record<string, unknown> = {}) => ({
  id: PROVIDER_ID,
  userId: USER_ID,
  businessName: 'Eze Power Solutions',
  businessDescription: 'Generator servicing and house wiring in Wuse.',
  verificationStatus: 'PENDING',
  rejectionReason: null,
  address: 'Plot 45 Aminu Kano Crescent, Wuse 2',
  city: 'Abuja',
  state: 'FCT',
  country: 'Nigeria',
  latitude: 9.07,
  longitude: 7.47,
  documents: ['https://res.cloudinary.com/easykonnet/image/upload/v1/documents/nin.jpg'],
  images: ['https://res.cloudinary.com/easykonnet/image/upload/v1/providers/workshop.jpg'],
  ...dates,
  ...overrides,
});

beforeEach(() => {
  jest.resetAllMocks();
  (prisma.review.groupBy as jest.Mock).mockResolvedValue([]);
  (prisma.providerLike.groupBy as jest.Mock).mockResolvedValue([]);
  (sendProviderApprovedEmail as jest.Mock).mockResolvedValue(true);
  (sendProviderRejectedEmail as jest.Mock).mockResolvedValue(true);
  (notifyVerificationApproved as jest.Mock).mockResolvedValue({});
  (notifyVerificationRejected as jest.Mock).mockResolvedValue({});
  (sendVerificationPush as jest.Mock).mockResolvedValue({ success: true });
  (createAuditLog as jest.Mock).mockResolvedValue({});
});

// The status check reads the profile, then the response reads it with the account
const deciding = (from: string, after: Record<string, unknown>) => {
  (prisma.serviceProvider.findUnique as jest.Mock)
    .mockResolvedValueOnce(profile({ verificationStatus: from }))
    .mockResolvedValueOnce({ ...profile(after), user: account });
  (prisma.serviceProvider.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
};

// ==================
// approveProvider
// ==================

describe('approveProvider', () => {
  it('verifies a provider pending verification, tells them and writes the audit log', async () => {
    deciding('PENDING', { verificationStatus: 'VERIFIED' });

    const user = await approveProvider(PROVIDER_ID, ADMIN);

    expect(prisma.serviceProvider.updateMany).toHaveBeenCalledWith({
      where: { id: PROVIDER_ID, verificationStatus: 'PENDING' },
      data: { verificationStatus: 'VERIFIED', rejectionReason: null },
    });
    expect(user.providerProfile).toMatchObject({ verificationStatus: 'VERIFIED', rejectionReason: null });
    expect(sendProviderApprovedEmail).toHaveBeenCalledWith('chinedu.eze@example.com', 'Chinedu', 'Eze Power Solutions');
    expect(notifyVerificationApproved).toHaveBeenCalledWith(USER_ID);
    expect(sendVerificationPush).toHaveBeenCalledWith(USER_ID, 'approved');
    expect(createAuditLog).toHaveBeenCalledWith({
      action: 'VERIFY_PROVIDER',
      targetType: 'Provider',
      targetId: PROVIDER_ID,
      performedBy: ADMIN.id,
      performedByRole: 'SUPER_ADMIN',
      previousValue: { verificationStatus: 'PENDING' },
      newValue: { verificationStatus: 'VERIFIED' },
      ipAddress: ADMIN.ipAddress,
      userAgent: ADMIN.userAgent,
    });
  });

  it.each(['UNVERIFIED', 'REJECTED'])('refuses a provider who is %s', async (status) => {
    (prisma.serviceProvider.findUnique as jest.Mock).mockResolvedValue(profile({ verificationStatus: status }));

    await expect(approveProvider(PROVIDER_ID, ADMIN)).rejects.toMatchObject({
      message: 'Only providers pending verification can be approved',
      extensions: { code: 'NOT_PENDING' },
    });
    expect(prisma.serviceProvider.updateMany).not.toHaveBeenCalled();
    expect(sendProviderApprovedEmail).not.toHaveBeenCalled();
    expect(notifyVerificationApproved).not.toHaveBeenCalled();
    expect(createAuditLog).not.toHaveBeenCalled();
  });

  it('refuses a provider who is already verified', async () => {
    (prisma.serviceProvider.findUnique as jest.Mock).mockResolvedValue(profile({ verificationStatus: 'VERIFIED' }));

    await expect(approveProvider(PROVIDER_ID, ADMIN)).rejects.toMatchObject({
      message: 'Provider is already verified',
      extensions: { code: 'ALREADY_VERIFIED' },
    });
  });

  it('refuses when another admin decided first', async () => {
    (prisma.serviceProvider.findUnique as jest.Mock).mockResolvedValue(profile({ verificationStatus: 'PENDING' }));
    (prisma.serviceProvider.updateMany as jest.Mock).mockResolvedValue({ count: 0 });

    await expect(approveProvider(PROVIDER_ID, ADMIN)).rejects.toMatchObject({ extensions: { code: 'NOT_PENDING' } });
    expect(sendProviderApprovedEmail).not.toHaveBeenCalled();
  });

  it('returns NOT_FOUND for an unknown provider', async () => {
    (prisma.serviceProvider.findUnique as jest.Mock).mockResolvedValue(null);

    await expect(approveProvider(PROVIDER_ID, ADMIN)).rejects.toMatchObject({
      message: 'Provider not found',
      extensions: { code: 'NOT_FOUND' },
    });
  });
});

// ==================
// rejectProvider
// ==================

describe('rejectProvider', () => {
  it.each(['PENDING', 'UNVERIFIED', 'REJECTED'])(
    'rejects a %s provider, saves the reason and tells them',
    async (status) => {
      deciding(status, { verificationStatus: 'REJECTED', rejectionReason: REASON });

      const user = await rejectProvider(PROVIDER_ID, `  ${REASON}  `, ADMIN);

      expect(prisma.serviceProvider.updateMany).toHaveBeenCalledWith({
        where: { id: PROVIDER_ID, verificationStatus: { not: 'VERIFIED' } },
        data: { verificationStatus: 'REJECTED', rejectionReason: REASON },
      });
      expect(user.providerProfile).toMatchObject({ verificationStatus: 'REJECTED', rejectionReason: REASON });
      expect(sendProviderRejectedEmail).toHaveBeenCalledWith(
        'chinedu.eze@example.com',
        'Chinedu',
        'Eze Power Solutions',
        REASON
      );
      expect(notifyVerificationRejected).toHaveBeenCalledWith(USER_ID, REASON);
      expect(sendVerificationPush).toHaveBeenCalledWith(USER_ID, 'rejected', REASON);
      expect(createAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'REJECT_PROVIDER',
          targetType: 'Provider',
          targetId: PROVIDER_ID,
          performedBy: ADMIN.id,
          previousValue: { verificationStatus: status },
          newValue: { verificationStatus: 'REJECTED' },
          reason: REASON,
        })
      );
    }
  );

  it('refuses an empty reason before looking anything up', async () => {
    await expect(rejectProvider(PROVIDER_ID, '   ', ADMIN)).rejects.toMatchObject({
      message: 'A reason is required',
      extensions: { code: 'INVALID_INPUT' },
    });
    expect(prisma.serviceProvider.findUnique).not.toHaveBeenCalled();
  });

  it('refuses a verified provider', async () => {
    (prisma.serviceProvider.findUnique as jest.Mock).mockResolvedValue(profile({ verificationStatus: 'VERIFIED' }));

    await expect(rejectProvider(PROVIDER_ID, REASON, ADMIN)).rejects.toMatchObject({
      message: 'Cannot reject an already verified provider',
      extensions: { code: 'ALREADY_VERIFIED' },
    });
    expect(prisma.serviceProvider.updateMany).not.toHaveBeenCalled();
  });

  it('still notifies and logs when the email fails', async () => {
    deciding('PENDING', { verificationStatus: 'REJECTED', rejectionReason: REASON });
    (sendProviderRejectedEmail as jest.Mock).mockRejectedValue(new Error('email provider unavailable'));
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(rejectProvider(PROVIDER_ID, REASON, ADMIN)).resolves.toBeDefined();
    expect(notifyVerificationRejected).toHaveBeenCalled();
    expect(createAuditLog).toHaveBeenCalled();

    consoleError.mockRestore();
  });
});

// ==================
// becomeProvider
// ==================

describe('becomeProvider — address and names', () => {
  const input = {
    businessName: 'Hair & Makeup by Ada (Lekki)',
    businessDescription: 'Bridal hair and makeup across Lagos.',
    address: '14 Admiralty Way',
    city: 'Lekki, Lagos',
    state: 'Lagos',
    country: 'Nigeria',
  };

  beforeEach(() => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue({ ...account, role: 'SERVICE_USER', provider: null });
    (prisma.$transaction as jest.Mock).mockImplementation(async (run: (tx: unknown) => unknown) =>
      run({
        serviceProvider: {
          create: jest.fn(async ({ data }: { data: Record<string, unknown> }) =>
            profile({ ...data, verificationStatus: 'UNVERIFIED', documents: [], images: [] })
          ),
        },
        user: { update: jest.fn(async () => ({ ...account, role: 'SERVICE_PROVIDER' })) },
      })
    );
  });

  it.each([
    ['an empty address', ''],
    ['a blank address', '   '],
    ['an address that is only tags', '<b></b>'],
  ])('refuses %s', async (_label, address) => {
    await expect(becomeProvider(USER_ID, { ...input, address })).rejects.toMatchObject({
      message: 'Address is required',
      extensions: { code: 'INVALID_INPUT' },
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('accepts punctuation in the business name and city, and returns the new profile', async () => {
    const result = await becomeProvider(USER_ID, input);

    expect(result.user.providerProfile).toMatchObject({
      userId: USER_ID,
      businessName: 'Hair & Makeup by Ada (Lekki)',
      city: 'Lekki, Lagos',
      verificationStatus: 'UNVERIFIED',
      images: [],
      documents: [],
      averageRating: 0,
      totalReviews: 0,
      likeCount: 0,
    });
  });

  it('still refuses symbols outside the allowed punctuation', async () => {
    await expect(becomeProvider(USER_ID, { ...input, businessName: 'Ada Glam!!!' })).rejects.toMatchObject({
      message: 'Business name contains invalid characters',
    });
  });
});

// ==================
// updateProviderProfile
// ==================

describe('updateProviderProfile — address and profile photo', () => {
  const PHOTO = 'https://res.cloudinary.com/easykonnet/image/upload/v1/profiles/chinedu.jpg';

  const editing = (user: typeof account) => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue({
      ...user,
      provider: profile({ verificationStatus: 'UNVERIFIED' }),
    });
    (prisma.serviceProvider.update as jest.Mock).mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      profile({ verificationStatus: 'UNVERIFIED', ...data })
    );
    (prisma.user.update as jest.Mock).mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      ...user,
      ...data,
    }));
  };

  it.each([
    ['an empty address', ''],
    ['a null address', null],
  ])('refuses %s', async (_label, address) => {
    editing(account);

    await expect(
      updateProviderProfile(USER_ID, { address: address as unknown as string })
    ).rejects.toMatchObject({ message: 'Address is required', extensions: { code: 'INVALID_INPUT' } });
    expect(prisma.serviceProvider.update).not.toHaveBeenCalled();
  });

  it('saves profilePhoto to the account', async () => {
    editing(account);

    const user = await updateProviderProfile(USER_ID, { profilePhoto: PHOTO });

    expect(prisma.user.update).toHaveBeenCalledWith({ where: { id: USER_ID }, data: { profilePhoto: PHOTO } });
    expect(prisma.serviceProvider.update).not.toHaveBeenCalled();
    expect(user.profilePhoto).toBe(PHOTO);
  });

  it.each([
    ['null', null],
    ['an empty string', ''],
  ])('removes the photo when profilePhoto is %s', async (_label, profilePhoto) => {
    editing({ ...account, profilePhoto: PHOTO });

    const user = await updateProviderProfile(USER_ID, { profilePhoto });

    expect(prisma.user.update).toHaveBeenCalledWith({ where: { id: USER_ID }, data: { profilePhoto: null } });
    expect(user.profilePhoto).toBeNull();
  });

  it('does not write the account when the photo is unchanged', async () => {
    editing({ ...account, profilePhoto: PHOTO });

    await updateProviderProfile(USER_ID, { profilePhoto: PHOTO, city: 'Garki, Abuja' });

    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(prisma.serviceProvider.update).toHaveBeenCalledWith({
      where: { id: PROVIDER_ID },
      data: { city: 'Garki, Abuja' },
    });
  });

  it('refuses a profilePhoto that is not a URL and saves nothing', async () => {
    editing(account);

    await expect(
      updateProviderProfile(USER_ID, { city: 'Garki, Abuja', profilePhoto: 'chinedu.jpg' })
    ).rejects.toMatchObject({ message: 'Invalid URL', extensions: { code: 'INVALID_URL' } });
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(prisma.serviceProvider.update).not.toHaveBeenCalled();
  });
});

// ==================
// Profile shape
// ==================

describe('provider profile shape', () => {
  it('returns the gallery, the owner and the rating and like counts', async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue({
      ...account,
      provider: profile({ verificationStatus: 'VERIFIED' }),
    });
    (prisma.review.groupBy as jest.Mock).mockResolvedValue([
      { providerId: PROVIDER_ID, _avg: { rating: 4.66 }, _count: { _all: 3 } },
    ]);
    (prisma.providerLike.groupBy as jest.Mock).mockResolvedValue([{ providerId: PROVIDER_ID, _count: { _all: 7 } }]);

    const user = await getUserWithProvider(USER_ID);

    expect(user.providerProfile).toEqual({
      id: PROVIDER_ID,
      userId: USER_ID,
      businessName: 'Eze Power Solutions',
      businessDescription: 'Generator servicing and house wiring in Wuse.',
      verificationStatus: 'VERIFIED',
      rejectionReason: null,
      address: 'Plot 45 Aminu Kano Crescent, Wuse 2',
      city: 'Abuja',
      state: 'FCT',
      country: 'Nigeria',
      latitude: 9.07,
      longitude: 7.47,
      documents: ['https://res.cloudinary.com/easykonnet/image/upload/v1/documents/nin.jpg'],
      images: ['https://res.cloudinary.com/easykonnet/image/upload/v1/providers/workshop.jpg'],
      averageRating: 4.7,
      totalReviews: 3,
      likeCount: 7,
      isLiked: null,
      createdAt: '2026-09-08T11:40:00.000Z',
      updatedAt: '2026-09-10T09:00:00.000Z',
    });
  });

  it('skips the counts for an account without a provider profile', async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue({ ...account, role: 'SERVICE_USER', provider: null });

    const user = await getUserWithProvider(USER_ID);

    expect(user.providerProfile).toBeNull();
    expect(prisma.review.groupBy).not.toHaveBeenCalled();
  });

  it('counts reviews and likes once for a page of pending providers', async () => {
    const second = '6502a4c8d0e1f2a3b4c5d6f1';
    (prisma.serviceProvider.findMany as jest.Mock).mockResolvedValue([
      { ...profile(), user: account },
      { ...profile({ id: second }), user: account },
    ]);
    (prisma.serviceProvider.count as jest.Mock).mockResolvedValue(2);

    const result = await getPendingProviders({ page: 1, limit: 10 });

    expect(prisma.review.groupBy).toHaveBeenCalledTimes(1);
    expect(prisma.review.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({ where: { providerId: { in: [PROVIDER_ID, second] } } })
    );
    expect(result.items.map((item) => item.providerProfile?.images)).toEqual([profile().images, profile().images]);
  });
});

// ==================
// switchActiveRole
// ==================

describe('switchActiveRole — who can switch', () => {
  it('refuses a customer account that has a provider profile, as myActiveRole.canSwitch does', async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue({ ...account, role: 'SERVICE_USER', provider: profile() });

    await expect(switchActiveRole(USER_ID, 'SERVICE_PROVIDER')).rejects.toMatchObject({
      message: 'You must be a registered provider to switch roles. Use becomeProvider first.',
      extensions: { code: 'NOT_PROVIDER' },
    });
    expect(prisma.user.update).not.toHaveBeenCalled();
    await expect(getActiveRole(USER_ID)).resolves.toMatchObject({ canSwitch: false, hasProviderProfile: true });
  });

  it('refuses a provider account without a profile', async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue({ ...account, provider: null });

    await expect(switchActiveRole(USER_ID, 'SERVICE_USER')).rejects.toMatchObject({
      extensions: { code: 'NOT_PROVIDER' },
    });
  });

  it('switches a provider into customer mode', async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue({
      ...account,
      provider: profile({ verificationStatus: 'VERIFIED' }),
    });
    (prisma.user.update as jest.Mock).mockResolvedValue({ ...account, activeRole: 'SERVICE_USER' });

    const user = await switchActiveRole(USER_ID, 'SERVICE_USER');

    expect(prisma.user.update).toHaveBeenCalledWith({ where: { id: USER_ID }, data: { activeRole: 'SERVICE_USER' } });
    expect(user).toMatchObject({ activeRole: 'SERVICE_USER', providerProfile: { id: PROVIDER_ID } });
    await expect(getActiveRole(USER_ID)).resolves.toMatchObject({ canSwitch: true });
  });
});
