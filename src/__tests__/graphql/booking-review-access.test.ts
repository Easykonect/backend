/**
 * Booking and review access rules
 *
 * Covers:
 *   - Booking.user: the customer's email and phone go only to the customer and
 *     admins. The booking's provider gets the name and photo, and the booking
 *     still resolves although User.email is non-null.
 *   - deleteReview is for admins, and passes the admin and the reason on
 */

import { graphql, type ExecutionResult } from 'graphql';
import { makeExecutableSchema } from '@graphql-tools/schema';

jest.mock('@/lib/prisma', () => ({ __esModule: true, default: {} }));
// The Resend client throws at import time without an API key
jest.mock('@/lib/email', () => ({ __esModule: true, default: {} }));
jest.mock('@/services/booking.service', () => ({
  ...jest.requireActual('@/services/booking.service'),
  getBookingById: jest.fn(),
}));
jest.mock('@/services/review.service', () => ({
  ...jest.requireActual('@/services/review.service'),
  deleteReview: jest.fn(),
}));

import { typeDefs, resolvers as guardedResolvers } from '@/graphql';
import { resolvers } from '@/graphql/resolvers';
import { getBookingById } from '@/services/booking.service';
import { deleteReview } from '@/services/review.service';
import type { GraphQLContext } from '@/middleware';

const customerId = '66e2a0c0f0a9d83b5c7e0101';
const providerUserId = '66e2a0c0f0a9d83b5c7e0102';
const adminId = '66e2a0c0f0a9d83b5c7e0103';
const bookingId = '66e2a0c0f0a9d83b5c7e0104';
const reviewId = '66e2a0c0f0a9d83b5c7e0105';

const contextFor = (userId: string, role: string): GraphQLContext =>
  ({ user: { userId, email: `${userId}@example.com`, role } }) as GraphQLContext;

const anonymous = { user: null } as GraphQLContext;

const customer = {
  id: customerId,
  firstName: 'Chinedu',
  lastName: 'Okafor',
  email: 'chinedu@example.com',
  phone: '+2348031234567',
  profilePhoto: 'https://res.cloudinary.com/demo/image/upload/chinedu.jpg',
  role: 'SERVICE_USER',
  status: 'ACTIVE',
  isEmailVerified: true,
  pushEnabled: true,
  lastLoginAt: '2026-09-12T08:00:00.000Z',
  createdAt: '2026-01-05T10:00:00.000Z',
  updatedAt: '2026-09-12T08:00:00.000Z',
};

describe('Booking.user', () => {
  const resolve = resolvers.Booking.user;
  const booking = { id: bookingId, userId: customerId, user: customer };

  it('gives the customer their own email and phone', () => {
    expect(resolve(booking, {}, contextFor(customerId, 'SERVICE_USER'))).toEqual(customer);
  });

  it('gives admins and super admins the email and phone', () => {
    expect(resolve(booking, {}, contextFor(adminId, 'ADMIN'))).toEqual(customer);
    expect(resolve(booking, {}, contextFor(adminId, 'SUPER_ADMIN'))).toEqual(customer);
  });

  it("gives the booking's provider the name and photo, without email, phone or last sign-in", () => {
    expect(resolve(booking, {}, contextFor(providerUserId, 'SERVICE_PROVIDER'))).toEqual({
      ...customer,
      email: '',
      phone: null,
      lastLoginAt: null,
    });
  });

  it('hides them when nobody is signed in', () => {
    expect(resolve(booking, {}, anonymous)).toMatchObject({ email: '', phone: null, lastLoginAt: null });
  });

  it('returns a missing user unchanged', () => {
    const withoutUser = { id: bookingId, user: null };
    expect(resolve(withoutUser, {}, contextFor(adminId, 'ADMIN'))).toBeNull();
  });
});

describe('booking query — customer contact details', () => {
  const schema = makeExecutableSchema({ typeDefs, resolvers: guardedResolvers });
  const source = `
    query Booking($id: ID!) {
      booking(id: $id) {
        id
        user { id firstName lastName profilePhoto email phone lastLoginAt }
      }
    }
  `;

  const run = (userId: string, role: string) =>
    graphql({
      schema,
      source,
      variableValues: { id: bookingId },
      contextValue: contextFor(userId, role),
    }) as Promise<ExecutionResult>;

  beforeEach(() => {
    (getBookingById as jest.Mock).mockResolvedValue({ id: bookingId, userId: customerId, user: customer });
  });

  it("returns the booking to its provider with the customer's email empty and phone null", async () => {
    const result = await run(providerUserId, 'SERVICE_PROVIDER');

    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({
      booking: {
        id: bookingId,
        user: {
          id: customerId,
          firstName: 'Chinedu',
          lastName: 'Okafor',
          profilePhoto: customer.profilePhoto,
          email: '',
          phone: null,
          lastLoginAt: null,
        },
      },
    });
  });

  it('returns them to the customer', async () => {
    const result = await run(customerId, 'SERVICE_USER');

    expect(result.errors).toBeUndefined();
    expect(result.data?.booking).toMatchObject({
      user: { email: 'chinedu@example.com', phone: '+2348031234567', lastLoginAt: '2026-09-12T08:00:00.000Z' },
    });
  });
});

describe('deleteReview', () => {
  const resolve = resolvers.Mutation.deleteReview;
  const deleted = { success: true, message: 'Review deleted successfully' };

  it.each(['SERVICE_USER', 'SERVICE_PROVIDER'])('is refused to a %s', async (role) => {
    await expect(resolve(undefined, { id: reviewId }, contextFor(customerId, role))).rejects.toMatchObject({
      extensions: { code: 'UNAUTHORIZED' },
    });
    expect(deleteReview).not.toHaveBeenCalled();
  });

  it('removes the review as the signed-in admin, with the reason', async () => {
    (deleteReview as jest.Mock).mockResolvedValueOnce(deleted);

    await expect(
      resolve(undefined, { id: reviewId, reason: 'Abusive language' }, contextFor(adminId, 'ADMIN'))
    ).resolves.toEqual(deleted);
    expect(deleteReview).toHaveBeenCalledWith(reviewId, { id: adminId, role: 'ADMIN' }, 'Abusive language');
  });

  it('passes no reason when none, or null, is sent', async () => {
    (deleteReview as jest.Mock).mockResolvedValue(deleted);

    await resolve(undefined, { id: reviewId }, contextFor(adminId, 'SUPER_ADMIN'));
    await resolve(undefined, { id: reviewId, reason: null }, contextFor(adminId, 'SUPER_ADMIN'));

    expect(deleteReview).toHaveBeenNthCalledWith(1, reviewId, { id: adminId, role: 'SUPER_ADMIN' }, undefined);
    expect(deleteReview).toHaveBeenNthCalledWith(2, reviewId, { id: adminId, role: 'SUPER_ADMIN' }, undefined);
  });
});
