/**
 * Review Service Tests
 *
 * Covers:
 *   - createReview requires booking.status === COMPLETED
 *   - Caller must own the booking
 *   - Cannot review the same booking twice, including after an admin removed the review
 *   - Comments and responses are screened for blocked language and contact
 *     details; updated comments are sanitized and screened too
 *   - Lengths are measured after cleaning, with maximums
 *   - A review hidden by moderation keeps its rating but not its text
 *   - The provider is told about a new review, and the reviewer about a reply
 *   - updateReview reports a bad rating like createReview
 *   - ReviewService.title is the service's name
 *   - The hasResponse filter, and removed reviews left out of lists and ratings
 *   - deleteReview marks the review removed and writes an audit log
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
      findUnique: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      aggregate: jest.fn(),
      groupBy: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
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

jest.mock('@/services/notification.service', () => ({
  notifyReviewReceived: jest.fn(),
  notifyReviewResponse: jest.fn(),
}));

jest.mock('@/services/push.service', () => ({
  sendReviewPush: jest.fn(),
  sendPushToUser: jest.fn(),
}));

jest.mock('@/services/audit.service', () => ({
  createAuditLog: jest.fn(),
}));

jest.mock('@/lib/logger', () => ({
  logger: { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import prisma from '@/lib/prisma';
import { sanitizeBasic } from '@/utils/security';
import { createAuditLog } from '@/services/audit.service';
import { notifyReviewReceived, notifyReviewResponse } from '@/services/notification.service';
import { sendPushToUser, sendReviewPush } from '@/services/push.service';
import {
  canReviewBooking,
  createReview,
  deleteReview,
  getProviderRatingStats,
  getProviderReviews,
  getReviewById,
  getServiceReviews,
  getUserReviews,
  respondToReview,
  updateReview,
} from '@/services/review.service';

// ==================
// Fixtures
// ==================

const userId = '507f1f77bcf86cd700000001';
const providerUserId = '507f1f77bcf86cd700000002';
const bookingId = '507f1f77bcf86cd700000020';
const adminId = '507f1f77bcf86cd700000050';

const notDeleted = { OR: [{ deletedAt: null }, { deletedAt: { isSet: false } }] };

const completedBooking = {
  id: bookingId,
  userId,
  providerId: 'p1',
  status: 'COMPLETED',
  user: { id: userId, firstName: 'Ada', lastName: 'L' },
  provider: { id: 'p1', userId: providerUserId, businessName: 'Top' },
  service: { id: 'svc1', name: 'Cleaning' },
  review: null as Record<string, unknown> | null,
};

// A review as loaded with its relations, written just now
const reviewRecord = {
  id: 'rev1',
  bookingId,
  userId,
  providerId: 'p1',
  rating: 4,
  comment: 'Good work overall',
  response: null as string | null,
  isHidden: false as boolean | undefined,
  deletedAt: null as Date | null,
  respondedAt: null as Date | null,
  createdAt: new Date(),
  updatedAt: new Date(),
  user: { id: userId, firstName: 'Ada', lastName: 'L', email: 'a@e.com' },
  provider: { id: 'p1', userId: providerUserId, businessName: 'Top', user: null },
  booking: null as Record<string, unknown> | null,
};

const prismaMocks = [
  prisma.booking.findUnique,
  ...Object.values(prisma.review),
] as jest.Mock[];

beforeEach(() => {
  for (const mock of [
    ...prismaMocks,
    notifyReviewReceived,
    notifyReviewResponse,
    sendReviewPush,
    sendPushToUser,
    createAuditLog,
  ] as jest.Mock[]) {
    mock.mockReset();
  }
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
      review: { id: 'existing-review', deletedAt: null },
    });

    let caught: GraphQLError | undefined;
    await createReview(userId, { bookingId, rating: 4 }).catch((e) => (caught = e));
    expect(caught!.extensions.code).toBe('ALREADY_REVIEWED');
    expect(caught!.message).toBe('You have already reviewed this booking');
    expect(prisma.review.create).not.toHaveBeenCalled();
  });

  it('refuses a booking whose review an admin removed', async () => {
    (prisma.booking.findUnique as jest.Mock).mockResolvedValueOnce({
      ...completedBooking,
      review: { id: 'removed-review', deletedAt: new Date() },
    });

    await expect(createReview(userId, { bookingId, rating: 5, comment: 'Trying again' })).rejects.toMatchObject({
      message: "This booking's review was removed by Easykonnet, so it can't be reviewed again",
      extensions: { code: 'ALREADY_REVIEWED' },
    });
    expect(prisma.review.create).not.toHaveBeenCalled();
    expect(notifyReviewReceived).not.toHaveBeenCalled();
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

// ==================
// Content screening and lengths
// ==================

describe('createReview — content screening', () => {
  beforeEach(() => {
    (prisma.booking.findUnique as jest.Mock).mockResolvedValue(completedBooking);
  });

  it('rejects a comment with blocked language and creates nothing', async () => {
    let caught: GraphQLError | undefined;
    await createReview(userId, { bookingId, rating: 1, comment: 'Total bullshit, never again' }).catch(
      (e) => (caught = e)
    );

    expect(caught).toBeInstanceOf(GraphQLError);
    expect(caught!.extensions.code).toBe('INAPPROPRIATE_CONTENT');
    expect(prisma.review.create).not.toHaveBeenCalled();
  });

  it('rejects a phone number in a comment', async () => {
    let caught: GraphQLError | undefined;
    await createReview(userId, {
      bookingId,
      rating: 5,
      comment: 'Great job, call him directly on 08031234567',
    }).catch((e) => (caught = e));

    expect(caught).toBeInstanceOf(GraphQLError);
    expect(caught!.extensions.code).toBe('CONTACT_DETAILS_NOT_ALLOWED');
    expect(prisma.review.create).not.toHaveBeenCalled();
  });

  it('refuses a comment over 1000 characters', async () => {
    await expect(createReview(userId, { bookingId, rating: 5, comment: 'a'.repeat(1001) })).rejects.toMatchObject({
      message: 'Your review must be at most 1000 characters',
      extensions: { code: 'INVALID_INPUT' },
    });
    expect(prisma.review.create).not.toHaveBeenCalled();
  });

  it('counts the comment length after cleaning', async () => {
    (prisma.review.create as jest.Mock).mockResolvedValueOnce(reviewRecord);

    await createReview(userId, { bookingId, rating: 5, comment: `<b>${'a'.repeat(1000)}</b>` });

    expect(prisma.review.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ comment: 'a'.repeat(1000) }) })
    );
  });
});

describe('respondToReview — content screening', () => {
  beforeEach(() => {
    (prisma.review.findUnique as jest.Mock).mockResolvedValue(reviewRecord);
    (prisma.review.update as jest.Mock).mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      ...reviewRecord,
      ...data,
    }));
  });

  it.each([
    ['Thanks for nothing, you asshole', 'INAPPROPRIATE_CONTENT'],
    ['Thanks! Book me directly on 08031234567 next time', 'CONTACT_DETAILS_NOT_ALLOWED'],
  ])('rejects the reply %j with %s and saves nothing', async (reply, code) => {
    await expect(respondToReview('p1', 'rev1', reply)).rejects.toMatchObject({ extensions: { code } });
    expect(prisma.review.update).not.toHaveBeenCalled();
  });

  it('saves a clean reply', async () => {
    const result = await respondToReview('p1', 'rev1', 'Thank you for booking with us!');

    expect(prisma.review.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'rev1' },
        data: { response: 'Thank you for booking with us!', respondedAt: expect.any(Date) },
      })
    );
    expect(result.response).toBe('Thank you for booking with us!');
  });

  it('counts the 10-character minimum after cleaning', async () => {
    // 20 characters as typed, 7 once the markup and spaces are gone
    await expect(respondToReview('p1', 'rev1', '   <b>Thanks!</b>   ')).rejects.toMatchObject({
      message: 'Response must be at least 10 characters',
      extensions: { code: 'INVALID_RESPONSE' },
    });
    expect(prisma.review.update).not.toHaveBeenCalled();
  });

  it('refuses a reply over 1000 characters', async () => {
    await expect(respondToReview('p1', 'rev1', 'a'.repeat(1001))).rejects.toMatchObject({
      message: 'Response must be at most 1000 characters',
      extensions: { code: 'INVALID_RESPONSE' },
    });
    expect(prisma.review.update).not.toHaveBeenCalled();
  });
});

describe('updateReview — sanitizing and screening', () => {
  beforeEach(() => {
    (prisma.review.findUnique as jest.Mock).mockResolvedValue(reviewRecord);
    (prisma.review.update as jest.Mock).mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      ...reviewRecord,
      ...data,
    }));
  });

  it('stores the sanitized comment', async () => {
    const comment = 'Lovely job<script>alert("hi")</script>';

    await updateReview(userId, 'rev1', { comment });

    const { data } = (prisma.review.update as jest.Mock).mock.calls[0][0];
    expect(data.comment).toBe(sanitizeBasic(comment));
    expect(data.comment).toBe('Lovely job');
  });

  it.each([
    ['Changed my mind, it was shit', 'INAPPROPRIATE_CONTENT'],
    ['Email me at ada@example.com for the full story', 'CONTACT_DETAILS_NOT_ALLOWED'],
    ['a'.repeat(1001), 'INVALID_INPUT'],
  ])('rejects the comment %j with %s and saves nothing', async (comment, code) => {
    await expect(updateReview(userId, 'rev1', { comment })).rejects.toMatchObject({ extensions: { code } });
    expect(prisma.review.update).not.toHaveBeenCalled();
  });

  it.each([0, 6, 4.5, null])('refuses the rating %p with the same error as createReview', async (rating) => {
    await expect(updateReview(userId, 'rev1', { rating })).rejects.toMatchObject({
      message: 'Rating must be between 1 and 5',
      extensions: { code: 'INVALID_INPUT' },
    });
    await expect(createReview(userId, { bookingId, rating: rating as number })).rejects.toMatchObject({
      message: 'Rating must be between 1 and 5',
      extensions: { code: 'INVALID_INPUT' },
    });
    expect(prisma.review.update).not.toHaveBeenCalled();
  });

  it('saves a valid rating', async () => {
    await updateReview(userId, 'rev1', { rating: 2 });

    expect(prisma.review.update).toHaveBeenCalledWith(expect.objectContaining({ data: { rating: 2 } }));
  });

  it('refuses to update a removed review', async () => {
    (prisma.review.findUnique as jest.Mock).mockResolvedValueOnce({ ...reviewRecord, deletedAt: new Date() });

    await expect(updateReview(userId, 'rev1', { rating: 5 })).rejects.toMatchObject({
      message: 'Review not found',
      extensions: { code: 'NOT_FOUND' },
    });
    expect(prisma.review.update).not.toHaveBeenCalled();
  });
});

// ==================
// Notifications
// ==================

describe('review notifications', () => {
  it('tells the provider about a new review once it is saved', async () => {
    (prisma.booking.findUnique as jest.Mock).mockResolvedValueOnce(completedBooking);
    (prisma.review.create as jest.Mock).mockResolvedValueOnce({ ...reviewRecord, rating: 5 });

    await createReview(userId, { bookingId, rating: 5, comment: 'Spotless kitchen' });

    expect(notifyReviewReceived).toHaveBeenCalledWith(providerUserId, 'rev1', 5, 'Ada L');
    expect(sendReviewPush).toHaveBeenCalledWith(providerUserId, 'Ada L', 5, 'Cleaning', { reviewId: 'rev1' });
    expect((prisma.review.create as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan(
      (notifyReviewReceived as jest.Mock).mock.invocationCallOrder[0]
    );
  });

  it('still returns the review when the notification and push fail', async () => {
    (prisma.booking.findUnique as jest.Mock).mockResolvedValueOnce(completedBooking);
    (prisma.review.create as jest.Mock).mockResolvedValueOnce(reviewRecord);
    (notifyReviewReceived as jest.Mock).mockRejectedValueOnce(new Error('database hiccup'));
    (sendReviewPush as jest.Mock).mockRejectedValueOnce(new Error('OneSignal down'));

    await expect(createReview(userId, { bookingId, rating: 4 })).resolves.toMatchObject({ id: 'rev1' });
  });

  it('tells the reviewer when the provider replies', async () => {
    (prisma.review.findUnique as jest.Mock).mockResolvedValueOnce(reviewRecord);
    (prisma.review.update as jest.Mock).mockResolvedValueOnce({ ...reviewRecord, response: 'Thank you so much!' });

    await respondToReview('p1', 'rev1', 'Thank you so much!');

    expect(notifyReviewResponse).toHaveBeenCalledWith(userId, 'rev1', 'Top');
    expect(sendPushToUser).toHaveBeenCalledWith(userId, {
      title: 'Provider Responded to Your Review',
      message: 'Top has responded to your review',
      data: { type: 'REVIEW', reviewId: 'rev1' },
    });
  });

  it("doesn't tell the reviewer about a reply to a hidden review", async () => {
    (prisma.review.findUnique as jest.Mock).mockResolvedValueOnce({ ...reviewRecord, isHidden: true });
    (prisma.review.update as jest.Mock).mockResolvedValueOnce({
      ...reviewRecord,
      isHidden: true,
      response: 'Thank you so much!',
    });

    await respondToReview('p1', 'rev1', 'Thank you so much!');

    expect(notifyReviewResponse).not.toHaveBeenCalled();
    expect(sendPushToUser).not.toHaveBeenCalled();
  });

  it('refuses a reply to a removed review and tells nobody', async () => {
    (prisma.review.findUnique as jest.Mock).mockResolvedValueOnce({ ...reviewRecord, deletedAt: new Date() });

    await expect(respondToReview('p1', 'rev1', 'Thank you so much!')).rejects.toMatchObject({
      extensions: { code: 'NOT_FOUND' },
    });
    expect(prisma.review.update).not.toHaveBeenCalled();
    expect(notifyReviewResponse).not.toHaveBeenCalled();
  });
});

// ==================
// Reading reviews
// ==================

describe('hidden reviews', () => {
  it('returns a hidden review with its rating but without comment or response', async () => {
    (prisma.review.findUnique as jest.Mock).mockResolvedValueOnce({
      ...reviewRecord,
      comment: 'Abusive comment',
      response: 'Angry reply',
      isHidden: true,
    });

    const result = await getReviewById('rev1');

    expect(result).toMatchObject({ id: 'rev1', rating: 4, comment: null, response: null, isHidden: true });
  });

  it('returns the text, and isHidden false, for a review without the field', async () => {
    (prisma.review.findUnique as jest.Mock).mockResolvedValueOnce({
      ...reviewRecord,
      response: 'Thank you!',
      isHidden: undefined,
    });

    const result = await getReviewById('rev1');

    expect(result).toMatchObject({ comment: 'Good work overall', response: 'Thank you!', isHidden: false });
  });
});

describe('ReviewService.title', () => {
  it("is the service's name", async () => {
    (prisma.review.findUnique as jest.Mock).mockResolvedValueOnce({
      ...reviewRecord,
      booking: {
        id: bookingId,
        scheduledDate: new Date('2026-09-20T00:00:00.000Z'),
        service: { id: 'svc1', name: 'Deep House Cleaning' },
      },
    });

    const result = await getReviewById('rev1');

    expect(result.booking).toEqual({
      id: bookingId,
      scheduledDate: '2026-09-20',
      service: { id: 'svc1', title: 'Deep House Cleaning' },
    });
  });
});

describe('removed reviews are left out', () => {
  beforeEach(() => {
    (prisma.review.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.review.count as jest.Mock).mockResolvedValue(0);
  });

  it('getReviewById returns NOT_FOUND', async () => {
    (prisma.review.findUnique as jest.Mock).mockResolvedValueOnce({ ...reviewRecord, deletedAt: new Date() });

    await expect(getReviewById('rev1')).rejects.toMatchObject({
      message: 'Review not found',
      extensions: { code: 'NOT_FOUND' },
    });
  });

  it('from a provider’s reviews and their count', async () => {
    await getProviderReviews('p1', {}, { page: 1, limit: 10 });

    const where = { providerId: 'p1', AND: [notDeleted] };
    expect(prisma.review.findMany).toHaveBeenCalledWith(expect.objectContaining({ where }));
    expect(prisma.review.count).toHaveBeenCalledWith({ where });
  });

  it('from the reviewer’s own list and count', async () => {
    await getUserReviews(userId, { page: 1, limit: 10 });

    const where = { userId, AND: [notDeleted] };
    expect(prisma.review.findMany).toHaveBeenCalledWith(expect.objectContaining({ where }));
    expect(prisma.review.count).toHaveBeenCalledWith({ where });
  });

  it('from a service’s reviews and count', async () => {
    await getServiceReviews('svc1', { page: 1, limit: 10 });

    const where = { booking: { serviceId: 'svc1' }, AND: [notDeleted] };
    expect(prisma.review.findMany).toHaveBeenCalledWith(expect.objectContaining({ where }));
    expect(prisma.review.count).toHaveBeenCalledWith({ where });
  });

  it('from the rating average, total and star breakdown', async () => {
    (prisma.review.aggregate as jest.Mock).mockResolvedValueOnce({ _avg: { rating: 4.26 }, _count: { id: 3 } });
    (prisma.review.groupBy as jest.Mock).mockResolvedValueOnce([
      { rating: 5, _count: { rating: 2 } },
      { rating: 3, _count: { rating: 1 } },
    ]);

    const stats = await getProviderRatingStats('p1');

    const where = { providerId: 'p1', AND: [notDeleted] };
    expect(prisma.review.aggregate).toHaveBeenCalledWith(expect.objectContaining({ where }));
    expect(prisma.review.groupBy).toHaveBeenCalledWith(expect.objectContaining({ where }));
    expect(stats).toMatchObject({ averageRating: 4.3, totalReviews: 3, fiveStars: 2, threeStars: 1, oneStar: 0 });
  });
});

describe('providerReviews hasResponse filter', () => {
  beforeEach(() => {
    (prisma.review.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.review.count as jest.Mock).mockResolvedValue(0);
  });

  it('false matches a null reply or no reply field at all', async () => {
    await getProviderReviews('p1', { hasResponse: false }, { page: 1, limit: 10 });

    expect(prisma.review.count).toHaveBeenCalledWith({
      where: {
        providerId: 'p1',
        AND: [notDeleted, { OR: [{ response: null }, { response: { isSet: false } }] }],
      },
    });
  });

  it('true matches a saved, non-null reply', async () => {
    await getProviderReviews('p1', { hasResponse: true, rating: 5 }, { page: 1, limit: 10 });

    expect(prisma.review.count).toHaveBeenCalledWith({
      where: {
        providerId: 'p1',
        rating: 5,
        AND: [notDeleted, { response: { isSet: true, not: null } }],
      },
    });
  });

  it('null or left out applies no reply filter', async () => {
    await getProviderReviews('p1', { hasResponse: null }, { page: 1, limit: 10 });

    expect(prisma.review.count).toHaveBeenCalledWith({ where: { providerId: 'p1', AND: [notDeleted] } });
  });
});

// ==================
// Removing reviews
// ==================

describe('deleteReview', () => {
  const admin = { id: adminId, role: 'ADMIN' };

  it('marks the review removed, keeps it stored, and writes an audit log with what it said', async () => {
    (prisma.review.findUnique as jest.Mock).mockResolvedValueOnce({
      ...reviewRecord,
      comment: 'Rude comment',
      response: 'Reply',
    });
    (prisma.review.updateMany as jest.Mock).mockResolvedValueOnce({ count: 1 });

    const result = await deleteReview('rev1', admin, '<b>Abusive</b> language');

    expect(result).toEqual({ success: true, message: 'Review deleted successfully' });
    expect(prisma.review.updateMany).toHaveBeenCalledWith({
      where: { id: 'rev1', AND: [notDeleted] },
      data: { deletedAt: expect.any(Date), deletedBy: adminId, deletionReason: 'Abusive language' },
    });

    const [{ data }] = (prisma.review.updateMany as jest.Mock).mock.calls[0];
    expect(createAuditLog).toHaveBeenCalledWith({
      action: 'DELETE_REVIEW',
      targetType: 'Review',
      targetId: 'rev1',
      performedBy: adminId,
      performedByRole: 'ADMIN',
      previousValue: {
        rating: 4,
        comment: 'Rude comment',
        response: 'Reply',
        isHidden: false,
        userId,
        providerId: 'p1',
        bookingId,
      },
      newValue: { deletedAt: data.deletedAt.toISOString() },
      reason: 'Abusive language',
    });
  });

  it('works without a reason', async () => {
    (prisma.review.findUnique as jest.Mock).mockResolvedValueOnce(reviewRecord);
    (prisma.review.updateMany as jest.Mock).mockResolvedValueOnce({ count: 1 });

    await deleteReview('rev1', admin);

    expect(prisma.review.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ deletionReason: null }) })
    );
    expect(createAuditLog).toHaveBeenCalledWith(expect.objectContaining({ reason: undefined }));
  });

  it.each([
    ['missing', null],
    ['already removed', { ...reviewRecord, deletedAt: new Date() }],
  ])('returns NOT_FOUND for a %s review and logs nothing', async (_label, record) => {
    (prisma.review.findUnique as jest.Mock).mockResolvedValueOnce(record);

    await expect(deleteReview('rev1', admin)).rejects.toMatchObject({
      message: 'Review not found',
      extensions: { code: 'NOT_FOUND' },
    });
    expect(prisma.review.updateMany).not.toHaveBeenCalled();
    expect(createAuditLog).not.toHaveBeenCalled();
  });

  it('returns NOT_FOUND and logs nothing when another admin removed it at the same moment', async () => {
    (prisma.review.findUnique as jest.Mock).mockResolvedValueOnce(reviewRecord);
    (prisma.review.updateMany as jest.Mock).mockResolvedValueOnce({ count: 0 });

    await expect(deleteReview('rev1', admin)).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } });
    expect(createAuditLog).not.toHaveBeenCalled();
  });

  it('refuses a reason over 500 characters', async () => {
    (prisma.review.findUnique as jest.Mock).mockResolvedValueOnce(reviewRecord);

    await expect(deleteReview('rev1', admin, 'a'.repeat(501))).rejects.toMatchObject({
      message: 'The reason must be at most 500 characters',
      extensions: { code: 'INVALID_INPUT' },
    });
    expect(prisma.review.updateMany).not.toHaveBeenCalled();
  });

  it('still succeeds when the audit log fails', async () => {
    (prisma.review.findUnique as jest.Mock).mockResolvedValueOnce(reviewRecord);
    (prisma.review.updateMany as jest.Mock).mockResolvedValueOnce({ count: 1 });
    (createAuditLog as jest.Mock).mockRejectedValueOnce(new Error('database hiccup'));

    await expect(deleteReview('rev1', admin)).resolves.toMatchObject({ success: true });
  });

  it('canReviewBooking says the removed review blocks a new one', async () => {
    (prisma.booking.findUnique as jest.Mock).mockResolvedValueOnce({
      ...completedBooking,
      review: { id: 'rev1', deletedAt: new Date() },
    });

    await expect(canReviewBooking(userId, bookingId)).resolves.toEqual({
      canReview: false,
      reason: "This booking's review was removed by Easykonnet",
    });
  });
});
