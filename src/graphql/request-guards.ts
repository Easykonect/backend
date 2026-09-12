/**
 * Checks applied to every query and mutation before its resolver runs, and to
 * what resolvers return:
 * - ID arguments must be MongoDB ObjectIds, so a malformed ID gets a clear
 *   BAD_USER_INPUT error instead of failing in the database
 * - PaginationInput is normalised: page from 1, limit from 1 to 100
 * - Dates returned into String fields become ISO 8601 strings, not the
 *   millisecond numbers graphql-js would otherwise produce
 */

import {
  defaultFieldResolver,
  getNamedType,
  GraphQLError,
  isInputObjectType,
  isListType,
  isNonNullType,
  type GraphQLFieldResolver,
  type GraphQLInputType,
} from 'graphql';

const OBJECT_ID = /^[0-9a-f]{24}$/i;

export const DEFAULT_PAGE_SIZE = 10;
export const MAX_PAGE_SIZE = 100;

// Operations whose page size defaults to something other than DEFAULT_PAGE_SIZE
const OPERATION_PAGE_SIZES: Record<string, number> = {
  services: 20,
  myServices: 20,
  nearbyServices: 20,
  myNotifications: 20,
  myConversations: 20,
  myBlockedUsers: 20,
  myReports: 20,
  reports: 20,
  reportedConversationMessages: 20,
  categories: 50,
  conversationMessages: 50,
};

export const defaultPageSize = (operation: string): number =>
  OPERATION_PAGE_SIZES[operation] ?? DEFAULT_PAGE_SIZE;

type Resolver = GraphQLFieldResolver<unknown, unknown>;

const toIsoDate = (value: unknown): unknown => (value instanceof Date ? value.toISOString() : value);

const convertDates = (result: unknown): unknown =>
  result instanceof Promise ? result.then(toIsoDate) : toIsoDate(result);

/**
 * graphql-js's default field resolver, returning Date values as ISO strings
 */
export const dateAwareFieldResolver: Resolver = (source, args, context, info) =>
  convertDates(defaultFieldResolver(source, args, context, info));

const invalidId = (path: string) =>
  new GraphQLError(`${path} is not a valid ID`, {
    extensions: { code: 'BAD_USER_INPUT', argument: path },
  });

/**
 * Throw if any ID-typed value in an argument, including inside input objects
 * and lists, isn't an ObjectId
 */
const checkIds = (type: GraphQLInputType, value: unknown, path: string): void => {
  if (value === null || value === undefined) return;

  const inner = isNonNullType(type) ? type.ofType : type;

  if (isListType(inner)) {
    if (Array.isArray(value)) {
      value.forEach((item, index) => checkIds(inner.ofType, item, `${path}[${index}]`));
    }
    return;
  }

  if (isInputObjectType(inner)) {
    if (typeof value !== 'object') return;
    for (const field of Object.values(inner.getFields())) {
      checkIds(field.type, (value as Record<string, unknown>)[field.name], `${path}.${field.name}`);
    }
    return;
  }

  if (inner.name === 'ID' && (typeof value !== 'string' || !OBJECT_ID.test(value))) {
    throw invalidId(path);
  }
};

const toInteger = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : undefined;

/**
 * Page and limit as services expect them. A missing, zero or negative limit
 * uses the operation's default page size.
 */
export const normalizePagination = (
  pagination: unknown,
  defaultLimit: number = DEFAULT_PAGE_SIZE
): { page: number; limit: number } | undefined => {
  if (!pagination || typeof pagination !== 'object') return undefined;

  const { page, limit } = pagination as { page?: unknown; limit?: unknown };
  const pageNumber = toInteger(page);
  const pageSize = toInteger(limit);

  return {
    page: pageNumber && pageNumber > 0 ? pageNumber : 1,
    limit: pageSize && pageSize > 0 ? Math.min(pageSize, MAX_PAGE_SIZE) : defaultLimit,
  };
};

/**
 * Normalise every PaginationInput in an argument value, including one inside an
 * input object (such as `providers(input: { pagination })`)
 */
const normalizeArgument = (type: GraphQLInputType, value: unknown, defaultLimit: number): unknown => {
  const inner = isNonNullType(type) ? type.ofType : type;

  if (isInputObjectType(inner) && inner.name === 'PaginationInput') {
    return normalizePagination(value, defaultLimit);
  }
  if (value === null || value === undefined) return value;

  if (isListType(inner)) {
    return Array.isArray(value)
      ? value.map((item) => normalizeArgument(inner.ofType, item, defaultLimit))
      : value;
  }

  if (isInputObjectType(inner) && typeof value === 'object') {
    const normalized: Record<string, unknown> = { ...(value as Record<string, unknown>) };
    for (const field of Object.values(inner.getFields())) {
      if (field.name in normalized) {
        normalized[field.name] = normalizeArgument(field.type, normalized[field.name], defaultLimit);
      }
    }
    return normalized;
  }

  return value;
};

const guardRootResolver =
  (resolve: Resolver): Resolver =>
  (source, args, context, info) => {
    const field = info.parentType.getFields()[info.fieldName];
    const checkedArgs: Record<string, unknown> = { ...args };
    const pageSize = defaultPageSize(info.fieldName);

    for (const argument of field?.args ?? []) {
      checkIds(argument.type, checkedArgs[argument.name], argument.name);

      if (argument.name === 'limit' && getNamedType(argument.type).name === 'Int') {
        if (typeof checkedArgs.limit === 'number') {
          checkedArgs.limit = normalizePagination({ limit: checkedArgs.limit }, pageSize)?.limit;
        }
      } else if (argument.name in checkedArgs) {
        checkedArgs[argument.name] = normalizeArgument(argument.type, checkedArgs[argument.name], pageSize);
      }
    }

    return convertDates(resolve(source, checkedArgs, context, info));
  };

const convertingResolver =
  (resolve: Resolver): Resolver =>
  (source, args, context, info) =>
    convertDates(resolve(source, args, context, info));

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;

/**
 * Wrap a resolver map: root resolvers get the argument checks, and every
 * resolver's Date results become ISO strings
 */
export const withRequestGuards = <T extends Record<string, unknown>>(resolvers: T): T => {
  const guarded: Record<string, unknown> = {};

  for (const [typeName, fields] of Object.entries(resolvers)) {
    if (!isPlainObject(fields)) {
      guarded[typeName] = fields;
      continue;
    }

    const isRoot = typeName === 'Query' || typeName === 'Mutation';
    const wrapped: Record<string, unknown> = {};

    for (const [fieldName, resolver] of Object.entries(fields)) {
      if (typeof resolver !== 'function' || fieldName.startsWith('__')) {
        wrapped[fieldName] = resolver;
        continue;
      }
      wrapped[fieldName] = isRoot
        ? guardRootResolver(resolver as Resolver)
        : convertingResolver(resolver as Resolver);
    }

    guarded[typeName] = wrapped;
  }

  return guarded as T;
};
