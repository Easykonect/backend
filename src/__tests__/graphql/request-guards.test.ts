/**
 * Request guards: ObjectId checks on ID arguments, pagination limits and ISO
 * dates, run through a real Apollo Server
 */

import { ApolloServer } from '@apollo/server';
import { dateAwareFieldResolver, withRequestGuards } from '@/graphql/request-guards';

const typeDefs = `#graphql
  input PaginationInput {
    page: Int
    limit: Int
  }

  input ItemFilter {
    ownerId: ID
    tagIds: [ID!]
  }

  type Nested {
    when: String
  }

  type Item {
    id: ID!
    createdAt: String!
    nested: Nested
  }

  type Page {
    page: Int!
    limit: Int!
  }

  input BrowseInput {
    search: String
    pagination: PaginationInput
  }

  type Query {
    item(id: ID!): Item
    items(filter: ItemFilter, pagination: PaginationInput): Page
    browse(input: BrowseInput): Page
    services(pagination: PaginationInput): Page
    auditLogsForTarget(targetId: ID!): String
    top(limit: Int): Int
  }
`;

const VALID_ID = '64f1c2a9e4b0a1b2c3d4e5f6';

const item = jest.fn(() => ({
  id: VALID_ID,
  createdAt: new Date('2026-09-12T08:30:00.000Z'),
  nested: { when: new Date('2026-09-13T10:00:00.000Z') },
}));

const server = new ApolloServer({
  typeDefs,
  fieldResolver: dateAwareFieldResolver,
  resolvers: withRequestGuards({
    Query: {
      item,
      items: (_: unknown, args: { pagination?: { page: number; limit: number } }) =>
        args.pagination ?? { page: -1, limit: -1 },
      browse: (_: unknown, args: { input?: { pagination?: { page: number; limit: number } } }) =>
        args.input?.pagination ?? { page: -1, limit: -1 },
      services: (_: unknown, args: { pagination?: { page: number; limit: number } }) =>
        args.pagination ?? { page: -1, limit: -1 },
      auditLogsForTarget: () => 'ok',
      top: (_: unknown, args: { limit?: number }) => args.limit ?? -1,
    },
    Item: {
      // An explicit resolver that returns a Date
      createdAt: (parent: { createdAt: Date }) => parent.createdAt,
    },
  }),
});

const run = async (query: string) => {
  const response = await server.executeOperation({ query });
  if (response.body.kind !== 'single') throw new Error('Expected a single result');
  return response.body.singleResult;
};

describe('ID arguments', () => {
  it('rejects a malformed ID before the resolver runs', async () => {
    const result = await run('{ item(id: "abc") { id } }');

    expect(result.errors?.[0]).toMatchObject({
      message: 'id is not a valid ID',
      extensions: { code: 'BAD_USER_INPUT' },
    });
    expect(item).not.toHaveBeenCalled();
  });

  it('checks IDs inside input objects and lists', async () => {
    const result = await run(`{ items(filter: { tagIds: ["${VALID_ID}", "nope"] }) { page } }`);

    expect(result.errors?.[0]).toMatchObject({
      message: 'filter.tagIds[1] is not a valid ID',
      extensions: { code: 'BAD_USER_INPUT' },
    });
  });

  it('accepts valid IDs', async () => {
    const result = await run(`{ item(id: "${VALID_ID}") { id } }`);

    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({ item: { id: VALID_ID } });
  });

  it('checks audit log targets too, since audit logs only store ObjectIds', async () => {
    const result = await run('{ auditLogsForTarget(targetId: "platform") }');

    expect(result.errors?.[0]).toMatchObject({
      message: 'targetId is not a valid ID',
      extensions: { code: 'BAD_USER_INPUT' },
    });
  });
});

describe('pagination', () => {
  it.each([
    ['{ page: 0, limit: 500 }', { page: 1, limit: 100 }],
    ['{ page: 3 }', { page: 3, limit: 10 }],
    ['{ page: -2, limit: -5 }', { page: 1, limit: 10 }],
    ['{ page: 2, limit: 0 }', { page: 2, limit: 10 }],
    ['{ page: 4, limit: 25 }', { page: 4, limit: 25 }],
  ])('normalises %s', async (pagination, expected) => {
    const result = await run(`{ items(pagination: ${pagination}) { page limit } }`);

    expect(result.data).toEqual({ items: expected });
  });

  it("uses the operation's own default page size when the limit is missing", async () => {
    const result = await run('{ services(pagination: { page: 2 }) { page limit } }');

    expect(result.data).toEqual({ services: { page: 2, limit: 20 } });
  });

  it('normalises pagination inside an input object', async () => {
    const result = await run('{ browse(input: { search: "clean", pagination: { page: 0, limit: 1000 } }) { page limit } }');

    expect(result.data).toEqual({ browse: { page: 1, limit: 100 } });
  });

  it('leaves a missing pagination argument for the service to default', async () => {
    const result = await run('{ items { page limit } }');

    expect(result.data).toEqual({ items: { page: -1, limit: -1 } });
  });

  it('caps a plain limit argument at 100', async () => {
    const result = await run('{ top(limit: 1000) }');

    expect(result.data).toEqual({ top: 100 });
  });
});

describe('dates', () => {
  it('returns Date values as ISO strings, from explicit and default resolvers', async () => {
    const result = await run(`{ item(id: "${VALID_ID}") { createdAt nested { when } } }`);

    expect(result.data).toEqual({
      item: { createdAt: '2026-09-12T08:30:00.000Z', nested: { when: '2026-09-13T10:00:00.000Z' } },
    });
  });
});
