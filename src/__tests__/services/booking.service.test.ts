/**
 * Booking Service Tests
 *
 * Covers:
 *   - startService payment guard (cannot start until ACCEPTED + payment COMPLETED)
 *   - dispatchBookingEvent fan-out (socket + notification + push) on
 *     createBooking, acceptBooking, rejectBooking, startService,
 *     completeService, cancelBooking and confirmServiceDelivery
 *   - cancelBooking notifies the *provider* (not the customer)
 *   - conditional status updates: a booking that changed meanwhile isn't
 *     accepted, rejected, updated, started, completed, cancelled or confirmed twice
 *   - cancelling a paid booking (customer or admin) refunds the customer's
 *     wallet, through the real escrow and wallet services
 *   - createBooking stores the commission in whole kobo
 *   - booking dates and times: formats, and Lagos time for the checks
 *   - free text (address, notes, reasons) is cleaned, screened and limited
 *   - a block stops a pending request being accepted
 *   - booking responses carry the provider's images and leave out removed reviews
 *   - provider booking stats
 */

import { GraphQLError } from 'graphql';

// ==================
// Mocks
// ==================

jest.mock('@/lib/prisma', () => ({
  __esModule: true,
  default: {
    // Returns nothing unless a test sets a rate, so bookings use the config rate
    platformSettings: {
      findUnique: jest.fn(),
    },
    userBlock: {
      findFirst: jest.fn(),
    },
    serviceProvider: {
      findUnique: jest.fn(),
    },
    service: {
      findUnique: jest.fn(),
    },
    booking: {
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      create: jest.fn(),
      count: jest.fn(),
    },
    payment: {
      update: jest.fn(),
      aggregate: jest.fn(),
    },
    wallet: {
      findUnique: jest.fn(),
      create: jest.fn(),
    },
    $transaction: jest.fn(),
  },
}));

// Loaded through the security utilities; never used by bookings
jest.mock('@/lib/redis', () => ({
  __esModule: true,
  default: { getInstance: jest.fn() },
}));

jest.mock('@/lib/socket', () => ({
  emitToUser: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/services/notification.service', () => ({
  createNotification: jest.fn().mockResolvedValue(undefined),
  notifyBookingCreated: jest.fn().mockResolvedValue(undefined),
  notifyBookingAccepted: jest.fn().mockResolvedValue(undefined),
  notifyBookingRejected: jest.fn().mockResolvedValue(undefined),
  notifyBookingStarted: jest.fn().mockResolvedValue(undefined),
  notifyBookingCompleted: jest.fn().mockResolvedValue(undefined),
  notifyBookingCancelled: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/services/push.service', () => ({
  sendBookingPush: jest.fn().mockResolvedValue(undefined),
  sendPushToUser: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/services/audit.service', () => ({
  createAuditLog: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/lib/logger', () => ({
  logger: {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

jest.mock('@/config', () => ({
  config: {
    booking: { autoReleaseHours: 24 },
    platform: { commissionRate: 0.07 },
  },
}));

import prisma from '@/lib/prisma';
import { emitToUser } from '@/lib/socket';
import {
  createNotification,
  notifyBookingCreated,
  notifyBookingAccepted,
  notifyBookingRejected,
  notifyBookingStarted,
  notifyBookingCompleted,
  notifyBookingCancelled,
} from '@/services/notification.service';
import { sendBookingPush, sendPushToUser } from '@/services/push.service';
import { createAuditLog } from '@/services/audit.service';
import {
  acceptBooking,
  adminCancelBooking,
  rejectBooking,
  startService,
  completeService,
  cancelBooking,
  confirmServiceDelivery,
  createBooking,
  getBookingById,
  getProviderBookingStats,
  updateBooking,
} from '@/services/booking.service';

// ==================
// Fixtures
// ==================

const customerUserId = '507f1f77bcf86cd700000001';
const providerUserId = '507f1f77bcf86cd700000002';
const providerId = '507f1f77bcf86cd700000010';
const bookingId = '507f1f77bcf86cd700000020';
const walletId = '507f1f77bcf86cd700000030';
const paymentId = '507f1f77bcf86cd700000040';
const adminId = '507f1f77bcf86cd700000050';

const baseBooking = {
  id: bookingId,
  userId: customerUserId,
  providerId,
  serviceId: 'svc1',
  status: 'ACCEPTED',
  scheduledDate: new Date('2030-01-15T00:00:00.000Z'),
  scheduledTime: '14:00',
  address: '1 Main St',
  city: 'Lagos',
  state: 'Lagos',
  notes: null,
  servicePrice: 5000,
  commission: 350,
  totalAmount: 5350,
  cancelledAt: null,
  completedAt: null,
  cancellationReason: null,
  createdAt: new Date('2025-01-01T00:00:00.000Z'),
  updatedAt: new Date('2025-01-01T00:00:00.000Z'),
  payment: null as any,
  user: {
    id: customerUserId,
    firstName: 'Ada',
    lastName: 'Lovelace',
    email: 'ada@example.com',
  },
  provider: {
    id: providerId,
    businessName: 'Top Cleaners',
    user: { id: providerUserId, firstName: 'Bob', lastName: 'Builder' },
  },
  service: {
    id: 'svc1',
    name: 'Deep Cleaning',
    category: { id: 'cat1', name: 'Cleaning' },
    provider: { id: providerId },
  },
};

const fullProvider = { id: providerId, userId: providerUserId };

const customerWallet = {
  id: walletId,
  userId: customerUserId,
  balance: 0,
  pendingBalance: 0,
  currency: 'NGN',
  isLocked: false,
};

// ₦5,000 paid and still held for the booking
const paidPayment = {
  id: paymentId,
  bookingId,
  amount: 5000,
  commission: 350,
  providerPayout: 4650,
  status: 'COMPLETED',
  refundedAt: null,
  booking: { id: bookingId, userId: customerUserId, paymentReleasedAt: null },
};

/**
 * Transaction client handed to withTransaction's callback. By default the
 * booking claim matches, the booking is paid, and its refund hasn't been
 * credited before.
 */
const makeTx = () => ({
  booking: {
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
  },
  payment: {
    findUnique: jest.fn().mockResolvedValue(paidPayment),
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
  },
  wallet: {
    // Returns the wallet after the increment
    update: jest.fn().mockImplementation(async ({ data }: { data: { balance: { increment: number } } }) => ({
      ...customerWallet,
      balance: customerWallet.balance + data.balance.increment,
    })),
  },
  walletTransaction: {
    findUnique: jest.fn().mockResolvedValue(null),
    create: jest.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: 'wtx1',
      ...data,
    })),
  },
});

type TxMock = ReturnType<typeof makeTx>;

const runTransactionWith = (tx: TxMock) => {
  (prisma.$transaction as jest.Mock).mockImplementation(async (fn: (client: TxMock) => Promise<unknown>) => fn(tx));
};

/**
 * Fix the clock for Date and Date.now only; promises and timers run as usual
 */
const freezeTime = (iso: string) =>
  jest.useFakeTimers({
    now: new Date(iso),
    doNotFake: [
      'nextTick',
      'queueMicrotask',
      'setImmediate',
      'clearImmediate',
      'setTimeout',
      'clearTimeout',
      'setInterval',
      'clearInterval',
      'hrtime',
      'performance',
    ],
  });

beforeEach(() => {
  jest.clearAllMocks();
  // Nobody has blocked anybody unless a test says so
  (prisma.userBlock.findFirst as jest.Mock).mockResolvedValue(null);
});

afterEach(() => {
  jest.useRealTimers();
  // Drop return values a test queued but didn't use
  jest.resetAllMocks();
});

// ==================
// startService — payment guard
// ==================

describe('startService — payment guard', () => {
  it('rejects when booking is still PENDING (must be ACCEPTED first)', async () => {
    (prisma.serviceProvider.findUnique as jest.Mock).mockResolvedValueOnce(fullProvider);
    (prisma.booking.findUnique as jest.Mock).mockResolvedValueOnce({
      ...baseBooking,
      status: 'PENDING',
      payment: { status: 'COMPLETED' },
    });

    await expect(startService(bookingId, providerUserId)).rejects.toThrow(
      /Booking must be ACCEPTED before it can be started/
    );
    expect(prisma.booking.updateMany).not.toHaveBeenCalled();
  });

  it('rejects when booking is ACCEPTED but payment is missing', async () => {
    (prisma.serviceProvider.findUnique as jest.Mock).mockResolvedValueOnce(fullProvider);
    (prisma.booking.findUnique as jest.Mock).mockResolvedValueOnce({
      ...baseBooking,
      status: 'ACCEPTED',
      payment: null,
    });

    await expect(startService(bookingId, providerUserId)).rejects.toThrow(
      /Customer has not paid yet/
    );
    expect(prisma.booking.updateMany).not.toHaveBeenCalled();
  });

  it('rejects when payment exists but is not COMPLETED', async () => {
    (prisma.serviceProvider.findUnique as jest.Mock).mockResolvedValueOnce(fullProvider);
    (prisma.booking.findUnique as jest.Mock).mockResolvedValueOnce({
      ...baseBooking,
      status: 'ACCEPTED',
      payment: { status: 'PENDING' },
    });

    let caught: GraphQLError | undefined;
    await startService(bookingId, providerUserId).catch((e) => (caught = e));
    expect(caught).toBeInstanceOf(GraphQLError);
    expect((caught as GraphQLError).extensions.code).toBe('PAYMENT_REQUIRED');
    expect(prisma.booking.updateMany).not.toHaveBeenCalled();
  });

  it('rejects when caller is not the booking provider', async () => {
    (prisma.serviceProvider.findUnique as jest.Mock).mockResolvedValueOnce({
      id: 'someOtherProvider',
      userId: providerUserId,
    });
    (prisma.booking.findUnique as jest.Mock).mockResolvedValueOnce({
      ...baseBooking,
      status: 'ACCEPTED',
      payment: { status: 'COMPLETED' },
    });

    await expect(startService(bookingId, providerUserId)).rejects.toThrow(
      /can only start your own service bookings/
    );
  });

  it('transitions to IN_PROGRESS when ACCEPTED + payment COMPLETED', async () => {
    (prisma.serviceProvider.findUnique as jest.Mock).mockResolvedValueOnce(fullProvider);
    (prisma.booking.findUnique as jest.Mock).mockResolvedValueOnce({
      ...baseBooking,
      status: 'ACCEPTED',
      payment: { status: 'COMPLETED' },
    });
    (prisma.booking.updateMany as jest.Mock).mockResolvedValueOnce({ count: 1 });
    (prisma.booking.findUniqueOrThrow as jest.Mock).mockResolvedValueOnce({
      ...baseBooking,
      status: 'IN_PROGRESS',
      payment: { status: 'COMPLETED' },
    });

    const result = await startService(bookingId, providerUserId);

    // Conditional on the status it was checked in
    expect(prisma.booking.updateMany).toHaveBeenCalledWith({
      where: { id: bookingId, status: 'ACCEPTED' },
      data: { status: 'IN_PROGRESS' },
    });
    expect(result.status).toBe('IN_PROGRESS');
  });
});

// ==================
// Booking changed meanwhile
// ==================

describe('startService / completeService — booking changed meanwhile', () => {
  it('startService throws INVALID_BOOKING_STATUS and notifies nobody when the update matches nothing', async () => {
    (prisma.serviceProvider.findUnique as jest.Mock).mockResolvedValueOnce(fullProvider);
    (prisma.booking.findUnique as jest.Mock).mockResolvedValueOnce({
      ...baseBooking,
      status: 'ACCEPTED',
      payment: { status: 'COMPLETED' },
    });
    (prisma.booking.updateMany as jest.Mock).mockResolvedValueOnce({ count: 0 });

    let caught: GraphQLError | undefined;
    await startService(bookingId, providerUserId).catch((e) => (caught = e));

    expect(caught).toBeInstanceOf(GraphQLError);
    expect(caught!.extensions.code).toBe('INVALID_BOOKING_STATUS');
    expect(prisma.booking.updateMany).toHaveBeenCalledWith({
      where: { id: bookingId, status: 'ACCEPTED' },
      data: { status: 'IN_PROGRESS' },
    });
    expect(prisma.booking.findUniqueOrThrow).not.toHaveBeenCalled();
    expect(emitToUser).not.toHaveBeenCalled();
    expect(notifyBookingStarted).not.toHaveBeenCalled();
    expect(sendBookingPush).not.toHaveBeenCalled();
  });

  it('completeService throws INVALID_BOOKING_STATUS and notifies nobody when the update matches nothing', async () => {
    (prisma.serviceProvider.findUnique as jest.Mock).mockResolvedValueOnce(fullProvider);
    (prisma.booking.findUnique as jest.Mock).mockResolvedValueOnce({
      ...baseBooking,
      status: 'IN_PROGRESS',
    });
    (prisma.booking.updateMany as jest.Mock).mockResolvedValueOnce({ count: 0 });

    let caught: GraphQLError | undefined;
    await completeService(bookingId, providerUserId).catch((e) => (caught = e));

    expect(caught).toBeInstanceOf(GraphQLError);
    expect(caught!.extensions.code).toBe('INVALID_BOOKING_STATUS');
    expect(prisma.booking.updateMany).toHaveBeenCalledWith({
      where: { id: bookingId, status: 'IN_PROGRESS' },
      data: { status: 'COMPLETED', completedAt: expect.any(Date) },
    });
    expect(prisma.booking.findUniqueOrThrow).not.toHaveBeenCalled();
    expect(emitToUser).not.toHaveBeenCalled();
    expect(notifyBookingCompleted).not.toHaveBeenCalled();
    expect(sendBookingPush).not.toHaveBeenCalled();
  });
});

describe('acceptBooking / rejectBooking / updateBooking — booking changed meanwhile', () => {
  const changedError = {
    message: 'This booking has changed. Please refresh and try again.',
    extensions: { code: 'INVALID_BOOKING_STATUS' },
  };

  it.each<[string, () => Promise<unknown>]>([
    ['acceptBooking', () => acceptBooking(bookingId, providerUserId)],
    ['rejectBooking', () => rejectBooking(bookingId, providerUserId, 'Fully booked that day')],
  ])('%s saves only while the booking is PENDING, and tells nobody when it no longer is', async (_name, run) => {
    (prisma.serviceProvider.findUnique as jest.Mock).mockResolvedValueOnce(fullProvider);
    // Read as PENDING, cancelled by the customer before the write
    (prisma.booking.findUnique as jest.Mock).mockResolvedValueOnce({ ...baseBooking, status: 'PENDING' });
    (prisma.booking.updateMany as jest.Mock).mockResolvedValueOnce({ count: 0 });

    await expect(run()).rejects.toMatchObject(changedError);

    expect(prisma.booking.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: bookingId, status: 'PENDING' } })
    );
    expect(prisma.booking.update).not.toHaveBeenCalled();
    expect(prisma.booking.findUniqueOrThrow).not.toHaveBeenCalled();
    expect(emitToUser).not.toHaveBeenCalled();
    expect(notifyBookingAccepted).not.toHaveBeenCalled();
    expect(notifyBookingRejected).not.toHaveBeenCalled();
    expect(sendBookingPush).not.toHaveBeenCalled();
  });

  it('updateBooking saves only while the booking is PENDING', async () => {
    (prisma.booking.findUnique as jest.Mock).mockResolvedValueOnce({ ...baseBooking, status: 'PENDING' });
    (prisma.booking.updateMany as jest.Mock).mockResolvedValueOnce({ count: 0 });

    await expect(updateBooking(bookingId, customerUserId, { notes: 'Ring the bell twice' })).rejects.toMatchObject(
      changedError
    );

    expect(prisma.booking.updateMany).toHaveBeenCalledWith({
      where: { id: bookingId, status: 'PENDING' },
      data: { notes: 'Ring the bell twice' },
    });
    expect(prisma.booking.update).not.toHaveBeenCalled();
    expect(prisma.booking.findUniqueOrThrow).not.toHaveBeenCalled();
  });

  it('updateBooking returns the booking as saved', async () => {
    (prisma.booking.findUnique as jest.Mock).mockResolvedValueOnce({ ...baseBooking, status: 'PENDING' });
    (prisma.booking.updateMany as jest.Mock).mockResolvedValueOnce({ count: 1 });
    (prisma.booking.findUniqueOrThrow as jest.Mock).mockResolvedValueOnce({
      ...baseBooking,
      status: 'PENDING',
      address: '12 Admiralty Way',
    });

    const result = await updateBooking(bookingId, customerUserId, { address: '12 Admiralty Way', city: '' });

    // An empty city keeps the current one
    expect(prisma.booking.updateMany).toHaveBeenCalledWith({
      where: { id: bookingId, status: 'PENDING' },
      data: { address: '12 Admiralty Way' },
    });
    expect(result).toMatchObject({ id: bookingId, address: '12 Admiralty Way' });
  });
});

// ==================
// dispatchBookingEvent fan-out (via each mutation)
// ==================

describe('booking event dispatch — fan-out to socket + notification + push', () => {
  const acceptedFromPending = () => {
    (prisma.serviceProvider.findUnique as jest.Mock).mockResolvedValueOnce(fullProvider);
    (prisma.booking.findUnique as jest.Mock).mockResolvedValueOnce({
      ...baseBooking,
      status: 'PENDING',
    });
    (prisma.booking.updateMany as jest.Mock).mockResolvedValueOnce({ count: 1 });
  };

  it('acceptBooking notifies the customer with kind "accepted"', async () => {
    acceptedFromPending();
    (prisma.booking.findUniqueOrThrow as jest.Mock).mockResolvedValueOnce({
      ...baseBooking,
      status: 'ACCEPTED',
    });

    await acceptBooking(bookingId, providerUserId);

    expect(prisma.booking.updateMany).toHaveBeenCalledWith({
      where: { id: bookingId, status: 'PENDING' },
      data: { status: 'ACCEPTED' },
    });
    expect(emitToUser).toHaveBeenCalledWith(
      customerUserId,
      'booking:accepted',
      expect.objectContaining({ bookingId })
    );
    expect(notifyBookingAccepted).toHaveBeenCalledWith(
      customerUserId,
      bookingId,
      'Deep Cleaning',
      'Top Cleaners'
    );
    expect(sendBookingPush).toHaveBeenCalledWith(customerUserId, 'accepted', bookingId, 'Deep Cleaning');
  });

  it('sends only a booking summary over the socket, never account secrets or documents', async () => {
    acceptedFromPending();
    (prisma.booking.findUniqueOrThrow as jest.Mock).mockResolvedValueOnce({
      ...baseBooking,
      status: 'ACCEPTED',
      user: {
        ...baseBooking.user,
        phone: '+2348031234567',
        password: '$2b$12$hashed-password',
        passwordResetToken: 'reset-token-secret',
        emailVerifyToken: 'verify-token-secret',
        oneSignalPlayerId: 'player-id-secret',
      },
      provider: {
        ...baseBooking.provider,
        documents: ['https://res.cloudinary.com/demo/raw/upload/id-card.pdf'],
      },
    });

    await acceptBooking(bookingId, providerUserId);

    const call = (emitToUser as jest.Mock).mock.calls.find(([, event]) => event === 'booking:accepted');
    const payload = call?.[2];
    const serialized = JSON.stringify(payload);

    for (const secret of [
      'hashed-password',
      'reset-token-secret',
      'verify-token-secret',
      'player-id-secret',
      '+2348031234567',
      'ada@example.com',
      'id-card.pdf',
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(payload.booking).toMatchObject({
      id: bookingId,
      status: 'ACCEPTED',
      scheduledDate: '2030-01-15T00:00:00.000Z',
      scheduledTime: '14:00',
      totalAmount: 5350,
      user: { id: customerUserId, firstName: 'Ada', lastName: 'Lovelace', profilePhoto: null },
      provider: { id: providerId, businessName: 'Top Cleaners' },
    });
    expect(Object.keys(payload.booking.user).sort()).toEqual(['firstName', 'id', 'lastName', 'profilePhoto']);
  });

  it('rejectBooking notifies the customer with reason', async () => {
    acceptedFromPending();
    (prisma.booking.findUniqueOrThrow as jest.Mock).mockResolvedValueOnce({
      ...baseBooking,
      status: 'REJECTED',
    });

    await rejectBooking(bookingId, providerUserId, 'fully booked');

    expect(prisma.booking.updateMany).toHaveBeenCalledWith({
      where: { id: bookingId, status: 'PENDING' },
      data: { status: 'REJECTED', cancellationReason: 'fully booked' },
    });
    expect(emitToUser).toHaveBeenCalledWith(
      customerUserId,
      'booking:rejected',
      expect.objectContaining({ bookingId })
    );
    expect(notifyBookingRejected).toHaveBeenCalledWith(
      customerUserId,
      bookingId,
      'Deep Cleaning',
      'fully booked'
    );
    expect(sendBookingPush).toHaveBeenCalledWith(customerUserId, 'rejected', bookingId, 'Deep Cleaning');
  });

  it('startService emits socket + notification but skips push (no started variant)', async () => {
    (prisma.serviceProvider.findUnique as jest.Mock).mockResolvedValueOnce(fullProvider);
    (prisma.booking.findUnique as jest.Mock).mockResolvedValueOnce({
      ...baseBooking,
      status: 'ACCEPTED',
      payment: { status: 'COMPLETED' },
    });
    (prisma.booking.updateMany as jest.Mock).mockResolvedValueOnce({ count: 1 });
    (prisma.booking.findUniqueOrThrow as jest.Mock).mockResolvedValueOnce({
      ...baseBooking,
      status: 'IN_PROGRESS',
      payment: { status: 'COMPLETED' },
    });

    await startService(bookingId, providerUserId);

    expect(emitToUser).toHaveBeenCalledWith(
      customerUserId,
      'booking:started',
      expect.objectContaining({ bookingId })
    );
    expect(notifyBookingStarted).toHaveBeenCalledWith(customerUserId, bookingId, 'Deep Cleaning');
    expect(sendBookingPush).not.toHaveBeenCalled();
    expect(sendPushToUser).not.toHaveBeenCalled();
  });

  it('completeService notifies the customer with kind "completed"', async () => {
    (prisma.serviceProvider.findUnique as jest.Mock).mockResolvedValueOnce(fullProvider);
    (prisma.booking.findUnique as jest.Mock).mockResolvedValueOnce({
      ...baseBooking,
      status: 'IN_PROGRESS',
    });
    (prisma.booking.updateMany as jest.Mock).mockResolvedValueOnce({ count: 1 });
    (prisma.booking.findUniqueOrThrow as jest.Mock).mockResolvedValueOnce({
      ...baseBooking,
      status: 'COMPLETED',
      completedAt: new Date(),
    });

    await completeService(bookingId, providerUserId);

    expect(prisma.booking.updateMany).toHaveBeenCalledWith({
      where: { id: bookingId, status: 'IN_PROGRESS' },
      data: { status: 'COMPLETED', completedAt: expect.any(Date) },
    });
    expect(emitToUser).toHaveBeenCalledWith(
      customerUserId,
      'booking:completed',
      expect.objectContaining({ bookingId })
    );
    expect(notifyBookingCompleted).toHaveBeenCalledWith(customerUserId, bookingId, 'Deep Cleaning');
    expect(sendBookingPush).toHaveBeenCalledWith(customerUserId, 'completed', bookingId, 'Deep Cleaning');
  });

  it('cancelBooking notifies the PROVIDER (not the customer) with the customer name', async () => {
    (prisma.booking.findUnique as jest.Mock).mockResolvedValueOnce({
      ...baseBooking,
      status: 'PENDING',
      service: { name: 'Deep Cleaning' },
    });
    const tx = makeTx();
    tx.payment.findUnique.mockResolvedValue(null);
    runTransactionWith(tx);
    (prisma.booking.findUniqueOrThrow as jest.Mock).mockResolvedValueOnce({
      ...baseBooking,
      status: 'CANCELLED',
      cancelledAt: new Date(),
      cancellationReason: 'changed my mind',
    });

    await cancelBooking(bookingId, customerUserId, 'changed my mind');

    expect(tx.booking.updateMany).toHaveBeenCalledWith({
      where: { id: bookingId, status: { in: ['PENDING', 'ACCEPTED'] } },
      data: expect.objectContaining({ status: 'CANCELLED', cancellationReason: 'changed my mind' }),
    });
    expect(emitToUser).toHaveBeenCalledWith(
      providerUserId,
      'booking:cancelled',
      expect.objectContaining({ bookingId })
    );
    expect(notifyBookingCancelled).toHaveBeenCalledWith(
      providerUserId,
      bookingId,
      'Deep Cleaning',
      expect.stringContaining('Ada'),
      'changed my mind'
    );
    expect(sendBookingPush).toHaveBeenCalledWith(providerUserId, 'cancelled', bookingId, 'Deep Cleaning');

    // A PENDING booking can't have been paid: no wallet, no refund
    expect(prisma.wallet.findUnique).not.toHaveBeenCalled();
    expect(tx.payment.updateMany).not.toHaveBeenCalled();
    expect(createNotification).not.toHaveBeenCalled();
  });

  it('does not roll back the DB update if a side-effect (push) throws', async () => {
    acceptedFromPending();
    (prisma.booking.findUniqueOrThrow as jest.Mock).mockResolvedValueOnce({
      ...baseBooking,
      status: 'ACCEPTED',
    });
    (sendBookingPush as jest.Mock).mockRejectedValueOnce(new Error('OneSignal exploded'));

    // Should resolve, not throw — the DB update already succeeded.
    await expect(acceptBooking(bookingId, providerUserId)).resolves.toBeDefined();
  });
});

// ==================
// cancelBooking — refund of a paid booking
// ==================

describe('cancelBooking — refund to the customer wallet', () => {
  it('refunds the full amount of a paid ACCEPTED booking to the wallet and notifies the customer', async () => {
    (prisma.booking.findUnique as jest.Mock).mockResolvedValueOnce({ ...baseBooking, status: 'ACCEPTED' });
    (prisma.wallet.findUnique as jest.Mock).mockResolvedValueOnce(customerWallet);
    const tx = makeTx();
    runTransactionWith(tx);
    (prisma.booking.findUniqueOrThrow as jest.Mock).mockResolvedValueOnce({
      ...baseBooking,
      status: 'CANCELLED',
      cancellationReason: 'plans changed',
    });

    const result = await cancelBooking(bookingId, customerUserId, 'plans changed');

    // The wallet is found (or created) before the transaction starts
    expect(prisma.wallet.findUnique).toHaveBeenCalledWith({ where: { userId: customerUserId } });
    expect(prisma.wallet.create).not.toHaveBeenCalled();
    expect((prisma.wallet.findUnique as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan(
      (prisma.$transaction as jest.Mock).mock.invocationCallOrder[0]
    );

    // Booking claimed, then the payment looked up
    expect(tx.booking.updateMany).toHaveBeenCalledWith({
      where: { id: bookingId, status: { in: ['PENDING', 'ACCEPTED'] } },
      data: expect.objectContaining({ status: 'CANCELLED', cancellationReason: 'plans changed' }),
    });
    expect(tx.payment.findUnique).toHaveBeenCalledWith({ where: { bookingId } });

    // Payment marked fully refunded through a cancellation
    expect(tx.payment.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: paymentId, status: 'COMPLETED' }),
      data: expect.objectContaining({
        status: 'REFUNDED',
        refundAmount: 5000,
        refundedVia: 'CANCELLATION',
        refundedAt: expect.any(Date),
      }),
    });

    // ₦5,000 = 500,000 kobo credited once, under the payment's refund reference
    expect(tx.walletTransaction.findUnique).toHaveBeenCalledWith({ where: { reference: `RFD_${paymentId}` } });
    expect(tx.wallet.update).toHaveBeenCalledWith({
      where: { id: walletId },
      data: { balance: { increment: 500_000 } },
    });
    expect(tx.walletTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        walletId,
        type: 'CREDIT',
        source: 'REFUND',
        amount: 500_000,
        balanceBefore: 0,
        balanceAfter: 500_000,
        reference: `RFD_${paymentId}`,
        bookingId,
        paymentId,
      }),
    });

    // The response is read after the transaction
    expect(prisma.booking.findUniqueOrThrow).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: bookingId } })
    );
    expect(result.status).toBe('CANCELLED');

    // Customer told about the refund; provider told about the cancellation
    expect(createNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: customerUserId,
        type: 'REFUND_PROCESSED',
        entityType: 'booking',
        entityId: bookingId,
      })
    );
    expect(sendPushToUser).toHaveBeenCalledWith(
      customerUserId,
      expect.objectContaining({ data: { type: 'REFUND_PROCESSED', bookingId } })
    );
    expect(notifyBookingCancelled).toHaveBeenCalledWith(
      providerUserId,
      bookingId,
      'Deep Cleaning',
      expect.stringContaining('Ada'),
      'plans changed'
    );
  });

  it('throws INVALID_BOOKING_STATUS and refunds nothing when the booking changed meanwhile', async () => {
    (prisma.booking.findUnique as jest.Mock).mockResolvedValueOnce({ ...baseBooking, status: 'ACCEPTED' });
    (prisma.wallet.findUnique as jest.Mock).mockResolvedValueOnce(customerWallet);
    const tx = makeTx();
    tx.booking.updateMany.mockResolvedValue({ count: 0 });
    runTransactionWith(tx);

    let caught: GraphQLError | undefined;
    await cancelBooking(bookingId, customerUserId, 'plans changed').catch((e) => (caught = e));

    expect(caught).toBeInstanceOf(GraphQLError);
    expect(caught!.extensions.code).toBe('INVALID_BOOKING_STATUS');
    expect(tx.payment.findUnique).not.toHaveBeenCalled();
    expect(tx.payment.updateMany).not.toHaveBeenCalled();
    expect(tx.wallet.update).not.toHaveBeenCalled();
    expect(tx.walletTransaction.create).not.toHaveBeenCalled();
    expect(prisma.booking.findUniqueOrThrow).not.toHaveBeenCalled();
    expect(createNotification).not.toHaveBeenCalled();
    expect(sendPushToUser).not.toHaveBeenCalled();
    expect(notifyBookingCancelled).not.toHaveBeenCalled();
  });
});

describe('cancelBooking — 24-hour window in Lagos time', () => {
  // 13 Sep 2026 at 10:30 in Lagos is 09:30 UTC, so the window closes on
  // 12 Sep at 09:30 UTC. Read as UTC, it would stay open until 10:30 UTC.
  const acceptedBooking = {
    ...baseBooking,
    status: 'ACCEPTED',
    scheduledDate: new Date('2026-09-13T00:00:00.000Z'),
    scheduledTime: '10:30',
  };

  it('refuses once it is less than 24 hours before the Lagos time', async () => {
    freezeTime('2026-09-12T09:45:00.000Z');
    (prisma.booking.findUnique as jest.Mock).mockResolvedValueOnce(acceptedBooking);

    await expect(cancelBooking(bookingId, customerUserId, 'Plans changed')).rejects.toMatchObject({
      extensions: { code: 'CANCELLATION_WINDOW_PASSED' },
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('allows it until then', async () => {
    freezeTime('2026-09-12T09:15:00.000Z');
    (prisma.booking.findUnique as jest.Mock).mockResolvedValueOnce(acceptedBooking);
    (prisma.wallet.findUnique as jest.Mock).mockResolvedValueOnce(customerWallet);
    const tx = makeTx();
    runTransactionWith(tx);
    (prisma.booking.findUniqueOrThrow as jest.Mock).mockResolvedValueOnce({ ...acceptedBooking, status: 'CANCELLED' });

    await expect(cancelBooking(bookingId, customerUserId, 'Plans changed')).resolves.toMatchObject({
      status: 'CANCELLED',
    });
  });
});

// ==================
// adminCancelBooking
// ==================

describe('adminCancelBooking', () => {
  const admin = { id: adminId, role: 'ADMIN' };

  it.each(['DISPUTED', 'COMPLETED'])('refuses a %s booking and moves no money', async (status) => {
    (prisma.booking.findUnique as jest.Mock).mockResolvedValueOnce({ ...baseBooking, status });

    let caught: GraphQLError | undefined;
    await adminCancelBooking(bookingId, 'Customer asked support', admin).catch((e) => (caught = e));

    expect(caught).toBeInstanceOf(GraphQLError);
    expect(caught!.extensions.code).toBe('INVALID_BOOKING_STATUS');
    expect(prisma.wallet.findUnique).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(createNotification).not.toHaveBeenCalled();
    expect(createAuditLog).not.toHaveBeenCalled();
  });

  it('refunds a paid IN_PROGRESS booking to the customer wallet with refundedBy set to the admin', async () => {
    (prisma.booking.findUnique as jest.Mock).mockResolvedValueOnce({ ...baseBooking, status: 'IN_PROGRESS' });
    (prisma.wallet.findUnique as jest.Mock).mockResolvedValueOnce(customerWallet);
    const tx = makeTx();
    runTransactionWith(tx);
    (prisma.booking.findUniqueOrThrow as jest.Mock).mockResolvedValueOnce({ ...baseBooking, status: 'CANCELLED' });

    await adminCancelBooking(bookingId, 'Provider did not show up', admin);

    expect(prisma.wallet.findUnique).toHaveBeenCalledWith({ where: { userId: customerUserId } });
    expect(tx.booking.updateMany).toHaveBeenCalledWith({
      where: { id: bookingId, status: { in: ['PENDING', 'ACCEPTED', 'IN_PROGRESS'] } },
      data: expect.objectContaining({
        status: 'CANCELLED',
        cancellationReason: '[Admin] Provider did not show up',
      }),
    });
    expect(tx.payment.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: paymentId, status: 'COMPLETED' }),
      data: expect.objectContaining({
        status: 'REFUNDED',
        refundAmount: 5000,
        refundedBy: adminId,
        refundedVia: 'CANCELLATION',
      }),
    });
    expect(tx.wallet.update).toHaveBeenCalledWith({
      where: { id: walletId },
      data: { balance: { increment: 500_000 } },
    });
    expect(tx.walletTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ walletId, amount: 500_000, reference: `RFD_${paymentId}` }),
    });

    // Both parties hear about the cancellation; the customer about the refund
    expect(notifyBookingCancelled).toHaveBeenCalledWith(
      customerUserId,
      bookingId,
      'Deep Cleaning',
      'Easykonnet support',
      'Provider did not show up'
    );
    expect(notifyBookingCancelled).toHaveBeenCalledWith(
      providerUserId,
      bookingId,
      'Deep Cleaning',
      'Easykonnet support',
      'Provider did not show up'
    );
    expect(createNotification).toHaveBeenCalledWith(
      expect.objectContaining({ userId: customerUserId, type: 'REFUND_PROCESSED', entityId: bookingId })
    );
    expect(createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'PROCESS_REFUND',
        targetId: bookingId,
        performedBy: adminId,
        previousValue: { status: 'IN_PROGRESS' },
        newValue: expect.objectContaining({ status: 'CANCELLED', refundAmount: 5000, refundedTo: 'wallet' }),
      })
    );
  });
});

// ==================
// confirmServiceDelivery
// ==================

describe('confirmServiceDelivery', () => {
  const completedBooking = {
    ...baseBooking,
    status: 'COMPLETED',
    completedAt: new Date(),
    customerConfirmedAt: null,
    payment: { id: paymentId, status: 'COMPLETED' },
  };

  it('sets paymentReleaseAt 24 hours after confirmation with a conditional update', async () => {
    (prisma.booking.findUnique as jest.Mock).mockResolvedValueOnce(completedBooking);
    (prisma.booking.updateMany as jest.Mock).mockResolvedValueOnce({ count: 1 });
    (prisma.booking.findUniqueOrThrow as jest.Mock).mockResolvedValueOnce({
      ...completedBooking,
      customerConfirmedAt: new Date(),
    });
    (prisma.payment.update as jest.Mock).mockResolvedValueOnce({});

    const before = Date.now();
    await confirmServiceDelivery(bookingId, customerUserId);
    const after = Date.now();

    // Only an unconfirmed COMPLETED booking matches
    expect(prisma.booking.updateMany).toHaveBeenCalledWith({
      where: {
        id: bookingId,
        status: 'COMPLETED',
        OR: [{ customerConfirmedAt: null }, { customerConfirmedAt: { isSet: false } }],
      },
      data: { customerConfirmedAt: expect.any(Date), paymentReleaseAt: expect.any(Date) },
    });

    const [{ data }] = (prisma.booking.updateMany as jest.Mock).mock.calls[0] as [
      { data: { customerConfirmedAt: Date; paymentReleaseAt: Date } },
    ];
    expect(data.customerConfirmedAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(data.customerConfirmedAt.getTime()).toBeLessThanOrEqual(after);
    expect(data.paymentReleaseAt.getTime() - data.customerConfirmedAt.getTime()).toBe(24 * 60 * 60 * 1000);

    expect(prisma.payment.update).toHaveBeenCalledWith({
      where: { id: paymentId },
      data: { withdrawableAt: data.paymentReleaseAt },
    });
  });

  it('tells the provider the customer confirmed and when the payment will be released, in Lagos time', async () => {
    freezeTime('2026-09-20T15:02:00.000Z');
    (prisma.booking.findUnique as jest.Mock).mockResolvedValueOnce(completedBooking);
    (prisma.booking.updateMany as jest.Mock).mockResolvedValueOnce({ count: 1 });
    (prisma.booking.findUniqueOrThrow as jest.Mock).mockResolvedValueOnce({
      ...completedBooking,
      customerConfirmedAt: new Date(),
      payment: { id: paymentId, status: 'COMPLETED', providerPayout: 23250 },
    });
    (prisma.payment.update as jest.Mock).mockResolvedValueOnce({});

    await confirmServiceDelivery(bookingId, customerUserId);

    // Released 24 hours later: 21 Sep at 15:02 UTC, 16:02 in Lagos
    const message =
      'Ada Lovelace confirmed delivery of Deep Cleaning. ₦23,250 will be released to your wallet on 21 Sep 2026 at 16:02 (Lagos time), unless a dispute is opened before then.';
    expect(createNotification).toHaveBeenCalledWith({
      userId: providerUserId,
      type: 'BOOKING_COMPLETED',
      title: 'Delivery Confirmed',
      message,
      entityType: 'booking',
      entityId: bookingId,
    });
    expect(sendPushToUser).toHaveBeenCalledWith(providerUserId, {
      title: 'Delivery Confirmed',
      message,
      data: { type: 'BOOKING', bookingId, action: 'confirmed' },
    });
    expect(emitToUser).toHaveBeenCalledWith(
      providerUserId,
      'booking:confirmed',
      expect.objectContaining({ bookingId, booking: expect.objectContaining({ id: bookingId }) })
    );
    // Nothing is sent before the confirmation is saved
    expect((prisma.booking.updateMany as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan(
      (createNotification as jest.Mock).mock.invocationCallOrder[0]
    );
  });

  it('still confirms when the provider notification fails', async () => {
    (prisma.booking.findUnique as jest.Mock).mockResolvedValueOnce(completedBooking);
    (prisma.booking.updateMany as jest.Mock).mockResolvedValueOnce({ count: 1 });
    (prisma.booking.findUniqueOrThrow as jest.Mock).mockResolvedValueOnce({
      ...completedBooking,
      customerConfirmedAt: new Date(),
    });
    (prisma.payment.update as jest.Mock).mockResolvedValueOnce({});
    (createNotification as jest.Mock).mockRejectedValueOnce(new Error('database hiccup'));
    (sendPushToUser as jest.Mock).mockRejectedValueOnce(new Error('OneSignal down'));

    await expect(confirmServiceDelivery(bookingId, customerUserId)).resolves.toMatchObject({ id: bookingId });
    expect(prisma.payment.update).toHaveBeenCalled();
  });

  it('throws ALREADY_CONFIRMED when a second confirmation matches nothing', async () => {
    // Read before the first confirmation was saved
    (prisma.booking.findUnique as jest.Mock).mockResolvedValueOnce(completedBooking);
    (prisma.booking.updateMany as jest.Mock).mockResolvedValueOnce({ count: 0 });

    let caught: GraphQLError | undefined;
    await confirmServiceDelivery(bookingId, customerUserId).catch((e) => (caught = e));

    expect(caught).toBeInstanceOf(GraphQLError);
    expect(caught!.extensions.code).toBe('ALREADY_CONFIRMED');
    expect(prisma.booking.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.booking.findUniqueOrThrow).not.toHaveBeenCalled();
    expect(prisma.payment.update).not.toHaveBeenCalled();
    expect(createNotification).not.toHaveBeenCalled();
    expect(emitToUser).not.toHaveBeenCalled();
  });
});

// ==================
// createBooking
// ==================

// Pick a scheduled date 10 days from now — comfortably inside the
// 30-day-in-advance window the booking validator enforces.
const futureDate = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000)
  .toISOString()
  .split('T')[0];
const validInput = {
  serviceId: 'svc1',
  scheduledDate: futureDate,
  scheduledTime: '14:00',
  address: '1 Main St',
  city: 'Lagos',
  state: 'Lagos',
};

const baseService = {
  id: 'svc1',
  providerId: 'p1',
  price: 5000,
  status: 'ACTIVE',
  provider: {
    id: 'p1',
    userId: providerUserId, // the provider's owning user
    verificationStatus: 'VERIFIED',
  },
  category: { id: 'cat1', name: 'Cleaning' },
};

describe('createBooking — self-booking guard', () => {
  it('rejects when the booker is the provider behind the service', async () => {
    (prisma.service.findUnique as jest.Mock).mockResolvedValueOnce(baseService);

    let caught: GraphQLError | undefined;
    await createBooking(providerUserId, validInput).catch((e) => (caught = e));

    expect(caught).toBeInstanceOf(GraphQLError);
    expect(caught!.extensions.code).toBe('SELF_BOOKING_NOT_ALLOWED');
    expect(prisma.booking.create).not.toHaveBeenCalled();
  });

  it('throws SELF_BOOKING_NOT_ALLOWED before checking service status', async () => {
    // Even an INACTIVE service owned by the caller should fail with the
    // self-booking error first — the guard runs above SERVICE_NOT_AVAILABLE.
    (prisma.service.findUnique as jest.Mock).mockResolvedValueOnce({
      ...baseService,
      status: 'INACTIVE',
    });

    let caught: GraphQLError | undefined;
    await createBooking(providerUserId, validInput).catch((e) => (caught = e));
    expect(caught!.extensions.code).toBe('SELF_BOOKING_NOT_ALLOWED');
  });

  it('allows a different user to book the same service', async () => {
    (prisma.service.findUnique as jest.Mock).mockResolvedValueOnce(baseService);
    (prisma.booking.create as jest.Mock).mockResolvedValueOnce({
      ...baseBooking,
      status: 'PENDING',
    });

    await expect(createBooking(customerUserId, validInput)).resolves.toBeDefined();
    expect(prisma.booking.create).toHaveBeenCalled();
  });

  it('still throws SERVICE_NOT_FOUND when the service does not exist (guard not reached)', async () => {
    (prisma.service.findUnique as jest.Mock).mockResolvedValueOnce(null);

    let caught: GraphQLError | undefined;
    await createBooking(providerUserId, validInput).catch((e) => (caught = e));
    expect(caught!.extensions.code).toBe('SERVICE_NOT_FOUND');
  });
});

describe('createBooking — pricing', () => {
  // The test config's commission rate is 0.07
  it.each([
    [3333.33, 233.33], // 233.3331 unrounded
    [1234.56, 86.42], // 86.4192 unrounded
    [5000, 350],
  ])('stores a price of %s with the commission rounded to whole kobo (%s)', async (price, commission) => {
    (prisma.service.findUnique as jest.Mock).mockResolvedValueOnce({ ...baseService, price });
    (prisma.booking.create as jest.Mock).mockResolvedValueOnce({ ...baseBooking, status: 'PENDING' });

    await createBooking(customerUserId, validInput);

    expect(prisma.booking.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'PENDING',
          servicePrice: price,
          commission,
          totalAmount: price,
        }),
      })
    );
  });

  it('uses the commission rate a Super Admin set', async () => {
    (prisma.platformSettings.findUnique as jest.Mock).mockResolvedValueOnce({ commissionRate: 0.125 });
    (prisma.service.findUnique as jest.Mock).mockResolvedValueOnce({ ...baseService, price: 5000 });
    (prisma.booking.create as jest.Mock).mockResolvedValueOnce({ ...baseBooking, status: 'PENDING' });

    await createBooking(customerUserId, validInput);

    expect(prisma.booking.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ servicePrice: 5000, commission: 625, totalAmount: 5000 }),
      })
    );
  });
});

describe('createBooking — blocks', () => {
  const ids = { customer: customerUserId, provider: providerUserId };

  it.each<['customer' | 'provider', 'customer' | 'provider']>([
    ['customer', 'provider'],
    ['provider', 'customer'],
  ])('refuses with BOOKING_NOT_ALLOWED when the %s has blocked the %s', async (blocker, blocked) => {
    // Only this direction is blocked
    (prisma.userBlock.findFirst as jest.Mock).mockImplementation(
      async ({ where }: { where: { OR: { blockerId: string; blockedId: string }[] } }) =>
        where.OR.some((pair) => pair.blockerId === ids[blocker] && pair.blockedId === ids[blocked])
          ? { id: 'block-1' }
          : null
    );
    (prisma.service.findUnique as jest.Mock).mockResolvedValueOnce(baseService);

    let caught: GraphQLError | undefined;
    await createBooking(customerUserId, validInput).catch((e) => (caught = e));

    expect(caught).toBeInstanceOf(GraphQLError);
    expect(caught!.extensions.code).toBe('BOOKING_NOT_ALLOWED');
    expect(prisma.booking.create).not.toHaveBeenCalled();
  });

  it("checks both directions between the customer and the provider's user before booking", async () => {
    (prisma.service.findUnique as jest.Mock).mockResolvedValueOnce(baseService);
    (prisma.booking.create as jest.Mock).mockResolvedValueOnce({ ...baseBooking, status: 'PENDING' });

    await createBooking(customerUserId, validInput);

    expect(prisma.userBlock.findFirst).toHaveBeenCalledWith({
      where: {
        OR: [
          { blockerId: customerUserId, blockedId: providerUserId },
          { blockerId: providerUserId, blockedId: customerUserId },
        ],
      },
      select: { id: true },
    });
    expect(prisma.booking.create).toHaveBeenCalled();
  });
});

describe('createBooking — tells the provider', () => {
  it('sends the provider an in-app notification, a push and booking:created once the booking is saved', async () => {
    (prisma.service.findUnique as jest.Mock).mockResolvedValueOnce(baseService);
    (prisma.booking.create as jest.Mock).mockResolvedValueOnce({ ...baseBooking, status: 'PENDING' });

    await createBooking(customerUserId, validInput);

    expect(notifyBookingCreated).toHaveBeenCalledWith(providerUserId, bookingId, 'Deep Cleaning', 'Ada Lovelace');
    expect(sendBookingPush).toHaveBeenCalledWith(providerUserId, 'new', bookingId, 'Deep Cleaning');
    expect(emitToUser).toHaveBeenCalledWith(
      providerUserId,
      'booking:created',
      expect.objectContaining({ bookingId, booking: expect.objectContaining({ id: bookingId, status: 'PENDING' }) })
    );
    expect((prisma.booking.create as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan(
      (notifyBookingCreated as jest.Mock).mock.invocationCallOrder[0]
    );
    // The customer isn't told about their own request
    expect(notifyBookingCreated).toHaveBeenCalledTimes(1);
  });

  it('still returns the booking when the socket, notification and push all fail', async () => {
    (prisma.service.findUnique as jest.Mock).mockResolvedValueOnce(baseService);
    (prisma.booking.create as jest.Mock).mockResolvedValueOnce({ ...baseBooking, status: 'PENDING' });
    (emitToUser as jest.Mock).mockRejectedValueOnce(new Error('socket down'));
    (notifyBookingCreated as jest.Mock).mockRejectedValueOnce(new Error('database hiccup'));
    (sendBookingPush as jest.Mock).mockRejectedValueOnce(new Error('OneSignal down'));

    await expect(createBooking(customerUserId, validInput)).resolves.toMatchObject({
      id: bookingId,
      status: 'PENDING',
    });
  });

  it('tells nobody when the booking is refused', async () => {
    (prisma.service.findUnique as jest.Mock).mockResolvedValueOnce({ ...baseService, status: 'INACTIVE' });

    await expect(createBooking(customerUserId, validInput)).rejects.toMatchObject({
      extensions: { code: 'SERVICE_NOT_AVAILABLE' },
    });
    expect(notifyBookingCreated).not.toHaveBeenCalled();
    expect(sendBookingPush).not.toHaveBeenCalled();
    expect(emitToUser).not.toHaveBeenCalled();
  });
});

// ==================
// Booking date and time
// ==================

describe('booking date and time', () => {
  // 10:00 UTC is 11:00 in Lagos
  const now = '2026-09-12T10:00:00.000Z';
  const dateError = 'Scheduled date must be a real date in YYYY-MM-DD format, for example 2026-09-20';
  const timeError = 'Scheduled time must be a 24-hour time in HH:mm format, from 00:00 to 23:59';

  beforeEach(() => {
    freezeTime(now);
    (prisma.service.findUnique as jest.Mock).mockResolvedValue(baseService);
    (prisma.booking.create as jest.Mock).mockResolvedValue({ ...baseBooking, status: 'PENDING' });
  });

  const book = (scheduledDate: string, scheduledTime: string) =>
    createBooking(customerUserId, { ...validInput, scheduledDate, scheduledTime });

  it.each(['2026-09-20T00:00:00.000Z', '20/09/2026', '2026-9-20', '2026-02-30', '2026-13-01', '', 'tomorrow'])(
    'refuses the date %j with INVALID_BOOKING_TIME and books nothing',
    async (scheduledDate) => {
      await expect(book(scheduledDate, '10:00')).rejects.toMatchObject({
        message: dateError,
        extensions: { code: 'INVALID_BOOKING_TIME' },
      });
      expect(prisma.booking.create).not.toHaveBeenCalled();
    }
  );

  it.each(['24:00', '9:30', '09:60', '2pm', '14:00:00', ''])(
    'refuses the time %j with INVALID_BOOKING_TIME and books nothing',
    async (scheduledTime) => {
      await expect(book('2026-09-20', scheduledTime)).rejects.toMatchObject({
        message: timeError,
        extensions: { code: 'INVALID_BOOKING_TIME' },
      });
      expect(prisma.booking.create).not.toHaveBeenCalled();
    }
  );

  it.each(['00:00', '23:59'])('accepts %s', async (scheduledTime) => {
    await expect(book('2026-09-20', scheduledTime)).resolves.toBeDefined();
  });

  it('checks the 2-hour minimum in Lagos time', async () => {
    // 13:00 in Lagos is 12:00 UTC, exactly 2 hours from now
    await expect(book('2026-09-12', '13:00')).resolves.toBeDefined();

    // 12:59 in Lagos is 11:59 UTC: too soon, although 12:59 UTC wouldn't be
    await expect(book('2026-09-12', '12:59')).rejects.toMatchObject({
      message: 'Booking must be scheduled at least 2 hours in advance',
      extensions: { code: 'INVALID_BOOKING_TIME' },
    });
  });

  it('checks the 30-day maximum in Lagos time', async () => {
    // 30 days from now is 12 Oct at 10:00 UTC, which is 11:00 in Lagos
    await expect(book('2026-10-12', '11:00')).resolves.toBeDefined();

    await expect(book('2026-10-12', '11:01')).rejects.toMatchObject({
      message: 'Booking cannot be scheduled more than 30 days in advance',
      extensions: { code: 'INVALID_BOOKING_TIME' },
    });
  });

  it('stores the day at midnight UTC and the time as sent', async () => {
    await book('2026-09-20', '09:30');

    expect(prisma.booking.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          scheduledDate: new Date('2026-09-20T00:00:00.000Z'),
          scheduledTime: '09:30',
        }),
      })
    );
  });

  it("updateBooking checks a new time on the booking's current day, in Lagos time", async () => {
    (prisma.booking.findUnique as jest.Mock).mockResolvedValueOnce({
      ...baseBooking,
      status: 'PENDING',
      scheduledDate: new Date('2026-09-12T00:00:00.000Z'),
      scheduledTime: '18:00',
    });

    await expect(updateBooking(bookingId, customerUserId, { scheduledTime: '12:59' })).rejects.toMatchObject({
      message: 'Booking must be scheduled at least 2 hours in advance',
    });
    expect(prisma.booking.updateMany).not.toHaveBeenCalled();
  });

  it('updateBooking refuses a malformed date', async () => {
    (prisma.booking.findUnique as jest.Mock).mockResolvedValueOnce({ ...baseBooking, status: 'PENDING' });

    await expect(updateBooking(bookingId, customerUserId, { scheduledDate: '2026-09-31' })).rejects.toMatchObject({
      message: dateError,
      extensions: { code: 'INVALID_BOOKING_TIME' },
    });
    expect(prisma.booking.updateMany).not.toHaveBeenCalled();
  });
});

// ==================
// Free text on bookings
// ==================

describe('free text on bookings', () => {
  describe('createBooking address and notes', () => {
    beforeEach(() => {
      (prisma.service.findUnique as jest.Mock).mockResolvedValue(baseService);
      (prisma.booking.create as jest.Mock).mockResolvedValue({ ...baseBooking, status: 'PENDING' });
    });

    it('stores the address, city, state and notes as plain text', async () => {
      await createBooking(customerUserId, {
        ...validInput,
        address: '<b>12 Admiralty Way</b>',
        city: 'Lekki<script>alert(1)</script>',
        state: '  Lagos  ',
        notes: 'Gate & <i>ring twice</i>',
      });

      expect(prisma.booking.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            address: '12 Admiralty Way',
            city: 'Lekki',
            state: 'Lagos',
            notes: 'Gate & ring twice',
          }),
        })
      );
    });

    it('allows a phone number in the address and notes', async () => {
      await createBooking(customerUserId, {
        ...validInput,
        address: 'Flat 3, 12 Admiralty Way. Gatehouse: 08031234567',
        notes: 'Call me on 08031234567 when you arrive',
      });

      expect(prisma.booking.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ notes: 'Call me on 08031234567 when you arrive' }),
        })
      );
    });

    it.each([
      ['address', "The address contains language that isn't allowed on Easykonnet"],
      ['notes', "Your note to the provider contains language that isn't allowed on Easykonnet"],
    ])('refuses blocked language in the %s', async (field, message) => {
      await expect(
        createBooking(customerUserId, { ...validInput, [field]: 'Bring your shit' })
      ).rejects.toMatchObject({ message, extensions: { code: 'INAPPROPRIATE_CONTENT' } });
      expect(prisma.booking.create).not.toHaveBeenCalled();
    });

    it.each([
      ['address', 301, 'The address must be at most 300 characters'],
      ['city', 101, 'The city must be at most 100 characters'],
      ['state', 101, 'The state must be at most 100 characters'],
      ['notes', 1001, 'Your note to the provider must be at most 1000 characters'],
    ])('refuses a %s longer than the limit', async (field, length, message) => {
      await expect(
        createBooking(customerUserId, { ...validInput, [field]: 'a'.repeat(length) })
      ).rejects.toMatchObject({ message, extensions: { code: 'INVALID_INPUT' } });
      expect(prisma.booking.create).not.toHaveBeenCalled();
    });

    it('counts the length after cleaning', async () => {
      await createBooking(customerUserId, { ...validInput, notes: `<b>${'a'.repeat(1000)}</b>` });

      expect(prisma.booking.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ notes: 'a'.repeat(1000) }) })
      );
    });

    it('updateBooking cleans and screens the same way', async () => {
      (prisma.booking.findUnique as jest.Mock).mockResolvedValue({ ...baseBooking, status: 'PENDING' });

      await expect(
        updateBooking(bookingId, customerUserId, { notes: 'Bring your shit' })
      ).rejects.toMatchObject({ extensions: { code: 'INAPPROPRIATE_CONTENT' } });
      expect(prisma.booking.updateMany).not.toHaveBeenCalled();

      (prisma.booking.updateMany as jest.Mock).mockResolvedValueOnce({ count: 1 });
      (prisma.booking.findUniqueOrThrow as jest.Mock).mockResolvedValueOnce({ ...baseBooking, status: 'PENDING' });

      await updateBooking(bookingId, customerUserId, { address: '<b>5 Bode Thomas</b>', notes: null });

      expect(prisma.booking.updateMany).toHaveBeenCalledWith({
        where: { id: bookingId, status: 'PENDING' },
        data: { address: '5 Bode Thomas', notes: null },
      });
    });
  });

  describe('reasons', () => {
    const pendingBooking = { ...baseBooking, status: 'PENDING' };

    it('cancelBooking stores and sends the cleaned reason', async () => {
      (prisma.booking.findUnique as jest.Mock).mockResolvedValueOnce(pendingBooking);
      const tx = makeTx();
      tx.payment.findUnique.mockResolvedValue(null);
      runTransactionWith(tx);
      (prisma.booking.findUniqueOrThrow as jest.Mock).mockResolvedValueOnce({ ...baseBooking, status: 'CANCELLED' });

      await cancelBooking(bookingId, customerUserId, '<b>Plans changed</b> & sorry');

      expect(tx.booking.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ cancellationReason: 'Plans changed & sorry' }) })
      );
      expect(notifyBookingCancelled).toHaveBeenCalledWith(
        providerUserId,
        bookingId,
        'Deep Cleaning',
        'Ada Lovelace',
        'Plans changed & sorry'
      );
    });

    it.each([
      ["Can't make it, you asshole", 'INAPPROPRIATE_CONTENT'],
      ['Cancelling here, pay me directly on 08031234567', 'CONTACT_DETAILS_NOT_ALLOWED'],
      ['a'.repeat(501), 'INVALID_INPUT'],
    ])('cancelBooking refuses a bad reason (%s) with %s and cancels nothing', async (reason, code) => {
      (prisma.booking.findUnique as jest.Mock).mockResolvedValueOnce(pendingBooking);

      await expect(cancelBooking(bookingId, customerUserId, reason)).rejects.toMatchObject({ extensions: { code } });
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(notifyBookingCancelled).not.toHaveBeenCalled();
    });

    it('rejectBooking stores the cleaned reason', async () => {
      (prisma.serviceProvider.findUnique as jest.Mock).mockResolvedValueOnce(fullProvider);
      (prisma.booking.findUnique as jest.Mock).mockResolvedValueOnce(pendingBooking);
      (prisma.booking.updateMany as jest.Mock).mockResolvedValueOnce({ count: 1 });
      (prisma.booking.findUniqueOrThrow as jest.Mock).mockResolvedValueOnce({ ...baseBooking, status: 'REJECTED' });

      await rejectBooking(bookingId, providerUserId, 'Fully booked <i>that day</i>');

      expect(prisma.booking.updateMany).toHaveBeenCalledWith({
        where: { id: bookingId, status: 'PENDING' },
        data: { status: 'REJECTED', cancellationReason: 'Fully booked that day' },
      });
      expect(notifyBookingRejected).toHaveBeenCalledWith(
        customerUserId,
        bookingId,
        'Deep Cleaning',
        'Fully booked that day'
      );
    });

    it.each([
      ['Not working for you, bitch', 'INAPPROPRIATE_CONTENT'],
      ['Book me outside the app: ada@example.com', 'CONTACT_DETAILS_NOT_ALLOWED'],
      ['a'.repeat(501), 'INVALID_INPUT'],
    ])('rejectBooking refuses a bad reason (%s) with %s and rejects nothing', async (reason, code) => {
      (prisma.serviceProvider.findUnique as jest.Mock).mockResolvedValueOnce(fullProvider);
      (prisma.booking.findUnique as jest.Mock).mockResolvedValueOnce(pendingBooking);

      await expect(rejectBooking(bookingId, providerUserId, reason)).rejects.toMatchObject({ extensions: { code } });
      expect(prisma.booking.updateMany).not.toHaveBeenCalled();
      expect(notifyBookingRejected).not.toHaveBeenCalled();
    });

    it('adminCancelBooking allows contact details in the reason but not blocked language', async () => {
      (prisma.booking.findUnique as jest.Mock).mockResolvedValueOnce(pendingBooking);
      const tx = makeTx();
      tx.payment.findUnique.mockResolvedValue(null);
      runTransactionWith(tx);
      (prisma.booking.findUniqueOrThrow as jest.Mock).mockResolvedValueOnce({ ...baseBooking, status: 'CANCELLED' });

      await adminCancelBooking(bookingId, 'Duplicate booking. Questions: support@easykonnet.com', {
        id: adminId,
        role: 'ADMIN',
      });

      expect(tx.booking.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            cancellationReason: '[Admin] Duplicate booking. Questions: support@easykonnet.com',
          }),
        })
      );

      (prisma.booking.findUnique as jest.Mock).mockResolvedValueOnce(pendingBooking);
      await expect(
        adminCancelBooking(bookingId, 'This shit is a duplicate', { id: adminId, role: 'ADMIN' })
      ).rejects.toMatchObject({ extensions: { code: 'INAPPROPRIATE_CONTENT' } });
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    });
  });
});

// ==================
// Blocks after a booking was made
// ==================

describe('acceptBooking — blocks', () => {
  it('refuses with BOOKING_NOT_ALLOWED when either person has blocked the other since the request', async () => {
    (prisma.serviceProvider.findUnique as jest.Mock).mockResolvedValueOnce(fullProvider);
    (prisma.booking.findUnique as jest.Mock).mockResolvedValueOnce({ ...baseBooking, status: 'PENDING' });
    (prisma.userBlock.findFirst as jest.Mock).mockResolvedValue({ id: 'block-1' });

    await expect(acceptBooking(bookingId, providerUserId)).rejects.toMatchObject({
      message: "You can't accept this booking",
      extensions: { code: 'BOOKING_NOT_ALLOWED' },
    });

    expect(prisma.userBlock.findFirst).toHaveBeenCalledWith({
      where: {
        OR: [
          { blockerId: customerUserId, blockedId: providerUserId },
          { blockerId: providerUserId, blockedId: customerUserId },
        ],
      },
      select: { id: true },
    });
    expect(prisma.booking.updateMany).not.toHaveBeenCalled();
    expect(notifyBookingAccepted).not.toHaveBeenCalled();
  });

  it('lets a booking accepted before the block be started', async () => {
    (prisma.userBlock.findFirst as jest.Mock).mockResolvedValue({ id: 'block-1' });
    (prisma.serviceProvider.findUnique as jest.Mock).mockResolvedValueOnce(fullProvider);
    (prisma.booking.findUnique as jest.Mock).mockResolvedValueOnce({
      ...baseBooking,
      status: 'ACCEPTED',
      payment: { status: 'COMPLETED' },
    });
    (prisma.booking.updateMany as jest.Mock).mockResolvedValueOnce({ count: 1 });
    (prisma.booking.findUniqueOrThrow as jest.Mock).mockResolvedValueOnce({ ...baseBooking, status: 'IN_PROGRESS' });

    await expect(startService(bookingId, providerUserId)).resolves.toMatchObject({ status: 'IN_PROGRESS' });
    expect(prisma.userBlock.findFirst).not.toHaveBeenCalled();
  });
});

// ==================
// Booking responses
// ==================

describe('booking responses', () => {
  const images = ['https://res.cloudinary.com/demo/image/upload/portfolio-1.jpg'];

  it("carries the provider's images on provider and service.provider", async () => {
    (prisma.booking.findUnique as jest.Mock).mockResolvedValueOnce({
      ...baseBooking,
      provider: { ...baseBooking.provider, userId: providerUserId, images },
      service: { ...baseBooking.service, provider: { id: providerId, businessName: 'Top Cleaners', images } },
    });

    const result = await getBookingById(bookingId, customerUserId, 'SERVICE_USER');

    expect(result.provider).toMatchObject({ id: providerId, images });
    expect(result.service.provider).toMatchObject({ id: providerId, images });
  });

  it("uses the booking's provider for service.provider when the service's isn't loaded, and [] without images", async () => {
    (prisma.booking.findUnique as jest.Mock).mockResolvedValueOnce({
      ...baseBooking,
      provider: { ...baseBooking.provider, userId: providerUserId },
      service: { id: 'svc1', name: 'Deep Cleaning' },
    });

    const result = await getBookingById(bookingId, customerUserId, 'SERVICE_USER');

    expect(result.provider.images).toEqual([]);
    expect(result.service.provider).toEqual(result.provider);
  });

  it('leaves out a review an admin removed', async () => {
    const review = { id: 'rev1', rating: 5, comment: 'Great', createdAt: new Date(), updatedAt: new Date() };
    (prisma.booking.findUnique as jest.Mock)
      .mockResolvedValueOnce({ ...baseBooking, provider: { ...baseBooking.provider, userId: providerUserId }, review })
      .mockResolvedValueOnce({
        ...baseBooking,
        provider: { ...baseBooking.provider, userId: providerUserId },
        review: { ...review, deletedAt: new Date() },
      });

    expect((await getBookingById(bookingId, customerUserId, 'SERVICE_USER')).review).toEqual(review);
    expect((await getBookingById(bookingId, customerUserId, 'SERVICE_USER')).review).toBeNull();
  });
});

// ==================
// Provider booking stats
// ==================

describe('getProviderBookingStats', () => {
  it("rounds the completion rate to one decimal and totals the provider's share of paid, completed bookings", async () => {
    (prisma.serviceProvider.findUnique as jest.Mock).mockResolvedValueOnce(fullProvider);
    (prisma.booking.count as jest.Mock)
      .mockResolvedValueOnce(26) // all
      .mockResolvedValueOnce(2) // pending
      .mockResolvedValueOnce(20) // completed
      .mockResolvedValueOnce(3); // cancelled
    (prisma.payment.aggregate as jest.Mock).mockResolvedValueOnce({ _sum: { providerPayout: 465000.0000001 } });

    const stats = await getProviderBookingStats(providerUserId);

    expect(stats).toEqual({
      totalBookings: 26,
      pendingBookings: 2,
      completedBookings: 20,
      cancelledBookings: 3,
      totalRevenue: 465000,
      completionRate: 76.9, // 76.923…
    });
    expect(prisma.payment.aggregate).toHaveBeenCalledWith({
      where: { status: 'COMPLETED', booking: { providerId, status: 'COMPLETED' } },
      _sum: { providerPayout: true },
    });
  });

  it('returns zeros for a provider with no bookings', async () => {
    (prisma.serviceProvider.findUnique as jest.Mock).mockResolvedValueOnce(fullProvider);
    (prisma.booking.count as jest.Mock).mockResolvedValue(0);
    (prisma.payment.aggregate as jest.Mock).mockResolvedValueOnce({ _sum: { providerPayout: null } });

    await expect(getProviderBookingStats(providerUserId)).resolves.toMatchObject({
      totalBookings: 0,
      totalRevenue: 0,
      completionRate: 0,
    });
  });
});
