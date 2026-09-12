/**
 * Dispute service: raising a dispute (or reopening one after a redo), who can
 * see a booking's dispute, the evidence rules, taking a dispute under review,
 * and settling one (how much is refunded, where the booking goes, and the money
 * moved through the real escrow and wallet services)
 */

import { GraphQLError } from 'graphql';

jest.mock('@/lib/prisma', () => ({
  __esModule: true,
  default: {
    booking: { findUnique: jest.fn(), update: jest.fn() },
    dispute: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    serviceProvider: { findUnique: jest.fn() },
    user: { findMany: jest.fn() },
    wallet: { findUnique: jest.fn(), create: jest.fn() },
    $transaction: jest.fn(),
  },
}));
jest.mock('@/config', () => {
  const actual = jest.requireActual<typeof import('@/config')>('@/config');
  return {
    ...actual,
    config: { ...actual.config, cloudinary: { ...actual.config.cloudinary, cloudName: 'easykonnet-test' } },
  };
});
jest.mock('@/services/notification.service', () => ({
  createNotification: jest.fn(),
  createBulkNotifications: jest.fn(),
}));
jest.mock('@/services/push.service', () => ({ sendPushToUser: jest.fn() }));
jest.mock('@/services/audit.service', () => ({ createAuditLog: jest.fn() }));

import prisma from '@/lib/prisma';
import { config } from '@/config';
import { createAuditLog } from '@/services/audit.service';
import { createBulkNotifications, createNotification } from '@/services/notification.service';
import { sendPushToUser } from '@/services/push.service';
import {
  addDisputeEvidence,
  bookingAfterResolution,
  closeDispute,
  createDispute,
  getBookingDispute,
  getDisputeById,
  getMyDisputes,
  isEvidenceUrl,
  refundForResolution,
  resolveDispute,
  takeDisputeUnderReview,
} from '@/services/dispute.service';

const customerId = '507f1f77bcf86cd799439011';
const providerUserId = '507f1f77bcf86cd799439022';
const adminId = '507f1f77bcf86cd799439044';
const superAdminId = '507f1f77bcf86cd799439045';
const outsiderId = '507f1f77bcf86cd799439088';
const disputeId = '507f1f77bcf86cd799439055';
const paymentId = '507f1f77bcf86cd799439066';
const walletId = '507f1f77bcf86cd799439077';
const providerId = '507f1f77bcf86cd799439099';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const DESCRIPTION = 'The provider never arrived at the address.';

const CLOUD = 'https://res.cloudinary.com/easykonnet-test';

/**
 * An evidence file `owner` uploaded to the (mocked) Easykonnet Cloudinary
 * account, named as getEvidenceUploadParams uploads are
 */
const evidenceUrl = (name: string, owner: string = customerId) =>
  `${CLOUD}/image/upload/v1789218000/easykonect/evidence/${owner}_1789218000_${name}.jpg`;

const EVIDENCE_MESSAGE =
  'Evidence must be files you uploaded through Easykonnet. Upload each file first, then send the URL you get back.';

const booking = {
  id: '507f1f77bcf86cd799439033',
  userId: customerId,
  provider: { userId: providerUserId },
  service: { name: 'Deep Cleaning' },
  status: 'COMPLETED',
  completedAt: new Date(),
  paymentReleaseAt: null as Date | null,
  paymentReleasedAt: null as Date | null,
  dispute: null,
};

/** A booking whose dispute was resolved with REDO_SERVICE, now being redone */
const redoBooking = (evidence: string[] = [evidenceUrl('first')]) => ({
  ...booking,
  status: 'IN_PROGRESS',
  completedAt: null,
  dispute: {
    id: 'dispute-1',
    status: 'RESOLVED',
    resolution: 'REDO_SERVICE',
    resolutionNotes: 'Provider to redo the cleaning',
    previousBookingStatus: 'COMPLETED',
    raisedById: customerId,
    raisedByRole: 'SERVICE_USER',
    evidence,
  },
});

const reopenInput = {
  bookingId: booking.id,
  reason: 'Customer refused access for the redo',
  description: 'The customer did not open the door at the agreed time.',
};

const input = (description: string) => ({
  bookingId: booking.id,
  reason: 'Service was not delivered',
  description,
});

/** A booking as the dispute queries include it */
const disputeBooking = {
  id: booking.id,
  userId: customerId,
  status: 'DISPUTED',
  scheduledDate: new Date('2026-09-08T00:00:00.000Z'),
  scheduledTime: '10:00',
  servicePrice: 5000,
  totalAmount: 5000,
  user: { id: customerId, firstName: 'Chiamaka', lastName: 'Okafor', email: 'chiamaka@example.com' },
  provider: {
    id: providerId,
    userId: providerUserId,
    businessName: 'Sparkle Cleaners',
    user: { id: providerUserId, firstName: 'Tunde', lastName: 'Bakare', email: 'tunde@example.com' },
  },
  service: { id: '507f1f77bcf86cd7994390aa', name: 'Deep Cleaning', price: 5000 },
};

const disputeRow = (fields: Record<string, unknown> = {}) => ({
  id: disputeId,
  reason: 'Service was not delivered',
  description: DESCRIPTION,
  evidence: [],
  status: 'OPEN',
  raisedByRole: 'SERVICE_USER',
  reviewedById: null,
  reviewStartedAt: null,
  resolution: null,
  resolutionNotes: null,
  refundAmount: null,
  resolvedAt: null,
  createdAt: new Date('2026-09-10T09:30:00.000Z'),
  updatedAt: new Date('2026-09-10T09:30:00.000Z'),
  booking: disputeBooking,
  ...fields,
});

const WINDOW_MESSAGE =
  "Dispute window has expired. Disputes can be raised until the provider's payment is released: 24 hours after the customer confirms delivery, or 7 days after the job is completed if they don't.";

/** Run withTransaction's callback against the given transaction client */
const runTransactionWith = (tx: object) => {
  (prisma.$transaction as jest.Mock).mockImplementation(async (fn: (client: object) => Promise<unknown>) => fn(tx));
};

/** The GraphQL error a synchronous call throws, or null if it returns */
const errorOf = (run: () => unknown): { code: unknown; message: string } | null => {
  try {
    run();
  } catch (error) {
    if (error instanceof GraphQLError) return { code: error.extensions.code, message: error.message };
    throw error;
  }
  return null;
};

const errorCode = (run: () => unknown): unknown => errorOf(run)?.code ?? null;

beforeEach(() => {
  jest.resetAllMocks();
});

describe('createDispute', () => {
  const makeTx = () => ({
    booking: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    dispute: {
      create: jest.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
        ...disputeRow({ id: 'dispute-1', booking: null }),
        ...data,
      })),
      // A reopened dispute
      update: jest.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
        ...disputeRow({ id: 'dispute-1', booking: null }),
        ...data,
      })),
    },
  });

  let tx: ReturnType<typeof makeTx>;

  beforeEach(() => {
    (prisma.booking.findUnique as jest.Mock).mockResolvedValue(booking);
    (prisma.user.findMany as jest.Mock).mockResolvedValue([]);
    tx = makeTx();
    runTransactionWith(tx);
  });

  it('accepts a normal-length description', async () => {
    const result = await createDispute(customerId, 'SERVICE_USER', input(DESCRIPTION));

    expect(result.status).toBe('OPEN');
    expect(prisma.$transaction).toHaveBeenCalled();

    // Only an unchanged booking whose payment is still held becomes DISPUTED
    expect(tx.booking.updateMany).toHaveBeenCalledWith({
      where: {
        id: booking.id,
        status: 'COMPLETED',
        OR: [{ paymentReleasedAt: null }, { paymentReleasedAt: { isSet: false } }],
      },
      data: { status: 'DISPUTED' },
    });
    expect(tx.dispute.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          bookingId: booking.id,
          raisedById: customerId,
          raisedByRole: 'SERVICE_USER',
          status: 'OPEN',
          previousBookingStatus: 'COMPLETED',
          evidence: [],
        }),
      })
    );
    // The other party is told, in-app and by push
    expect(createNotification).toHaveBeenCalledWith(
      expect.objectContaining({ userId: providerUserId, type: 'DISPUTE_OPENED', entityId: 'dispute-1' })
    );
    expect(sendPushToUser).toHaveBeenCalledWith(providerUserId, {
      title: 'Dispute opened',
      message: 'A dispute has been opened for the booking of Deep Cleaning. Easykonnet will review it.',
      data: { type: 'DISPUTE_OPENED', disputeId: 'dispute-1', bookingId: booking.id },
    });
  });

  it('marks the in-app notification as pushed when the push goes out', async () => {
    (createNotification as jest.Mock).mockResolvedValue({ id: 'notification-1' });

    await createDispute(customerId, 'SERVICE_USER', input(DESCRIPTION));

    expect(sendPushToUser).toHaveBeenCalledWith(
      providerUserId,
      expect.objectContaining({ notificationId: 'notification-1' })
    );
  });

  it('rejects descriptions shorter than 20 characters', async () => {
    await expect(
      createDispute(customerId, 'SERVICE_USER', input('Too short'))
    ).rejects.toMatchObject({ extensions: { code: 'INVALID_INPUT' } });
  });

  it('rejects descriptions longer than 10,000 characters', async () => {
    await expect(
      createDispute(customerId, 'SERVICE_USER', input('x'.repeat(10_001)))
    ).rejects.toThrow(GraphQLError);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('refuses a booking whose payment was already released', async () => {
    (prisma.booking.findUnique as jest.Mock).mockResolvedValue({ ...booking, paymentReleasedAt: new Date() });

    await expect(
      createDispute(customerId, 'SERVICE_USER', input(DESCRIPTION))
    ).rejects.toMatchObject({
      message: expect.stringMatching(/already been released/),
      extensions: { code: 'DISPUTE_WINDOW_EXPIRED' },
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('throws INVALID_BOOKING_STATUS when the conditional booking update matches nothing', async () => {
    tx.booking.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      createDispute(customerId, 'SERVICE_USER', input(DESCRIPTION))
    ).rejects.toMatchObject({ extensions: { code: 'INVALID_BOOKING_STATUS' } });
    expect(tx.dispute.create).not.toHaveBeenCalled();
    expect(createNotification).not.toHaveBeenCalled();
    expect(sendPushToUser).not.toHaveBeenCalled();
    expect(createBulkNotifications).not.toHaveBeenCalled();
  });

  it('reopens a dispute resolved with REDO_SERVICE, keeping its evidence and clearing the old resolution and review', async () => {
    // The redo is under way, and this time the provider raises the dispute
    (prisma.booking.findUnique as jest.Mock).mockResolvedValue(redoBooking());

    const result = await createDispute(providerUserId, 'SERVICE_PROVIDER', {
      ...reopenInput,
      evidence: [evidenceUrl('second', providerUserId)],
    });

    // The same conditional booking claim as a new dispute, made first
    expect(tx.booking.updateMany).toHaveBeenCalledWith({
      where: {
        id: booking.id,
        status: 'IN_PROGRESS',
        OR: [{ paymentReleasedAt: null }, { paymentReleasedAt: { isSet: false } }],
      },
      data: { status: 'DISPUTED' },
    });
    expect(tx.booking.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
      tx.dispute.update.mock.invocationCallOrder[0]
    );

    // The existing dispute is reused, not a second one created
    expect(tx.dispute.create).not.toHaveBeenCalled();
    expect(tx.dispute.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'dispute-1' },
        data: {
          raisedById: providerUserId,
          raisedByRole: 'SERVICE_PROVIDER',
          reason: 'Customer refused access for the redo',
          description: 'The customer did not open the door at the agreed time.',
          status: 'OPEN',
          previousBookingStatus: 'IN_PROGRESS',
          evidence: [evidenceUrl('first'), evidenceUrl('second', providerUserId)],
          reviewedById: null,
          reviewStartedAt: null,
          resolution: null,
          resolutionNotes: null,
          refundAmount: null,
          resolvedById: null,
          resolvedAt: null,
        },
      })
    );

    // The other party (the customer, this time) is told
    expect(createNotification).toHaveBeenCalledWith(
      expect.objectContaining({ userId: customerId, type: 'DISPUTE_OPENED', entityId: 'dispute-1' })
    );
    expect(result.status).toBe('OPEN');
  });

  // Only a RESOLVED dispute whose resolution was REDO_SERVICE can be reopened
  const blockingDisputes: Array<[string, string | null]> = [
    ['OPEN', null],
    ['UNDER_REVIEW', null],
    ['CLOSED', 'DISMISSED'],
    ['CLOSED', 'REDO_SERVICE'],
    ['RESOLVED', 'NO_REFUND'],
    ['RESOLVED', 'REFUND_FULL'],
    ['RESOLVED', 'REFUND_PARTIAL'],
    ['RESOLVED', 'MUTUAL_AGREEMENT'],
  ];

  it.each(blockingDisputes)(
    'throws DISPUTE_EXISTS when the existing dispute is %s with resolution %s',
    async (status, resolution) => {
      (prisma.booking.findUnique as jest.Mock).mockResolvedValue({
        ...booking,
        dispute: { id: 'dispute-1', status, resolution, evidence: [] },
      });

      await expect(
        createDispute(customerId, 'SERVICE_USER', input(DESCRIPTION))
      ).rejects.toMatchObject({ extensions: { code: 'DISPUTE_EXISTS' } });
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(createNotification).not.toHaveBeenCalled();
    }
  );

  describe('who can raise it', () => {
    const notFound = { message: 'Booking not found', extensions: { code: 'NOT_FOUND' } };

    it('gives someone not on the booking the same NOT_FOUND as a missing booking, even when it has a dispute', async () => {
      (prisma.booking.findUnique as jest.Mock).mockResolvedValue({
        ...booking,
        dispute: { id: 'dispute-1', status: 'OPEN', resolution: null, evidence: [] },
      });

      await expect(createDispute(outsiderId, 'SERVICE_USER', input(DESCRIPTION))).rejects.toMatchObject(notFound);

      (prisma.booking.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(createDispute(outsiderId, 'SERVICE_USER', input(DESCRIPTION))).rejects.toMatchObject(notFound);
      await expect(createDispute(customerId, 'SERVICE_USER', input(DESCRIPTION))).rejects.toMatchObject(notFound);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('checks an outsider before the booking status', async () => {
      (prisma.booking.findUnique as jest.Mock).mockResolvedValue({ ...booking, status: 'CANCELLED' });

      await expect(createDispute(outsiderId, 'SERVICE_PROVIDER', input(DESCRIPTION))).rejects.toMatchObject(notFound);
    });

    it.each(['ADMIN', 'SUPER_ADMIN'])('refuses a %s with FORBIDDEN, since admins settle disputes', async (role) => {
      await expect(createDispute(adminId, role, input(DESCRIPTION))).rejects.toMatchObject({
        message: 'You are not authorized to raise a dispute for this booking',
        extensions: { code: 'FORBIDDEN' },
      });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('lets the provider raise it, and tells the customer', async () => {
      await createDispute(providerUserId, 'SERVICE_PROVIDER', input(DESCRIPTION));

      expect(tx.dispute.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ raisedByRole: 'SERVICE_PROVIDER' }) })
      );
      expect(createNotification).toHaveBeenCalledWith(expect.objectContaining({ userId: customerId }));
    });
  });

  describe('evidence', () => {
    it('saves evidence files the caller uploaded', async () => {
      const evidence = [
        evidenceUrl('kitchen'),
        `${CLOUD}/video/upload/v1789218001/easykonect/evidence/${customerId}_1789218001_walkthrough.mp4`,
      ];

      await createDispute(customerId, 'SERVICE_USER', { ...input(DESCRIPTION), evidence });

      expect(tx.dispute.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ evidence }) })
      );
    });

    const badUrls: Array<[string, string]> = [
      ['http rather than https', evidenceUrl('a').replace('https://', 'http://')],
      ['another Cloudinary account', evidenceUrl('a').replace('/easykonnet-test/', '/someone-else/')],
      ['an account whose name starts the same', evidenceUrl('a').replace('/easykonnet-test/', '/easykonnet-test-2/')],
      ['another host', evidenceUrl('a').replace('res.cloudinary.com', 'cdn.example.com')],
      ['a lookalike host', evidenceUrl('a').replace('res.cloudinary.com', 'res.cloudinary.com.example.com')],
      ['a path that leaves the account', evidenceUrl('a').replace('/easykonnet-test/', '/easykonnet-test/../someone-else/')],
      ["a file someone else uploaded", evidenceUrl('a', providerUserId)],
      ['a file outside the evidence folder', evidenceUrl('a').replace('/evidence/', '/profiles/')],
      ['a file name that only contains the user ID', evidenceUrl('a').replace(`/${customerId}_`, `/x${customerId}_`)],
      ['surrounding spaces', ` ${evidenceUrl('a')} `],
      ['a file name', 'kitchen.jpg'],
      ['an empty string', ''],
      ['a javascript URL', 'javascript:alert(1)'],
      ['more than 2048 characters', `${evidenceUrl('a')}?${'x'.repeat(2048)}`],
    ];

    it.each(badUrls)('rejects %s with INVALID_EVIDENCE_URL before looking anything up', async (_label, url) => {
      await expect(
        createDispute(customerId, 'SERVICE_USER', { ...input(DESCRIPTION), evidence: [evidenceUrl('ok'), url] })
      ).rejects.toMatchObject({
        message: EVIDENCE_MESSAGE,
        extensions: { code: 'INVALID_EVIDENCE_URL' },
      });
      expect(prisma.booking.findUnique).not.toHaveBeenCalled();
    });

    it('accepts 10 files and refuses 11 with MAX_EVIDENCE_EXCEEDED, before looking anything up', async () => {
      const ten = Array.from({ length: 10 }, (_, i) => evidenceUrl(`photo-${i}`));

      await expect(
        createDispute(customerId, 'SERVICE_USER', { ...input(DESCRIPTION), evidence: ten })
      ).resolves.toMatchObject({ status: 'OPEN' });

      (prisma.booking.findUnique as jest.Mock).mockClear();

      await expect(
        createDispute(customerId, 'SERVICE_USER', { ...input(DESCRIPTION), evidence: [...ten, evidenceUrl('one-more')] })
      ).rejects.toMatchObject({
        message: 'Maximum 10 evidence files allowed',
        extensions: { code: 'MAX_EVIDENCE_EXCEEDED' },
      });
      expect(prisma.booking.findUnique).not.toHaveBeenCalled();
    });

    it("counts the evidence a reopened dispute already has, and only needs the new files to be the caller's", async () => {
      // The customer's files from the first round
      const eight = Array.from({ length: 8 }, (_, i) => evidenceUrl(`old-${i}`));
      (prisma.booking.findUnique as jest.Mock).mockResolvedValue(redoBooking(eight));

      await expect(
        createDispute(providerUserId, 'SERVICE_PROVIDER', {
          ...reopenInput,
          evidence: ['a', 'b', 'c'].map((name) => evidenceUrl(name, providerUserId)),
        })
      ).rejects.toMatchObject({ extensions: { code: 'MAX_EVIDENCE_EXCEEDED' } });
      expect(prisma.$transaction).not.toHaveBeenCalled();

      // Two more fit
      await createDispute(providerUserId, 'SERVICE_PROVIDER', {
        ...reopenInput,
        evidence: ['a', 'b'].map((name) => evidenceUrl(name, providerUserId)),
      });
      expect(tx.dispute.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            evidence: [...eight, evidenceUrl('a', providerUserId), evidenceUrl('b', providerUserId)],
          }),
        })
      );
    });

    it('still reopens a dispute holding more than 10 files when nothing new is added', async () => {
      const eleven = Array.from({ length: 11 }, (_, i) => evidenceUrl(`old-${i}`));
      (prisma.booking.findUnique as jest.Mock).mockResolvedValue(redoBooking(eleven));

      await expect(createDispute(providerUserId, 'SERVICE_PROVIDER', reopenInput)).resolves.toMatchObject({
        status: 'OPEN',
      });
    });
  });

  describe('the dispute window', () => {
    it('stays open past 7 days when the customer confirmed late and the release is still ahead', async () => {
      (prisma.booking.findUnique as jest.Mock).mockResolvedValue({
        ...booking,
        completedAt: new Date(Date.now() - 8 * DAY_MS),
        paymentReleaseAt: new Date(Date.now() + 2 * HOUR_MS),
      });

      await expect(createDispute(customerId, 'SERVICE_USER', input(DESCRIPTION))).resolves.toMatchObject({
        status: 'OPEN',
      });
    });

    it("closes once a confirmed booking's release time has come, even before the release has run", async () => {
      (prisma.booking.findUnique as jest.Mock).mockResolvedValue({
        ...booking,
        completedAt: new Date(Date.now() - 2 * DAY_MS),
        paymentReleaseAt: new Date(Date.now() - 60_000),
      });

      await expect(createDispute(customerId, 'SERVICE_USER', input(DESCRIPTION))).rejects.toMatchObject({
        message: WINDOW_MESSAGE,
        extensions: { code: 'DISPUTE_WINDOW_EXPIRED' },
      });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('closes 7 days after completion when the customer never confirmed', async () => {
      (prisma.booking.findUnique as jest.Mock).mockResolvedValue({
        ...booking,
        completedAt: new Date(Date.now() - 7 * DAY_MS - 60_000),
      });

      await expect(createDispute(customerId, 'SERVICE_USER', input(DESCRIPTION))).rejects.toMatchObject({
        message: WINDOW_MESSAGE,
        extensions: { code: 'DISPUTE_WINDOW_EXPIRED' },
      });
    });

    it('is still open shortly before 7 days without a confirmation', async () => {
      (prisma.booking.findUnique as jest.Mock).mockResolvedValue({
        ...booking,
        completedAt: new Date(Date.now() - 7 * DAY_MS + HOUR_MS),
      });

      await expect(createDispute(customerId, 'SERVICE_USER', input(DESCRIPTION))).resolves.toMatchObject({
        status: 'OPEN',
      });
    });
  });

  describe('telling admins', () => {
    it('alerts every active admin in-app, without a push', async () => {
      (prisma.user.findMany as jest.Mock).mockResolvedValue([{ id: adminId }, { id: superAdminId }]);

      await createDispute(customerId, 'SERVICE_USER', input(DESCRIPTION));

      expect(prisma.user.findMany).toHaveBeenCalledWith({
        where: { role: { in: ['ADMIN', 'SUPER_ADMIN'] }, status: 'ACTIVE' },
        select: { id: true },
      });
      expect(createBulkNotifications).toHaveBeenCalledWith(
        [adminId, superAdminId],
        'DISPUTE_OPENED',
        'New dispute to review',
        'The customer opened a dispute about the booking of Deep Cleaning.',
        'dispute',
        'dispute-1',
        { disputeId: 'dispute-1', bookingId: booking.id }
      );
      // Only the other party gets a push
      expect(sendPushToUser).toHaveBeenCalledTimes(1);
      expect(sendPushToUser).toHaveBeenCalledWith(providerUserId, expect.anything());
    });

    it('says the dispute was reopened, and by whom', async () => {
      (prisma.booking.findUnique as jest.Mock).mockResolvedValue(redoBooking());
      (prisma.user.findMany as jest.Mock).mockResolvedValue([{ id: adminId }]);

      await createDispute(providerUserId, 'SERVICE_PROVIDER', reopenInput);

      expect(createBulkNotifications).toHaveBeenCalledWith(
        [adminId],
        'DISPUTE_OPENED',
        'Dispute reopened',
        'The provider reopened the dispute about the booking of Deep Cleaning.',
        'dispute',
        'dispute-1',
        { disputeId: 'dispute-1', bookingId: booking.id }
      );
    });

    it('sends nothing when there are no active admins', async () => {
      await createDispute(customerId, 'SERVICE_USER', input(DESCRIPTION));

      expect(createBulkNotifications).not.toHaveBeenCalled();
    });

    it('still returns the dispute when the admins cannot be alerted', async () => {
      const errorLog = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      (prisma.user.findMany as jest.Mock).mockRejectedValue(new Error('database unavailable'));

      await expect(createDispute(customerId, 'SERVICE_USER', input(DESCRIPTION))).resolves.toMatchObject({
        id: 'dispute-1',
      });
      expect(createNotification).toHaveBeenCalledWith(expect.objectContaining({ userId: providerUserId }));
      errorLog.mockRestore();
    });
  });
});

describe('getBookingDispute', () => {
  const notFound = { message: 'Booking not found', extensions: { code: 'NOT_FOUND' } };

  beforeEach(() => {
    (prisma.booking.findUnique as jest.Mock).mockResolvedValue({ userId: customerId, provider: { userId: providerUserId } });
    (prisma.dispute.findUnique as jest.Mock).mockResolvedValue(disputeRow());
  });

  it('checks the caller is on the booking before looking for a dispute', async () => {
    await expect(getBookingDispute(booking.id, outsiderId, false)).rejects.toMatchObject(notFound);

    expect(prisma.booking.findUnique).toHaveBeenCalledWith({
      where: { id: booking.id },
      select: { userId: true, provider: { select: { userId: true } } },
    });
    expect(prisma.dispute.findUnique).not.toHaveBeenCalled();
  });

  it('gives the same NOT_FOUND for a booking that does not exist, to everyone', async () => {
    (prisma.booking.findUnique as jest.Mock).mockResolvedValue(null);

    await expect(getBookingDispute(booking.id, customerId, false)).rejects.toMatchObject(notFound);
    await expect(getBookingDispute(booking.id, adminId, true)).rejects.toMatchObject(notFound);
    expect(prisma.dispute.findUnique).not.toHaveBeenCalled();
  });

  it('refuses a caller without a user ID', async () => {
    await expect(getBookingDispute(booking.id, undefined, false)).rejects.toMatchObject(notFound);
  });

  it.each([
    ['customer', customerId],
    ['provider', providerUserId],
  ])('returns the dispute to the %s', async (_party, userId) => {
    await expect(getBookingDispute(booking.id, userId, false)).resolves.toMatchObject({
      id: disputeId,
      status: 'OPEN',
      booking: { id: booking.id },
    });
    expect(prisma.dispute.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { bookingId: booking.id } }));
  });

  it('returns the dispute to an admin who is not on the booking', async () => {
    await expect(getBookingDispute(booking.id, adminId, true)).resolves.toMatchObject({ id: disputeId });
  });

  it('returns null to a party when the booking has no dispute', async () => {
    (prisma.dispute.findUnique as jest.Mock).mockResolvedValue(null);

    await expect(getBookingDispute(booking.id, customerId, false)).resolves.toBeNull();
  });
});

describe('getMyDisputes', () => {
  const mine = { OR: [{ booking: { userId: providerUserId } }, { booking: { providerId } }] };

  beforeEach(() => {
    (prisma.serviceProvider.findUnique as jest.Mock).mockResolvedValue({ id: providerId });
    (prisma.dispute.findMany as jest.Mock).mockResolvedValue([disputeRow()]);
    (prisma.dispute.count as jest.Mock).mockResolvedValue(1);
  });

  it('filters by who raised the dispute, in the list and the total', async () => {
    const result = await getMyDisputes(providerUserId, { raisedByRole: 'SERVICE_USER' }, { page: 1, limit: 10 });

    const where = { ...mine, raisedByRole: 'SERVICE_USER' };
    expect(prisma.dispute.findMany).toHaveBeenCalledWith(expect.objectContaining({ where, skip: 0, take: 10 }));
    expect(prisma.dispute.count).toHaveBeenCalledWith({ where });
    expect(result).toMatchObject({ total: 1, page: 1, limit: 10, totalPages: 1 });
  });

  it('combines the status and raisedByRole filters', async () => {
    await getMyDisputes(providerUserId, { status: 'OPEN', raisedByRole: 'SERVICE_PROVIDER' }, { page: 1, limit: 10 });

    expect(prisma.dispute.count).toHaveBeenCalledWith({
      where: { ...mine, status: 'OPEN', raisedByRole: 'SERVICE_PROVIDER' },
    });
  });

  it('lists disputes raised by either party without a raisedByRole filter', async () => {
    await getMyDisputes(providerUserId, {}, { page: 1, limit: 10 });

    expect(prisma.dispute.count).toHaveBeenCalledWith({ where: mine });
  });
});

describe('takeDisputeUnderReview', () => {
  const startedAt = new Date('2026-09-12T09:00:00.000Z');

  beforeEach(() => {
    (prisma.dispute.findUnique as jest.Mock).mockResolvedValue(disputeRow({ booking: undefined }));
    (prisma.dispute.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
    (prisma.dispute.findUniqueOrThrow as jest.Mock).mockResolvedValue(
      disputeRow({ status: 'UNDER_REVIEW', reviewedById: adminId, reviewStartedAt: startedAt })
    );
  });

  it('records which admin took it and when, with a conditional update', async () => {
    const before = Date.now();
    const result = await takeDisputeUnderReview(disputeId, adminId);

    expect(prisma.dispute.updateMany).toHaveBeenCalledWith({
      where: { id: disputeId, status: 'OPEN' },
      data: { status: 'UNDER_REVIEW', reviewedById: adminId, reviewStartedAt: expect.any(Date) },
    });
    const [{ data }] = (prisma.dispute.updateMany as jest.Mock).mock.calls[0] as [{ data: { reviewStartedAt: Date } }];
    expect(data.reviewStartedAt.getTime()).toBeGreaterThanOrEqual(before);

    expect(result).toMatchObject({
      status: 'UNDER_REVIEW',
      reviewedBy: adminId,
      reviewStartedAt: '2026-09-12T09:00:00.000Z',
    });
  });

  it('tells the customer and the provider, in-app and by push', async () => {
    await takeDisputeUnderReview(disputeId, adminId);

    const message = "Easykonnet is now reviewing the dispute for Deep Cleaning. We'll let you know when it's settled.";
    for (const userId of [customerId, providerUserId]) {
      expect(createNotification).toHaveBeenCalledWith({
        userId,
        type: 'DISPUTE_UPDATED',
        title: 'Dispute under review',
        message,
        entityType: 'dispute',
        entityId: disputeId,
        metadata: { bookingId: booking.id },
      });
      expect(sendPushToUser).toHaveBeenCalledWith(userId, {
        title: 'Dispute under review',
        message,
        data: { type: 'DISPUTE_UPDATED', disputeId, bookingId: booking.id },
      });
    }
    expect(createNotification).toHaveBeenCalledTimes(2);
  });

  it('still returns the dispute when the notifications fail', async () => {
    const errorLog = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    (createNotification as jest.Mock).mockRejectedValue(new Error('database unavailable'));
    (sendPushToUser as jest.Mock).mockRejectedValue(new Error('OneSignal unavailable'));

    await expect(takeDisputeUnderReview(disputeId, adminId)).resolves.toMatchObject({ status: 'UNDER_REVIEW' });
    errorLog.mockRestore();
  });

  it('does not change or announce a dispute that was taken or settled meanwhile', async () => {
    // Read as OPEN, but changed before the update ran
    (prisma.dispute.updateMany as jest.Mock).mockResolvedValue({ count: 0 });

    await expect(takeDisputeUnderReview(disputeId, adminId)).rejects.toMatchObject({
      extensions: { code: 'INVALID_STATUS' },
    });
    expect(prisma.dispute.findUniqueOrThrow).not.toHaveBeenCalled();
    expect(createNotification).not.toHaveBeenCalled();
    expect(sendPushToUser).not.toHaveBeenCalled();
  });

  it('throws NOT_FOUND for a dispute that does not exist', async () => {
    (prisma.dispute.findUnique as jest.Mock).mockResolvedValue(null);

    await expect(takeDisputeUnderReview(disputeId, adminId)).rejects.toMatchObject({
      extensions: { code: 'NOT_FOUND' },
    });
    expect(prisma.dispute.updateMany).not.toHaveBeenCalled();
  });
});

describe('addDisputeEvidence', () => {
  const raised = (evidence: string[]) => ({
    id: disputeId,
    status: 'OPEN',
    raisedByRole: 'SERVICE_USER',
    evidence,
    booking: { userId: customerId, provider: { userId: providerUserId } },
  });

  beforeEach(() => {
    (prisma.dispute.findUnique as jest.Mock).mockResolvedValue(raised([evidenceUrl('first')]));
    (prisma.dispute.update as jest.Mock).mockImplementation(
      async ({ data }: { data: { evidence: { push: string[] } } }) =>
        disputeRow({ evidence: [evidenceUrl('first'), ...data.evidence.push] })
    );
  });

  it('adds evidence files the raiser uploaded', async () => {
    const result = await addDisputeEvidence(disputeId, customerId, [evidenceUrl('bathroom')]);

    expect(prisma.dispute.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: disputeId }, data: { evidence: { push: [evidenceUrl('bathroom')] } } })
    );
    expect(result.evidence).toEqual([evidenceUrl('first'), evidenceUrl('bathroom')]);
  });

  it.each([
    ['a URL from anywhere else', 'https://example.com/photo.jpg'],
    ['a file someone else uploaded', evidenceUrl('bathroom', providerUserId)],
  ])('rejects %s with INVALID_EVIDENCE_URL, before looking anything up', async (_label, url) => {
    await expect(addDisputeEvidence(disputeId, customerId, [evidenceUrl('ok'), url])).rejects.toMatchObject({
      message: EVIDENCE_MESSAGE,
      extensions: { code: 'INVALID_EVIDENCE_URL' },
    });
    expect(prisma.dispute.findUnique).not.toHaveBeenCalled();
    expect(prisma.dispute.update).not.toHaveBeenCalled();
  });

  it('refuses more than 10 files in total', async () => {
    (prisma.dispute.findUnique as jest.Mock).mockResolvedValue(
      raised(Array.from({ length: 9 }, (_, i) => evidenceUrl(`old-${i}`)))
    );

    await expect(
      addDisputeEvidence(disputeId, customerId, [evidenceUrl('a'), evidenceUrl('b')])
    ).rejects.toMatchObject({ message: 'Maximum 10 evidence files allowed', extensions: { code: 'MAX_EVIDENCE_EXCEEDED' } });
    expect(prisma.dispute.update).not.toHaveBeenCalled();
  });

  it("answers someone not on the booking as if the dispute didn't exist", async () => {
    const outsiderId = '66e2a0c0f0a9d83b5c7e0099';

    await expect(addDisputeEvidence(disputeId, outsiderId, [evidenceUrl('photo', outsiderId)])).rejects.toMatchObject({
      message: 'Dispute not found',
      extensions: { code: 'NOT_FOUND' },
    });
    expect(prisma.dispute.update).not.toHaveBeenCalled();
  });

  it('refuses the other party with FORBIDDEN', async () => {
    await expect(
      addDisputeEvidence(disputeId, providerUserId, [evidenceUrl('photo', providerUserId)])
    ).rejects.toMatchObject({ message: 'Only the dispute raiser can add evidence', extensions: { code: 'FORBIDDEN' } });
    expect(prisma.dispute.update).not.toHaveBeenCalled();
  });
});

describe('getDisputeById', () => {
  it("answers someone not on the booking as if the dispute didn't exist", async () => {
    (prisma.dispute.findUnique as jest.Mock).mockResolvedValue(
      disputeRow({ booking: { userId: customerId, provider: { userId: providerUserId } } })
    );

    await expect(getDisputeById(disputeId, '66e2a0c0f0a9d83b5c7e0099', false)).rejects.toMatchObject({
      message: 'Dispute not found',
      extensions: { code: 'NOT_FOUND' },
    });
  });
});

describe('isEvidenceUrl', () => {
  const cloudinary = config.cloudinary as { cloudName: string };

  it("accepts https evidence files the user uploaded to the configured account", () => {
    expect(isEvidenceUrl(evidenceUrl('kitchen'), customerId)).toBe(true);
    expect(
      isEvidenceUrl(`${CLOUD}/raw/upload/v1789218000/easykonect/evidence/${customerId}_1789218000_invoice.pdf`, customerId)
    ).toBe(true);
  });

  it("refuses another user's file", () => {
    expect(isEvidenceUrl(evidenceUrl('kitchen'), providerUserId)).toBe(false);
  });

  it('accepts nothing when no Cloudinary account is configured', () => {
    const configured = cloudinary.cloudName;
    cloudinary.cloudName = '';
    try {
      expect(isEvidenceUrl(evidenceUrl('kitchen'), customerId)).toBe(false);
    } finally {
      cloudinary.cloudName = configured;
    }
  });
});

describe('refundForResolution', () => {
  const paid = 500_000; // ₦5,000 in kobo

  it('REFUND_FULL refunds the whole amount paid and rejects a different amount', () => {
    expect(refundForResolution('REFUND_FULL', null, paid)).toBe(paid);
    expect(refundForResolution('REFUND_FULL', paid, paid)).toBe(paid);
    expect(errorOf(() => refundForResolution('REFUND_FULL', 200_000, paid))).toEqual({
      code: 'INVALID_REFUND_AMOUNT',
      message: 'A full refund is the whole ₦5,000 paid. Leave the amount empty, or choose a partial refund.',
    });
  });

  it('REFUND_PARTIAL needs an amount above zero and below the amount paid', () => {
    expect(refundForResolution('REFUND_PARTIAL', 200_000, paid)).toBe(200_000);
    expect(errorCode(() => refundForResolution('REFUND_PARTIAL', null, paid))).toBe('REFUND_AMOUNT_REQUIRED');
    expect(errorCode(() => refundForResolution('REFUND_PARTIAL', 0, paid))).toBe('INVALID_REFUND_AMOUNT');
    expect(errorCode(() => refundForResolution('REFUND_PARTIAL', -100, paid))).toBe('INVALID_REFUND_AMOUNT');
    expect(errorCode(() => refundForResolution('REFUND_PARTIAL', paid, paid))).toBe('INVALID_REFUND_AMOUNT');
    expect(errorOf(() => refundForResolution('REFUND_PARTIAL', paid + 1, paid))).toEqual({
      code: 'INVALID_REFUND_AMOUNT',
      message: 'A partial refund must be more than ₦0 and less than the ₦5,000 paid',
    });
  });

  it('MUTUAL_AGREEMENT allows no refund, or a refund up to the amount paid', () => {
    expect(refundForResolution('MUTUAL_AGREEMENT', null, paid)).toBe(0);
    expect(refundForResolution('MUTUAL_AGREEMENT', 150_000, paid)).toBe(150_000);
    expect(refundForResolution('MUTUAL_AGREEMENT', paid, paid)).toBe(paid);
    expect(errorOf(() => refundForResolution('MUTUAL_AGREEMENT', paid + 1, paid))).toEqual({
      code: 'INVALID_REFUND_AMOUNT',
      message: 'The agreed refund must be between ₦0 and the ₦5,000 paid',
    });
  });

  it.each(['NO_REFUND', 'REDO_SERVICE', 'DISMISSED'])('%s refunds nothing and rejects an amount', (resolution) => {
    expect(refundForResolution(resolution, null, paid)).toBe(0);
    expect(errorCode(() => refundForResolution(resolution, 100_000, paid))).toBe('INVALID_REFUND_AMOUNT');
  });

  const unpaidRefunds: Array<[string, number | null]> = [
    ['REFUND_FULL', null],
    ['REFUND_PARTIAL', 100_000],
    ['MUTUAL_AGREEMENT', 100_000],
  ];

  it.each(unpaidRefunds)('%s on an unpaid booking throws NO_PAYMENT_TO_REFUND', (resolution, requested) => {
    expect(errorCode(() => refundForResolution(resolution, requested, 0))).toBe('NO_PAYMENT_TO_REFUND');
  });

  describe('after an earlier partial refund', () => {
    // ₦5,000 paid and ₦2,000 of it refunded earlier: ₦3,000 left
    const refunded = 200_000;
    const left = 300_000;
    const limit = '₦3,000 not yet refunded (₦2,000 of the ₦5,000 paid was refunded earlier)';

    it('REFUND_FULL refunds what is left', () => {
      expect(refundForResolution('REFUND_FULL', null, paid, refunded)).toBe(left);
      expect(refundForResolution('REFUND_FULL', left, paid, refunded)).toBe(left);
      expect(errorOf(() => refundForResolution('REFUND_FULL', paid, paid, refunded))).toEqual({
        code: 'INVALID_REFUND_AMOUNT',
        message: `A full refund is the ${limit}. Leave the amount empty, or choose a partial refund.`,
      });
    });

    it('REFUND_PARTIAL must be less than what is left', () => {
      expect(refundForResolution('REFUND_PARTIAL', 100_000, paid, refunded)).toBe(100_000);
      expect(errorOf(() => refundForResolution('REFUND_PARTIAL', 400_000, paid, refunded))).toEqual({
        code: 'INVALID_REFUND_AMOUNT',
        message: `A partial refund must be more than ₦0 and less than the ${limit}`,
      });
      expect(errorCode(() => refundForResolution('REFUND_PARTIAL', left, paid, refunded))).toBe('INVALID_REFUND_AMOUNT');
    });

    it('MUTUAL_AGREEMENT allows up to what is left', () => {
      expect(refundForResolution('MUTUAL_AGREEMENT', left, paid, refunded)).toBe(left);
      expect(errorOf(() => refundForResolution('MUTUAL_AGREEMENT', left + 1, paid, refunded))).toEqual({
        code: 'INVALID_REFUND_AMOUNT',
        message: `The agreed refund must be between ₦0 and the ${limit}`,
      });
    });

    it('is ALREADY_REFUNDED when nothing is left to refund', () => {
      expect(errorOf(() => refundForResolution('REFUND_FULL', null, paid, paid))).toEqual({
        code: 'ALREADY_REFUNDED',
        message: 'This payment has already been refunded',
      });
      // Resolutions without a refund are unaffected
      expect(refundForResolution('NO_REFUND', null, paid, paid)).toBe(0);
    });
  });
});

describe('bookingAfterResolution', () => {
  const now = new Date('2026-09-12T10:00:00.000Z');
  const completedAt = new Date('2026-09-10T10:00:00.000Z');
  const paid = 500_000;

  const after = (params: Partial<Parameters<typeof bookingAfterResolution>[0]>) =>
    bookingAfterResolution({
      resolution: 'NO_REFUND',
      refundKobo: 0,
      paidKobo: paid,
      previousStatus: 'COMPLETED',
      completedAt,
      now,
      ...params,
    });

  it('cancels the booking on a full refund', () => {
    expect(after({ resolution: 'REFUND_FULL', refundKobo: paid })).toMatchObject({
      status: 'CANCELLED',
      cancelledAt: now,
    });
    // An agreed refund of everything paid is a full refund too
    expect(after({ resolution: 'MUTUAL_AGREEMENT', refundKobo: paid }).status).toBe('CANCELLED');
  });

  it('REDO_SERVICE returns the booking to ACCEPTED and clears completion, confirmation and release', () => {
    expect(after({ resolution: 'REDO_SERVICE' })).toEqual({
      status: 'ACCEPTED',
      completedAt: null,
      customerConfirmedAt: null,
      paymentReleaseAt: null,
    });
  });

  it('a partial refund completes the booking and releases the rest now', () => {
    expect(after({ resolution: 'REFUND_PARTIAL', refundKobo: 200_000 })).toEqual({
      status: 'COMPLETED',
      completedAt,
      paymentReleaseAt: now,
    });
    // A job that was never marked complete is completed now
    expect(
      after({ resolution: 'REFUND_PARTIAL', refundKobo: 200_000, previousStatus: 'IN_PROGRESS', completedAt: null })
    ).toEqual({ status: 'COMPLETED', completedAt: now, paymentReleaseAt: now });
  });

  it('with no refund, the booking returns to the status it had', () => {
    expect(after({ previousStatus: 'IN_PROGRESS', completedAt: null })).toEqual({ status: 'IN_PROGRESS' });
    expect(after({ previousStatus: 'COMPLETED' })).toEqual({ status: 'COMPLETED', paymentReleaseAt: now });
    expect(after({ previousStatus: 'ACCEPTED', paidKobo: 0, completedAt: null })).toEqual({ status: 'ACCEPTED' });
  });
});

describe('settling a dispute', () => {
  const bookingId = booking.id;
  const completedAt = new Date('2026-09-10T10:00:00.000Z');

  // ₦5,000 paid, ₦4,650 of it the provider's share
  const payment = {
    id: paymentId,
    bookingId,
    amount: 5000,
    commission: 350,
    providerPayout: 4650,
    status: 'COMPLETED',
    refundAmount: null as number | null,
    refundedAt: null as Date | null,
  };

  const openDispute = {
    id: disputeId,
    bookingId,
    status: 'UNDER_REVIEW',
    previousBookingStatus: 'COMPLETED',
    booking: {
      id: bookingId,
      userId: customerId,
      status: 'DISPUTED',
      completedAt,
      paymentReleasedAt: null,
      payment,
      service: { name: 'Deep Cleaning' },
      provider: { userId: providerUserId },
    },
  };

  const settledDispute = (fields: Record<string, unknown>) =>
    disputeRow({ booking: null, resolvedAt: new Date(), ...fields });

  const partialRefund = {
    resolution: 'REFUND_PARTIAL',
    resolutionNotes: 'Only half of the rooms were cleaned',
    refundAmount: 2000,
  };

  const makeTx = () => ({
    dispute: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    payment: {
      findUnique: jest.fn().mockResolvedValue({
        ...payment,
        booking: { id: bookingId, userId: customerId, paymentReleasedAt: null },
      }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    wallet: {
      // Returns the (empty) wallet after the increment
      update: jest.fn().mockImplementation(async ({ data }: { data: { balance: { increment: number } } }) => ({
        id: walletId,
        userId: customerId,
        balance: data.balance.increment,
      })),
    },
    walletTransaction: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'wtx-1',
        ...data,
      })),
    },
    booking: { update: jest.fn().mockResolvedValue({}) },
  });

  let tx: ReturnType<typeof makeTx>;

  beforeEach(() => {
    tx = makeTx();
    runTransactionWith(tx);
    (prisma.wallet.findUnique as jest.Mock).mockResolvedValue({ id: walletId, userId: customerId, balance: 0 });
  });

  it('resolveDispute REFUND_PARTIAL claims the dispute, credits the refund to the wallet and completes the booking', async () => {
    (prisma.dispute.findUnique as jest.Mock).mockResolvedValueOnce(openDispute);
    (prisma.dispute.findUniqueOrThrow as jest.Mock).mockResolvedValueOnce(
      settledDispute({ status: 'RESOLVED', resolution: 'REFUND_PARTIAL', refundAmount: 2000 })
    );

    const before = Date.now();
    const result = await resolveDispute(disputeId, adminId, partialRefund);
    const finished = Date.now();

    // The customer's wallet exists before the transaction
    expect(prisma.wallet.findUnique).toHaveBeenCalledWith({ where: { userId: customerId } });

    // Claimed only while still open, so two admins can't both settle it
    expect(tx.dispute.updateMany).toHaveBeenCalledWith({
      where: { id: disputeId, status: { in: ['OPEN', 'UNDER_REVIEW'] } },
      data: expect.objectContaining({
        status: 'RESOLVED',
        resolution: 'REFUND_PARTIAL',
        refundAmount: 2000,
        resolvedById: adminId,
      }),
    });
    expect(tx.dispute.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
      tx.payment.updateMany.mock.invocationCallOrder[0]
    );

    // ₦2,000 of ₦5,000 refunded: the payment stays COMPLETED and the provider
    // keeps the same share of the remaining ₦3,000 (₦2,790)
    expect(tx.payment.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: paymentId, status: 'COMPLETED' }),
      data: expect.objectContaining({
        status: 'COMPLETED',
        refundAmount: 2000,
        refundedVia: 'DISPUTE',
        refundedBy: adminId,
        providerPayout: 2790,
        commission: 210,
      }),
    });
    expect(tx.walletTransaction.findUnique).toHaveBeenCalledWith({ where: { reference: `RFD_${paymentId}` } });
    expect(tx.wallet.update).toHaveBeenCalledWith({
      where: { id: walletId },
      data: { balance: { increment: 200_000 } },
    });
    expect(tx.walletTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        walletId,
        type: 'CREDIT',
        source: 'REFUND',
        amount: 200_000,
        balanceAfter: 200_000,
        reference: `RFD_${paymentId}`,
        bookingId,
        paymentId,
      }),
    });

    // The booking is completed and the rest released now
    expect(tx.booking.update).toHaveBeenCalledWith({
      where: { id: bookingId },
      data: { status: 'COMPLETED', completedAt, paymentReleaseAt: expect.any(Date) },
    });
    const [{ data }] = tx.booking.update.mock.calls[0] as [{ data: { paymentReleaseAt: Date } }];
    expect(data.paymentReleaseAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(data.paymentReleaseAt.getTime()).toBeLessThanOrEqual(finished);

    expect(createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'RESOLVE_DISPUTE', targetId: disputeId, performedBy: adminId })
    );
    expect(createNotification).toHaveBeenCalledWith(
      expect.objectContaining({ userId: customerId, type: 'DISPUTE_RESOLVED', entityId: disputeId })
    );
    expect(createNotification).toHaveBeenCalledWith(
      expect.objectContaining({ userId: providerUserId, type: 'DISPUTE_RESOLVED', entityId: disputeId })
    );
    expect(result).toMatchObject({ status: 'RESOLVED', resolution: 'REFUND_PARTIAL', refundAmount: 2000 });
  });

  it('after a partial admin refund, REFUND_FULL refunds the rest through escrow and cancels the booking', async () => {
    // A Super Admin already refunded ₦2,000, which cut the provider's share to ₦2,790
    const partlyRefunded = {
      ...payment,
      providerPayout: 2790,
      commission: 210,
      refundAmount: 2000,
      refundedAt: new Date('2026-09-11T09:00:00.000Z'),
    };
    (prisma.dispute.findUnique as jest.Mock).mockResolvedValueOnce({
      ...openDispute,
      booking: { ...openDispute.booking, payment: partlyRefunded },
    });
    tx.payment.findUnique.mockResolvedValue({
      ...partlyRefunded,
      booking: { id: bookingId, userId: customerId, paymentReleasedAt: null },
    });
    (prisma.dispute.findUniqueOrThrow as jest.Mock).mockResolvedValueOnce(
      settledDispute({ status: 'RESOLVED', resolution: 'REFUND_FULL', refundAmount: 3000 })
    );

    await resolveDispute(disputeId, adminId, {
      resolution: 'REFUND_FULL',
      resolutionNotes: 'The rest of the job was never done',
    });

    expect(tx.dispute.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ resolution: 'REFUND_FULL', refundAmount: 3000 }) })
    );
    // Escrow refunds the ₦3,000 left and marks the payment refunded in full
    expect(tx.payment.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: paymentId, status: 'COMPLETED', refundAmount: 2000 }),
      data: expect.objectContaining({ status: 'REFUNDED', refundAmount: 5000, refundedVia: 'DISPUTE' }),
    });
    expect(tx.wallet.update).toHaveBeenCalledWith({
      where: { id: walletId },
      data: { balance: { increment: 300_000 } },
    });
    // Nothing is left for the provider: the booking is cancelled
    expect(tx.booking.update).toHaveBeenCalledWith({
      where: { id: bookingId },
      data: expect.objectContaining({ status: 'CANCELLED', cancellationReason: 'Dispute resolved with a full refund' }),
    });
    expect(createNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: customerId,
        message: 'The dispute for Deep Cleaning was settled with a full refund. ₦3,000 has been added to your Easykonnet wallet.',
      })
    );
    expect(createNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: providerUserId,
        message: 'The dispute for Deep Cleaning was settled with a full refund. The booking was cancelled.',
      })
    );
  });

  it('refuses a refund larger than what an earlier refund left, before claiming anything', async () => {
    (prisma.dispute.findUnique as jest.Mock).mockResolvedValueOnce({
      ...openDispute,
      booking: { ...openDispute.booking, payment: { ...payment, refundAmount: 2000, refundedAt: new Date() } },
    });

    await expect(resolveDispute(disputeId, adminId, { ...partialRefund, refundAmount: 3500 })).rejects.toMatchObject({
      message: 'A partial refund must be more than ₦0 and less than the ₦3,000 not yet refunded (₦2,000 of the ₦5,000 paid was refunded earlier)',
      extensions: { code: 'INVALID_REFUND_AMOUNT' },
    });
    expect(prisma.wallet.findUnique).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(createNotification).not.toHaveBeenCalled();
  });

  it('throws ALREADY_RESOLVED and credits nothing when another admin resolved it first', async () => {
    // Read before the other admin's resolution was saved
    (prisma.dispute.findUnique as jest.Mock).mockResolvedValueOnce(openDispute);
    tx.dispute.updateMany.mockResolvedValue({ count: 0 });

    await expect(resolveDispute(disputeId, adminId, partialRefund)).rejects.toMatchObject({
      extensions: { code: 'ALREADY_RESOLVED' },
    });

    expect(tx.payment.findUnique).not.toHaveBeenCalled();
    expect(tx.payment.updateMany).not.toHaveBeenCalled();
    expect(tx.wallet.update).not.toHaveBeenCalled();
    expect(tx.walletTransaction.create).not.toHaveBeenCalled();
    expect(tx.booking.update).not.toHaveBeenCalled();
    expect(createAuditLog).not.toHaveBeenCalled();
    expect(createNotification).not.toHaveBeenCalled();
    expect(prisma.dispute.findUniqueOrThrow).not.toHaveBeenCalled();
  });

  it('closeDispute on a paid COMPLETED booking returns it to COMPLETED with the release due now and refunds nothing', async () => {
    (prisma.dispute.findUnique as jest.Mock).mockResolvedValueOnce({ ...openDispute, status: 'OPEN' });
    (prisma.dispute.findUniqueOrThrow as jest.Mock).mockResolvedValueOnce(
      settledDispute({ status: 'CLOSED', resolution: 'DISMISSED', refundAmount: null })
    );

    const before = Date.now();
    const result = await closeDispute(disputeId, adminId, 'Raised against the wrong booking');
    const finished = Date.now();

    expect(tx.dispute.updateMany).toHaveBeenCalledWith({
      where: { id: disputeId, status: { in: ['OPEN', 'UNDER_REVIEW'] } },
      data: expect.objectContaining({ status: 'CLOSED', resolution: 'DISMISSED', refundAmount: null }),
    });
    expect(tx.booking.update).toHaveBeenCalledWith({
      where: { id: bookingId },
      data: { status: 'COMPLETED', paymentReleaseAt: expect.any(Date) },
    });
    const [{ data }] = tx.booking.update.mock.calls[0] as [{ data: { paymentReleaseAt: Date } }];
    expect(data.paymentReleaseAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(data.paymentReleaseAt.getTime()).toBeLessThanOrEqual(finished);

    // Nothing refunded
    expect(prisma.wallet.findUnique).not.toHaveBeenCalled();
    expect(tx.payment.findUnique).not.toHaveBeenCalled();
    expect(tx.payment.updateMany).not.toHaveBeenCalled();
    expect(tx.wallet.update).not.toHaveBeenCalled();
    expect(tx.walletTransaction.create).not.toHaveBeenCalled();
    expect(result.status).toBe('CLOSED');
  });
});
