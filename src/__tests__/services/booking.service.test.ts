/**
 * Booking Service Tests
 *
 * Covers the fixes from the bug-fix sweep:
 *   - startService payment guard (cannot start until ACCEPTED + payment COMPLETED)
 *   - dispatchBookingEvent fan-out (socket + notification + push) on
 *     acceptBooking, rejectBooking, startService, completeService, cancelBooking
 *   - cancelBooking notifies the *provider* (not the customer)
 */

import { GraphQLError } from 'graphql';

// ==================
// Mocks
// ==================

jest.mock('@/lib/prisma', () => ({
  __esModule: true,
  default: {
    serviceProvider: {
      findUnique: jest.fn(),
    },
    booking: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
  },
}));

jest.mock('@/lib/socket', () => ({
  emitToUser: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/services/notification.service', () => ({
  notifyBookingAccepted: jest.fn().mockResolvedValue(undefined),
  notifyBookingRejected: jest.fn().mockResolvedValue(undefined),
  notifyBookingStarted: jest.fn().mockResolvedValue(undefined),
  notifyBookingCompleted: jest.fn().mockResolvedValue(undefined),
  notifyBookingCancelled: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/services/push.service', () => ({
  sendBookingPush: jest.fn().mockResolvedValue(undefined),
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
  notifyBookingAccepted,
  notifyBookingRejected,
  notifyBookingStarted,
  notifyBookingCompleted,
  notifyBookingCancelled,
} from '@/services/notification.service';
import { sendBookingPush } from '@/services/push.service';
import {
  acceptBooking,
  rejectBooking,
  startService,
  completeService,
  cancelBooking,
} from '@/services/booking.service';

// ==================
// Fixtures
// ==================

const customerUserId = '507f1f77bcf86cd700000001';
const providerUserId = '507f1f77bcf86cd700000002';
const providerId = '507f1f77bcf86cd700000010';
const bookingId = '507f1f77bcf86cd700000020';

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

beforeEach(() => {
  jest.clearAllMocks();
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
    expect(prisma.booking.update).not.toHaveBeenCalled();
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
    expect(prisma.booking.update).not.toHaveBeenCalled();
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
    expect(prisma.booking.update).not.toHaveBeenCalled();
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
    (prisma.booking.update as jest.Mock).mockResolvedValueOnce({
      ...baseBooking,
      status: 'IN_PROGRESS',
      payment: { status: 'COMPLETED' },
    });

    await startService(bookingId, providerUserId);

    expect(prisma.booking.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: bookingId },
        data: { status: 'IN_PROGRESS' },
      })
    );
  });
});

// ==================
// dispatchBookingEvent fan-out (via each mutation)
// ==================

describe('booking event dispatch — fan-out to socket + notification + push', () => {
  it('acceptBooking notifies the customer with kind "accepted"', async () => {
    (prisma.serviceProvider.findUnique as jest.Mock).mockResolvedValueOnce(fullProvider);
    (prisma.booking.findUnique as jest.Mock).mockResolvedValueOnce({
      ...baseBooking,
      status: 'PENDING',
    });
    (prisma.booking.update as jest.Mock).mockResolvedValueOnce({
      ...baseBooking,
      status: 'ACCEPTED',
    });

    await acceptBooking(bookingId, providerUserId);

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

  it('rejectBooking notifies the customer with reason', async () => {
    (prisma.serviceProvider.findUnique as jest.Mock).mockResolvedValueOnce(fullProvider);
    (prisma.booking.findUnique as jest.Mock).mockResolvedValueOnce({
      ...baseBooking,
      status: 'PENDING',
    });
    (prisma.booking.update as jest.Mock).mockResolvedValueOnce({
      ...baseBooking,
      status: 'REJECTED',
    });

    await rejectBooking(bookingId, providerUserId, 'fully booked');

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
    (prisma.booking.update as jest.Mock).mockResolvedValueOnce({
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
  });

  it('completeService notifies the customer with kind "completed"', async () => {
    (prisma.serviceProvider.findUnique as jest.Mock).mockResolvedValueOnce(fullProvider);
    (prisma.booking.findUnique as jest.Mock).mockResolvedValueOnce({
      ...baseBooking,
      status: 'IN_PROGRESS',
    });
    (prisma.booking.update as jest.Mock).mockResolvedValueOnce({
      ...baseBooking,
      status: 'COMPLETED',
      completedAt: new Date(),
    });

    await completeService(bookingId, providerUserId);

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
    (prisma.booking.update as jest.Mock).mockResolvedValueOnce({
      ...baseBooking,
      status: 'CANCELLED',
      cancelledAt: new Date(),
      cancellationReason: 'changed my mind',
    });

    await cancelBooking(bookingId, customerUserId, 'changed my mind');

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
  });

  it('does not roll back the DB update if a side-effect (push) throws', async () => {
    (prisma.serviceProvider.findUnique as jest.Mock).mockResolvedValueOnce(fullProvider);
    (prisma.booking.findUnique as jest.Mock).mockResolvedValueOnce({
      ...baseBooking,
      status: 'PENDING',
    });
    (prisma.booking.update as jest.Mock).mockResolvedValueOnce({
      ...baseBooking,
      status: 'ACCEPTED',
    });
    (sendBookingPush as jest.Mock).mockRejectedValueOnce(new Error('OneSignal exploded'));

    // Should resolve, not throw — the DB update already succeeded.
    await expect(acceptBooking(bookingId, providerUserId)).resolves.toBeDefined();
  });
});
