/**
 * Review Service Tests
 *
 * Covers:
 *   - createReview requires booking.status === COMPLETED
 *   - Caller must own the booking
 *   - Cannot review the same booking twice
 */

import { GraphQLError } from 'graphql';

// ==================
// Mocks
// ==================

jest.mock('@/lib/prisma', () => ({
  __esModule: true,
  default: {
    booking: {
      findUnique: jest.fn(),
    },
    review: {
      create: jest.fn(),
    },
  },
}));

jest.mock('@/config', () => ({
  config: {
    redisUrl: 'redis://localhost:6379',
  },
}));

jest.mock('@/lib/redis', () => ({
  __esModule: true,
  default: {
    getInstance: jest.fn().mockReturnValue({
      get: jest.fn(),
      set: jest.fn(),
    }),
  },
}));

import prisma from '@/lib/prisma';
import { createReview } from '@/services/review.service';

// ==================
// Fixtures
// ==================

const userId = '507f1f77bcf86cd700000001';
const bookingId = '507f1f77bcf86cd700000020';

const completedBooking = {
  id: bookingId,
  userId,
  providerId: 'p1',
  status: 'COMPLETED',
  user: { id: userId, firstName: 'Ada', lastName: 'L' },
  provider: { id: 'p1', businessName: 'Top' },
  service: { id: 'svc1', name: 'Cleaning' },
  review: null,
};

beforeEach(() => {
  (prisma.booking.findUnique as jest.Mock).mockReset();
  (prisma.review.create as jest.Mock).mockReset();
});

// ==================
// Guard tests
// ==================

describe('createReview — review-after-complete guard', () => {
  it('rejects when booking is still IN_PROGRESS', async () => {
    (prisma.booking.findUnique as jest.Mock).mockResolvedValueOnce({
      ...completedBooking,
      status: 'IN_PROGRESS',
    });

    let caught: GraphQLError | undefined;
    await createReview(userId, { bookingId, rating: 5, comment: 'great' }).catch(
      (e) => (caught = e)
    );
    expect(caught).toBeInstanceOf(GraphQLError);
    expect(caught!.extensions.code).toBe('BOOKING_NOT_COMPLETED');
    expect(prisma.review.create).not.toHaveBeenCalled();
  });

  it('rejects when booking is still PENDING (provider has not even accepted)', async () => {
    (prisma.booking.findUnique as jest.Mock).mockResolvedValueOnce({
      ...completedBooking,
      status: 'PENDING',
    });

    await expect(
      createReview(userId, { bookingId, rating: 4 })
    ).rejects.toThrow(/only review completed bookings/);
  });

  it('rejects when caller does not own the booking', async () => {
    (prisma.booking.findUnique as jest.Mock).mockResolvedValueOnce({
      ...completedBooking,
      userId: 'someone-else',
    });

    let caught: GraphQLError | undefined;
    await createReview(userId, { bookingId, rating: 4 }).catch((e) => (caught = e));
    expect(caught!.extensions.code).toBe('FORBIDDEN');
  });

  it('rejects when the booking has already been reviewed', async () => {
    (prisma.booking.findUnique as jest.Mock).mockResolvedValueOnce({
      ...completedBooking,
      review: { id: 'existing-review' },
    });

    let caught: GraphQLError | undefined;
    await createReview(userId, { bookingId, rating: 4 }).catch((e) => (caught = e));
    expect(caught!.extensions.code).toBe('ALREADY_REVIEWED');
    expect(prisma.review.create).not.toHaveBeenCalled();
  });

  it('creates a review when booking is COMPLETED and not already reviewed', async () => {
    (prisma.booking.findUnique as jest.Mock).mockResolvedValueOnce(completedBooking);
    (prisma.review.create as jest.Mock).mockResolvedValueOnce({
      id: 'rev1',
      bookingId,
      userId,
      providerId: 'p1',
      rating: 5,
      comment: 'great work',
      response: null,
      respondedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      user: { id: userId, firstName: 'Ada', lastName: 'L', email: 'a@e.com' },
      provider: { id: 'p1', businessName: 'Top', user: null },
      booking: { id: bookingId, scheduledDate: new Date(), service: null },
    });

    const result = await createReview(userId, { bookingId, rating: 5, comment: 'great work' });
    expect(result.id).toBe('rev1');
    expect(prisma.review.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          bookingId,
          userId,
          providerId: 'p1',
          rating: 5,
        }),
      })
    );
  });
});
