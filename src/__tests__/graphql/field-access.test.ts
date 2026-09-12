/**
 * GraphQL field access rules
 *
 * Covers:
 *   - ServiceProviderProfile.documents is only returned to the provider and admins
 *   - ReviewUser.email is only returned to the reviewer and admins
 *   - payWithWallet requires authentication and pays as the signed-in user, with
 *     the amount taken from the booking on the server, never from the client
 *   - the report queue and report decisions are for admins only
 *   - blocking, reporting and the community terms act as the signed-in user
 *   - Review.comment and Review.response are null for a hidden review
 */

import { GraphQLError } from 'graphql';

jest.mock('@/lib/prisma', () => ({ __esModule: true, default: {} }));
// The Resend client throws at import time without an API key
jest.mock('@/lib/email', () => ({ __esModule: true, default: {} }));
jest.mock('@/services/payment.service', () => ({
  ...jest.requireActual('@/services/payment.service'),
  payWithWallet: jest.fn(),
}));
jest.mock('@/services/block.service', () => ({
  ...jest.requireActual('@/services/block.service'),
  blockUser: jest.fn(),
  unblockUser: jest.fn(),
  getMyBlockedUsers: jest.fn(),
}));
jest.mock('@/services/report.service', () => ({
  ...jest.requireActual('@/services/report.service'),
  createReport: jest.fn(),
  getMyReports: jest.fn(),
  getReports: jest.fn(),
  getReportById: jest.fn(),
  getReportedConversationMessages: jest.fn(),
  resolveReport: jest.fn(),
}));
jest.mock('@/services/terms.service', () => ({
  ...jest.requireActual('@/services/terms.service'),
  acceptTerms: jest.fn(),
  getTermsStatus: jest.fn(),
}));

import { resolvers } from '@/graphql/resolvers';
import { payWithWallet } from '@/services/payment.service';
import { blockUser, getMyBlockedUsers, unblockUser } from '@/services/block.service';
import {
  createReport,
  getMyReports,
  getReportById,
  getReportedConversationMessages,
  getReports,
  resolveReport,
} from '@/services/report.service';
import { acceptTerms, getTermsStatus } from '@/services/terms.service';
import type { GraphQLContext } from '@/middleware';

const contextFor = (userId: string, role: string): GraphQLContext =>
  ({ user: { userId, email: `${userId}@example.com`, role } }) as GraphQLContext;

const anonymous = { user: null } as GraphQLContext;

describe('ServiceProviderProfile.documents', () => {
  const documents = ['https://res.cloudinary.com/demo/image/upload/v1/easykonect/documents/id.jpg'];
  const profile = { id: 'provider-1', userId: 'owner-user', documents };
  const resolve = resolvers.ServiceProviderProfile.documents;

  it('returns nothing to anonymous callers', () => {
    expect(resolve(profile, {}, anonymous)).toEqual([]);
  });

  it('returns nothing to other signed-in users', () => {
    expect(resolve(profile, {}, contextFor('customer-user', 'SERVICE_USER'))).toEqual([]);
  });

  it('returns the documents to the provider who owns them', () => {
    expect(resolve(profile, {}, contextFor('owner-user', 'SERVICE_PROVIDER'))).toEqual(documents);
  });

  it('returns the documents to admins and super admins', () => {
    expect(resolve(profile, {}, contextFor('admin-user', 'ADMIN'))).toEqual(documents);
    expect(resolve(profile, {}, contextFor('super-user', 'SUPER_ADMIN'))).toEqual(documents);
  });

  it('fails closed when the owner is unknown', () => {
    const { userId: _userId, ...withoutOwner } = profile;
    expect(resolve(withoutOwner, {}, contextFor('owner-user', 'SERVICE_PROVIDER'))).toEqual([]);
  });
});

describe('ReviewUser.email', () => {
  const reviewer = { id: 'reviewer-user', firstName: 'Ada', lastName: 'Obi', email: 'ada@example.com' };
  const resolve = resolvers.ReviewUser.email;

  it('hides the email from anonymous callers and other users', () => {
    expect(resolve(reviewer, {}, anonymous)).toBeNull();
    expect(resolve(reviewer, {}, contextFor('someone-else', 'SERVICE_PROVIDER'))).toBeNull();
  });

  it('shows the email to the reviewer and to admins', () => {
    expect(resolve(reviewer, {}, contextFor('reviewer-user', 'SERVICE_USER'))).toBe('ada@example.com');
    expect(resolve(reviewer, {}, contextFor('admin-user', 'ADMIN'))).toBe('ada@example.com');
  });
});

describe('Mutation.payWithWallet', () => {
  it('requires authentication', async () => {
    const attempt = resolvers.Mutation.payWithWallet(undefined, { input: { bookingId: 'booking-1' } }, anonymous);

    await expect(attempt).rejects.toThrow(GraphQLError);
    await expect(attempt).rejects.toMatchObject({ extensions: { code: 'UNAUTHENTICATED' } });
    expect(payWithWallet).not.toHaveBeenCalled();
  });

  it('pays as the signed-in user with only the booking id', async () => {
    const paid = { success: true, message: 'Payment successful', remainingBalance: 4000 };
    (payWithWallet as jest.Mock).mockResolvedValue(paid);
    // An amount sent by the client must never reach the service
    const args = { input: { bookingId: 'booking-1', amount: 1 } };

    await expect(
      resolvers.Mutation.payWithWallet(undefined, args, contextFor('customer-user', 'SERVICE_USER'))
    ).resolves.toBe(paid);

    expect(payWithWallet).toHaveBeenCalledTimes(1);
    expect(payWithWallet).toHaveBeenCalledWith('customer-user', 'booking-1');
  });
});

describe('moderation operations', () => {
  type Operation = (context: GraphQLContext) => Promise<unknown>;

  describe('admin only', () => {
    const operations: Record<string, Operation> = {
      reports: (context) => resolvers.Query.reports(undefined, {}, context),
      report: (context) => resolvers.Query.report(undefined, { id: 'report-1' }, context),
      reportedConversationMessages: (context) =>
        resolvers.Query.reportedConversationMessages(undefined, { reportId: 'report-1' }, context),
      resolveReport: (context) =>
        resolvers.Mutation.resolveReport(
          undefined,
          { id: 'report-1', input: { action: 'DISMISS', notes: 'No breach found' } },
          context
        ),
    };
    const services = [getReports, getReportById, getReportedConversationMessages, resolveReport];

    it.each(Object.keys(operations))('%s is refused for customers, providers and anonymous callers', async (name) => {
      for (const role of ['SERVICE_USER', 'SERVICE_PROVIDER']) {
        await expect(operations[name](contextFor('member-user', role))).rejects.toMatchObject({
          extensions: { code: 'UNAUTHORIZED' },
        });
      }
      await expect(operations[name](anonymous)).rejects.toMatchObject({
        extensions: { code: 'UNAUTHENTICATED' },
      });

      for (const service of services) {
        expect(service).not.toHaveBeenCalled();
      }
    });

    it.each(['ADMIN', 'SUPER_ADMIN'])('are allowed for a %s, who is recorded as the moderator', async (role) => {
      for (const run of Object.values(operations)) {
        await run(contextFor('admin-user', role));
      }

      for (const service of services) {
        expect(service).toHaveBeenCalledTimes(1);
      }
      expect(getReportedConversationMessages).toHaveBeenCalledWith('report-1', { id: 'admin-user', role }, undefined);
      expect(resolveReport).toHaveBeenCalledWith(
        'report-1',
        { id: 'admin-user', role },
        { action: 'DISMISS', notes: 'No breach found' }
      );
    });
  });

  describe('act as the signed-in user', () => {
    const reportInput = {
      targetType: 'USER',
      targetId: 'target-user',
      reason: 'HARASSMENT',
      details: 'Keeps sending abusive messages',
    } as const;

    const operations: Record<string, { run: Operation; service: unknown; args: unknown[] }> = {
      myBlockedUsers: {
        run: (context) => resolvers.Query.myBlockedUsers(undefined, { pagination: { page: 2 } }, context),
        service: getMyBlockedUsers,
        args: [{ page: 2 }],
      },
      myReports: {
        run: (context) => resolvers.Query.myReports(undefined, { pagination: { page: 2 } }, context),
        service: getMyReports,
        args: [{ page: 2 }],
      },
      termsStatus: {
        run: (context) => resolvers.Query.termsStatus(undefined, {}, context),
        service: getTermsStatus,
        args: [],
      },
      blockUser: {
        run: (context) => resolvers.Mutation.blockUser(undefined, { userId: 'target-user', reason: 'Spam' }, context),
        service: blockUser,
        args: ['target-user', 'Spam'],
      },
      unblockUser: {
        run: (context) => resolvers.Mutation.unblockUser(undefined, { userId: 'target-user' }, context),
        service: unblockUser,
        args: ['target-user'],
      },
      createReport: {
        run: (context) => resolvers.Mutation.createReport(undefined, { input: reportInput }, context),
        service: createReport,
        args: [reportInput],
      },
      acceptTerms: {
        run: (context) => resolvers.Mutation.acceptTerms(undefined, { version: '2026-09' }, context),
        service: acceptTerms,
        args: ['2026-09'],
      },
    };

    it.each(Object.keys(operations))("%s passes the signed-in user's id to the service", async (name) => {
      const { run, service, args } = operations[name];

      await run(contextFor('member-user', 'SERVICE_USER'));

      expect(service).toHaveBeenCalledTimes(1);
      expect(service).toHaveBeenCalledWith('member-user', ...args);
    });

    it.each(Object.keys(operations))('%s requires authentication', async (name) => {
      const { run, service } = operations[name];

      await expect(run(anonymous)).rejects.toMatchObject({ extensions: { code: 'UNAUTHENTICATED' } });
      expect(service).not.toHaveBeenCalled();
    });
  });
});

describe('Review type', () => {
  const { comment, response, isHidden } = resolvers.Review;
  const review = { id: 'review-1', rating: 1, comment: 'Offensive comment', response: 'Angry reply' };

  it('returns a null comment and response, and isHidden true, for a hidden review', () => {
    const hidden = { ...review, isHidden: true };

    expect(comment(hidden)).toBeNull();
    expect(response(hidden)).toBeNull();
    expect(isHidden(hidden)).toBe(true);
  });

  it('returns the text, and isHidden false, when the field is missing', () => {
    expect(comment(review)).toBe('Offensive comment');
    expect(response(review)).toBe('Angry reply');
    expect(isHidden(review)).toBe(false);
  });
});
