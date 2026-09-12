/**
 * GraphQL fields added for disputes and moderation
 *
 * Covers:
 *   - Dispute.reviewedBy (the admin who took the dispute) is only returned to admins
 *   - Dispute.reviewedBy and Dispute.reviewStartedAt are nullable
 *   - Message.isHidden is nullable, and false for messages stored without it
 */

import { buildASTSchema, type GraphQLObjectType } from 'graphql';

jest.mock('@/lib/prisma', () => ({ __esModule: true, default: {} }));
// The Resend client throws at import time without an API key
jest.mock('@/lib/email', () => ({ __esModule: true, default: {} }));

import { resolvers } from '@/graphql/resolvers';
import { typeDefs } from '@/graphql/schemas';
import type { GraphQLContext } from '@/middleware';

const contextFor = (userId: string, role: string): GraphQLContext =>
  ({ user: { userId, email: `${userId}@example.com`, role } }) as GraphQLContext;

const anonymous = { user: null } as GraphQLContext;

const schema = buildASTSchema(typeDefs);
const fieldType = (typeName: string, field: string) =>
  String((schema.getType(typeName) as GraphQLObjectType).getFields()[field]?.type);

describe('Dispute.reviewedBy', () => {
  const adminUserId = '66e2a0c0f0a9d83b5c7e0008';
  const dispute = { id: 'dispute-1', reviewedBy: adminUserId, reviewStartedAt: '2026-09-12T09:00:00.000Z' };
  const resolve = resolvers.Dispute.reviewedBy;

  it('is returned to admins and super admins', () => {
    expect(resolve(dispute, {}, contextFor('admin-user', 'ADMIN'))).toBe(adminUserId);
    expect(resolve(dispute, {}, contextFor('super-user', 'SUPER_ADMIN'))).toBe(adminUserId);
  });

  it('is null for the customer, the provider and anonymous callers', () => {
    expect(resolve(dispute, {}, contextFor('customer-user', 'SERVICE_USER'))).toBeNull();
    expect(resolve(dispute, {}, contextFor('provider-user', 'SERVICE_PROVIDER'))).toBeNull();
    expect(resolve(dispute, {}, anonymous)).toBeNull();
  });

  it('is null for admins when nobody has taken the dispute', () => {
    expect(resolve({}, {}, contextFor('admin-user', 'ADMIN'))).toBeNull();
    expect(resolve({ reviewedBy: null }, {}, contextFor('admin-user', 'ADMIN'))).toBeNull();
  });

  it('is declared as nullable, next to a nullable reviewStartedAt', () => {
    expect(fieldType('Dispute', 'reviewedBy')).toBe('ID');
    expect(fieldType('Dispute', 'reviewStartedAt')).toBe('String');
  });
});

describe('Message.isHidden', () => {
  const resolve = resolvers.Message.isHidden;

  it('returns the stored value', () => {
    expect(resolve({ isHidden: true })).toBe(true);
    expect(resolve({ isHidden: false })).toBe(false);
  });

  it('is false for messages stored without it', () => {
    expect(resolve({})).toBe(false);
    expect(resolve({ isHidden: null })).toBe(false);
  });

  it('is declared as a nullable Boolean', () => {
    expect(fieldType('Message', 'isHidden')).toBe('Boolean');
  });
});
