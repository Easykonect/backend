/**
 * Provider Service Tests
 *
 * Covers the description-validation fix:
 *   - businessDescription must be 10-250 chars (was: rejecting <10000 chars)
 *   - address arg-order bug fixed (was: rejecting <255 chars)
 * Both for becomeProvider and updateProviderProfile.
 */

import { GraphQLError } from 'graphql';

// ==================
// Mocks
// ==================

jest.mock('@/lib/prisma', () => ({
  __esModule: true,
  default: {
    user: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    serviceProvider: {
      create: jest.fn(),
      update: jest.fn(),
    },
    $transaction: jest.fn(async (fn: any) => {
      const tx = {
        serviceProvider: {
          create: jest.fn().mockResolvedValue({
            id: 'provider1',
            businessName: 'My Biz',
            businessDescription: 'A short description here',
            address: '1 Main St',
            city: 'Lagos',
            state: 'Lagos',
            country: 'Nigeria',
            latitude: 6.5,
            longitude: 3.3,
            verificationStatus: 'UNVERIFIED',
            documents: [],
            images: [],
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
        },
        user: {
          update: jest.fn().mockResolvedValue({
            id: 'user1',
            email: 'u@example.com',
            firstName: 'Ada',
            lastName: 'Lovelace',
            phone: '+2341234567890',
            role: 'SERVICE_PROVIDER',
            isEmailVerified: true,
            status: 'ACTIVE',
            profilePhoto: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
        },
      };
      return fn(tx);
    }),
  },
}));

jest.mock('@/lib/auth', () => ({
  generateToken: jest.fn().mockReturnValue('access-token'),
  generateRefreshToken: jest.fn().mockReturnValue('refresh-token'),
}));

jest.mock('@/services/token.service', () => ({
  storeRefreshToken: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/lib/email', () => ({
  sendProviderApprovedEmail: jest.fn().mockResolvedValue(undefined),
  sendProviderRejectedEmail: jest.fn().mockResolvedValue(undefined),
  sendProviderSubmissionEmail: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/services/report.service', () => ({
  flagContent: jest.fn(),
}));

jest.mock('@/services/notification.service', () => ({
  notifyVerificationApproved: jest.fn(),
  notifyVerificationRejected: jest.fn(),
}));

jest.mock('@/services/push.service', () => ({ sendVerificationPush: jest.fn() }));

jest.mock('@/services/audit.service', () => ({ createAuditLog: jest.fn() }));

// Rating and like counts are covered in provider-verification.test.ts
jest.mock('@/services/provider-profile.service', () => ({
  ...jest.requireActual('@/services/provider-profile.service'),
  loadProviderStats: async () => new Map(),
}));

import prisma from '@/lib/prisma';
import { flagContent } from '@/services/report.service';
import { becomeProvider, updateProviderProfile } from '@/services/provider.service';

// ==================
// Fixtures
// ==================

const userId = '507f1f77bcf86cd700000001';
const baseUser = {
  id: userId,
  email: 'u@example.com',
  firstName: 'Ada',
  lastName: 'Lovelace',
  phone: '+2341234567890',
  role: 'SERVICE_USER',
  isEmailVerified: true,
  status: 'ACTIVE',
  profilePhoto: null,
  provider: null,
  createdAt: new Date('2025-01-01T00:00:00.000Z'),
  updatedAt: new Date('2025-01-01T00:00:00.000Z'),
};

const validInput = {
  businessName: 'My Cleaning Biz',
  businessDescription: 'We do quality home cleaning in Lagos.',
  address: '1 Main St',
  city: 'Lagos',
  state: 'Lagos',
  country: 'Nigeria',
  latitude: 6.5244,
  longitude: 3.3792,
};

beforeEach(() => {
  // clearAllMocks only clears call history; mockResolvedValueOnce queues
  // persist across tests. Reset implementations for the prisma fns we
  // inject per-test, but leave the $transaction factory alone (it's set
  // once at module mock time).
  (prisma.user.findUnique as jest.Mock).mockReset();
  (prisma.user.update as jest.Mock).mockReset();
  (prisma.serviceProvider.create as jest.Mock).mockReset();
  (prisma.serviceProvider.update as jest.Mock).mockReset();
});

// ==================
// becomeProvider — description validation
// ==================

describe('becomeProvider — businessDescription validation', () => {
  it('accepts a description within 10-250 characters', async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValueOnce(baseUser);

    await expect(becomeProvider(userId, validInput)).resolves.toBeDefined();
  });

  it('rejects a description shorter than 10 characters', async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValueOnce(baseUser);

    await expect(
      becomeProvider(userId, { ...validInput, businessDescription: 'short' })
    ).rejects.toThrow(/at least 10 characters/);
  });

  it('rejects a description longer than 250 characters', async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValueOnce(baseUser);
    const longDesc = 'x'.repeat(251);

    await expect(
      becomeProvider(userId, { ...validInput, businessDescription: longDesc })
    ).rejects.toThrow(/at most 250 characters/);
  });

  it('does NOT require >= 255 characters for address (regression: arg-order bug)', async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValueOnce(baseUser);

    // Short address would have failed the old buggy validation that
    // passed MAX_LENGTHS.SHORT_TEXT (255) as the *minimum*.
    await expect(
      becomeProvider(userId, { ...validInput, address: '1 Main St' })
    ).resolves.toBeDefined();
  });

  it('omitted businessDescription is allowed (it is optional)', async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValueOnce(baseUser);

    const { businessDescription, ...rest } = validInput;
    await expect(becomeProvider(userId, rest as any)).resolves.toBeDefined();
  });
});

// ==================
// updateProviderProfile — description validation
// ==================

describe('updateProviderProfile — businessDescription validation', () => {
  const providerUser = {
    ...baseUser,
    role: 'SERVICE_PROVIDER',
    provider: { id: 'provider1', userId },
  };

  const mockUpdated = {
    id: 'provider1',
    businessName: 'My Biz',
    businessDescription: 'New description that is long enough.',
    address: '1 Main St',
    city: 'Lagos',
    state: 'Lagos',
    country: 'Nigeria',
    latitude: 6.5,
    longitude: 3.3,
    verificationStatus: 'UNVERIFIED',
    documents: [],
    images: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  it('accepts a description within 10-250 characters', async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValueOnce(providerUser);
    (prisma.serviceProvider.update as jest.Mock).mockResolvedValueOnce(mockUpdated);

    await expect(
      updateProviderProfile(userId, { businessDescription: 'New description for the biz' })
    ).resolves.toBeDefined();
  });

  it('rejects a description shorter than 10 characters', async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValueOnce(providerUser);

    let caught: GraphQLError | undefined;
    await updateProviderProfile(userId, { businessDescription: 'too' }).catch(
      (e) => (caught = e)
    );
    expect(caught).toBeInstanceOf(GraphQLError);
    expect(caught!.message).toMatch(/at least 10 characters/);
  });

  it('rejects a description longer than 250 characters', async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValueOnce(providerUser);

    const longDesc = 'x'.repeat(251);
    await expect(
      updateProviderProfile(userId, { businessDescription: longDesc })
    ).rejects.toThrow(/at most 250 characters/);
  });
});

// ==================
// Screening, and review of verified profiles
// ==================

describe('becomeProvider — screening', () => {
  it.each([
    [{ businessName: 'Bitch Please Cleaning' }, 'INAPPROPRIATE_CONTENT'],
    [{ businessDescription: 'Quality cleaning, no bullshit, every day' }, 'INAPPROPRIATE_CONTENT'],
    [{ businessName: 'Ada Cleaning 08031234567' }, 'CONTACT_DETAILS_NOT_ALLOWED'],
    [{ businessDescription: 'Book us at bookings@adaclean.ng today' }, 'CONTACT_DETAILS_NOT_ALLOWED'],
  ])('rejects %j with %s and creates no profile', async (edit, code) => {
    await expect(becomeProvider(userId, { ...validInput, ...edit })).rejects.toMatchObject({
      extensions: { code },
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe('updateProviderProfile — screening and review of verified profiles', () => {
  const verifiedProfile = {
    id: 'provider1',
    userId,
    businessName: 'Ada Cleaning',
    businessDescription: 'Quality home cleaning in Lagos.',
    address: '1 Main St',
    city: 'Lagos',
    state: 'Lagos',
    country: 'Nigeria',
    latitude: 6.5,
    longitude: 3.3,
    verificationStatus: 'VERIFIED',
    documents: [],
    images: [],
    createdAt: new Date('2025-01-01T00:00:00.000Z'),
    updatedAt: new Date('2025-01-01T00:00:00.000Z'),
  };

  const editing = (provider: typeof verifiedProfile) => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue({ ...baseUser, role: 'SERVICE_PROVIDER', provider });
    (prisma.serviceProvider.update as jest.Mock).mockImplementation(
      async ({ data }: { data: Record<string, unknown> }) => ({ ...provider, ...data })
    );
  };

  it.each([
    [{ businessName: 'Fucking Fast Cleaners' }, 'INAPPROPRIATE_CONTENT'],
    [{ businessDescription: 'Quality cleaning, none of that shit' }, 'INAPPROPRIATE_CONTENT'],
    [{ businessName: 'Ada Cleaning 08031234567' }, 'CONTACT_DETAILS_NOT_ALLOWED'],
    [{ businessDescription: 'WhatsApp 0803 123 4567 for cheaper prices' }, 'CONTACT_DETAILS_NOT_ALLOWED'],
  ])('rejects %j with %s and saves nothing', async (edit, code) => {
    editing(verifiedProfile);

    await expect(updateProviderProfile(userId, edit)).rejects.toMatchObject({ extensions: { code } });
    expect(prisma.serviceProvider.update).not.toHaveBeenCalled();
    expect(flagContent).not.toHaveBeenCalled();
  });

  it.each([
    [{ businessName: 'Ada Home Cleaning' }],
    [{ businessDescription: 'Quality home and office cleaning in Lagos.' }],
  ])('flags a VERIFIED profile for admins after an edit of %j', async (edit) => {
    editing(verifiedProfile);

    await updateProviderProfile(userId, edit);

    const before = {
      businessName: verifiedProfile.businessName,
      businessDescription: verifiedProfile.businessDescription,
    };
    expect(flagContent).toHaveBeenCalledTimes(1);
    expect(flagContent).toHaveBeenCalledWith({
      targetType: 'PROVIDER',
      targetId: 'provider1',
      targetUserId: userId,
      reason: 'OTHER',
      details: expect.any(String),
      snapshot: { before, after: { ...before, ...edit } },
    });
  });

  it('does not flag an unverified profile', async () => {
    editing({ ...verifiedProfile, verificationStatus: 'UNVERIFIED' });

    await updateProviderProfile(userId, { businessName: 'Ada Home Cleaning' });

    expect(prisma.serviceProvider.update).toHaveBeenCalled();
    expect(flagContent).not.toHaveBeenCalled();
  });

  it('does not flag a VERIFIED profile when the name and description are unchanged', async () => {
    editing(verifiedProfile);

    await updateProviderProfile(userId, {
      businessName: verifiedProfile.businessName,
      businessDescription: verifiedProfile.businessDescription,
      city: 'Ikeja',
    });

    expect(prisma.serviceProvider.update).toHaveBeenCalled();
    expect(flagContent).not.toHaveBeenCalled();
  });
});
