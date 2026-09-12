/**
 * Rate Limiting Middleware for the GraphQL endpoint
 *
 * - Client IP: the X-Forwarded-For entry our trusted proxies added (TRUSTED_PROXY_COUNT)
 * - Identity: the user in a verified access token; anyone else is anonymous, keyed by IP
 * - General limits per minute: reads and writes per signed-in user, any request per IP otherwise
 * - Strict limits by root field (login, codes, uploads, ...) on top, counted per occurrence
 * - Complexity: depth, root fields and aliases of the parsed document, through fragments
 */

import { createHash } from 'crypto';
import {
  Kind,
  OperationTypeNode,
  parse,
  valueFromASTUntyped,
  type DocumentNode,
  type FieldNode,
  type FragmentDefinitionNode,
  type OperationDefinitionNode,
  type SelectionSetNode,
} from 'graphql';
import { NextResponse } from 'next/server';
import RedisClient, { rateLimit } from '@/lib/redis';
import { verifyAccessToken } from '@/lib/auth';
import { config } from '@/config';

const perMinute = (limit: number) => ({ limit, windowSeconds: 60 });

export const RateLimitConfig = {
  // General limits: every request counts against one of these
  READ: perMinute(config.security.rateLimitReadsPerMinute), // queries per signed-in user
  WRITE: perMinute(config.security.rateLimitWritesPerMinute), // mutations per signed-in user
  ANONYMOUS: perMinute(config.security.rateLimitAnonymousPerMinute), // any request per IP
  API: perMinute(config.security.rateLimitReadsPerMinute), // earlier name of the general limit

  // Strict limits for sensitive mutations, on top of the general limit. Sign-in, sign-up,
  // password and code limits count per account: the email the request names, or the
  // signed-in user.
  LOGIN: { limit: 10, windowSeconds: 15 * 60 },
  AUTH: { limit: 5, windowSeconds: 60 }, // registration
  PASSWORD_RESET: { limit: 3, windowSeconds: 60 * 60 }, // asking for a reset code
  PASSWORD_RESET_CODE: { limit: 10, windowSeconds: 60 * 60 }, // entering a reset code
  PASSWORD_CHANGE: { limit: 5, windowSeconds: 15 * 60 }, // changing the password while signed in
  OTP: { limit: 5, windowSeconds: 5 * 60 }, // email verification and email change codes
  // The same operations per client IP, set higher because many mobile users share one
  // carrier IP
  LOGIN_PER_IP: { limit: 100, windowSeconds: 15 * 60 },
  AUTH_PER_IP: { limit: 30, windowSeconds: 60 },
  PASSWORD_RESET_PER_IP: { limit: 30, windowSeconds: 60 * 60 },
  PASSWORD_RESET_CODE_PER_IP: { limit: 50, windowSeconds: 60 * 60 },
  PASSWORD_CHANGE_PER_IP: { limit: 50, windowSeconds: 15 * 60 },
  OTP_PER_IP: { limit: 50, windowSeconds: 5 * 60 },
  // Token refresh needs a valid signed refresh token, so a generous ceiling is enough
  REFRESH: { limit: 120, windowSeconds: 60 },
  UPLOAD: { limit: 20, windowSeconds: 60 },
  MESSAGE: { limit: 60, windowSeconds: 60 },
  REPORT: { limit: 10, windowSeconds: 60 * 60 },
  BLOCK: { limit: 20, windowSeconds: 60 * 60 },
};

export type RateLimitType = keyof typeof RateLimitConfig;

type StrictLimitType =
  | 'LOGIN'
  | 'AUTH'
  | 'REFRESH'
  | 'PASSWORD_RESET'
  | 'PASSWORD_RESET_CODE'
  | 'PASSWORD_CHANGE'
  | 'OTP'
  | 'UPLOAD'
  | 'MESSAGE'
  | 'REPORT'
  | 'BLOCK';

/**
 * Root fields with a strict limit, by exact name, so renaming or aliasing the
 * operation doesn't escape them
 */
const STRICT_LIMIT_FIELDS = new Map<string, StrictLimitType>([
  ['login', 'LOGIN'],
  ['adminLogin', 'LOGIN'],
  ['register', 'AUTH'],
  ['refreshToken', 'REFRESH'],
  ['adminRefreshToken', 'REFRESH'],
  ['forgotPassword', 'PASSWORD_RESET'],
  ['resetPassword', 'PASSWORD_RESET_CODE'],
  ['adminForgotPassword', 'PASSWORD_RESET'],
  ['adminResetPassword', 'PASSWORD_RESET_CODE'],
  ['changePassword', 'PASSWORD_CHANGE'],
  ['adminChangePassword', 'PASSWORD_CHANGE'],
  // Deleting an account can take the password too
  ['deleteAccount', 'PASSWORD_CHANGE'],
  ['verifyEmail', 'OTP'],
  ['resendVerificationOtp', 'OTP'],
  ['requestEmailChange', 'OTP'],
  ['confirmEmailChange', 'OTP'],
  ['adminRequestEmailChange', 'OTP'],
  ['adminConfirmEmailChange', 'OTP'],
  ['uploadProfilePhoto', 'UPLOAD'],
  ['uploadProviderImages', 'UPLOAD'],
  ['uploadServiceImages', 'UPLOAD'],
  ['uploadProviderDocuments', 'UPLOAD'],
  ['addProviderDocuments', 'UPLOAD'],
  ['sendMessage', 'MESSAGE'],
  ['startConversation', 'MESSAGE'],
  ['createReport', 'REPORT'],
  ['blockUser', 'BLOCK'],
]);

/** Root fields that upload files as base64, whose requests may exceed the normal body size */
export const UPLOAD_FIELDS = new Set(
  [...STRICT_LIMIT_FIELDS].filter(([, type]) => type === 'UPLOAD').map(([name]) => name)
);

/**
 * Limits guarding passwords and one-time codes count per account (the email the request
 * names, and the signed-in user) and, with a higher ceiling, per client IP. Rotating IPs
 * against one account doesn't get around them, and people sharing a carrier IP don't lock
 * each other out.
 */
const PER_IP_LIMITS: Partial<Record<StrictLimitType, RateLimitType>> = {
  LOGIN: 'LOGIN_PER_IP',
  AUTH: 'AUTH_PER_IP',
  PASSWORD_RESET: 'PASSWORD_RESET_PER_IP',
  PASSWORD_RESET_CODE: 'PASSWORD_RESET_CODE_PER_IP',
  PASSWORD_CHANGE: 'PASSWORD_CHANGE_PER_IP',
  OTP: 'OTP_PER_IP',
};

export const MAX_QUERY_DEPTH = config.security.graphqlMaxDepth;
export const MAX_ROOT_FIELDS = config.security.graphqlMaxRootFields;
export const MAX_ALIASES = config.security.graphqlMaxAliases;

/**
 * Client IP. When CLIENT_IP_HEADER names a header the edge sets and clients can't override
 * (on Render, Cloudflare's True-Client-IP), that header is used. Otherwise each trusted
 * proxy appends the address it received the request from to X-Forwarded-For, so the
 * client is the entry the outermost trusted proxy added: the N-th from the right.
 * Entries further left were sent by the client and are ignored.
 */
export const getClientIp = (request: Request): string => {
  const edgeHeader = config.security.clientIpHeader;
  if (edgeHeader) {
    const edgeIp = request.headers.get(edgeHeader)?.split(',')[0].trim();
    if (edgeIp) return edgeIp;
  }

  const trustedProxies = config.security.trustedProxyCount;
  const entries = (request.headers.get('x-forwarded-for') ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (trustedProxies < 1 || entries.length === 0) return 'unknown';
  return entries[Math.max(entries.length - trustedProxies, 0)];
};

/**
 * User ID from a verified access token, or null (anonymous) for a missing, forged, expired
 * or refresh token. The account itself is checked later, in the GraphQL context.
 */
export const getRateLimitUserId = (request: Request): string | null => {
  const authorization = request.headers.get('authorization');
  if (!authorization?.startsWith('Bearer ')) return null;

  try {
    return verifyAccessToken(authorization.slice('Bearer '.length)).userId || null;
  } catch {
    return null;
  }
};

/** A GraphQL HTTP request as sent: nothing in it is trusted */
export interface GraphQLRequestParams {
  query?: unknown;
  operationName?: unknown;
  variables?: unknown;
}

export interface RootFieldUse {
  name: string;
  /** For fields with a strict limit: the lowercased `email` argument, when the request passes one */
  email: string | null;
}

export interface GraphQLRequestAnalysis {
  /** Mutations count against the write limit; anything else (even an unparseable request) is a read */
  isMutation: boolean;
  /** Every root field occurrence in the operation that will run, through fragments */
  rootFields: RootFieldUse[];
  /** Set when the request must be rejected as too complex */
  complexityError: string | null;
}

interface SelectionCost {
  /** Deepest field nesting below the selection set */
  depth: number;
  /** Aliases below it, counting a fragment's aliases each time it is spread */
  aliases: number;
  /** Fields at its own level, through inline fragments and spreads; stops just past MAX_ROOT_FIELDS */
  fields: FieldNode[];
}

const NO_COST: SelectionCost = { depth: 0, aliases: 0, fields: [] };

/**
 * Measure selection sets, following named fragments. Each fragment is measured once, so
 * spreading fragments many times can't multiply the work. Unknown and cyclic spreads count
 * as empty: Apollo's validation rejects them.
 */
const createSelectionMeasurer = (fragments: Map<string, FragmentDefinitionNode>) => {
  const measured = new Map<string, SelectionCost>();
  const inProgress = new Set<string>();

  function measureFragment(name: string): SelectionCost {
    const known = measured.get(name);
    if (known) return known;

    const fragment = fragments.get(name);
    if (!fragment || inProgress.has(name)) return NO_COST;

    inProgress.add(name);
    const cost = measure(fragment.selectionSet);
    inProgress.delete(name);
    measured.set(name, cost);
    return cost;
  }

  function measure(selectionSet: SelectionSetNode): SelectionCost {
    const cost: SelectionCost = { depth: 0, aliases: 0, fields: [] };

    for (const selection of selectionSet.selections) {
      if (selection.kind === Kind.FIELD) {
        if (selection.alias) cost.aliases += 1;
        if (selection.selectionSet) {
          const child = measure(selection.selectionSet);
          cost.depth = Math.max(cost.depth, child.depth + 1);
          cost.aliases += child.aliases;
        }
        if (cost.fields.length <= MAX_ROOT_FIELDS) cost.fields.push(selection);
        continue;
      }

      // Fragments add fields at this same level
      const inner =
        selection.kind === Kind.INLINE_FRAGMENT
          ? measure(selection.selectionSet)
          : measureFragment(selection.name.value);
      cost.depth = Math.max(cost.depth, inner.depth);
      cost.aliases += inner.aliases;
      for (const field of inner.fields) {
        if (cost.fields.length > MAX_ROOT_FIELDS) break;
        cost.fields.push(field);
      }
    }

    return cost;
  }

  return measure;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The `email` argument, or the `email` field of an input object argument, lowercased */
const findEmail = (field: FieldNode, variables: Record<string, unknown>): string | null => {
  for (const argument of field.arguments ?? []) {
    const value = valueFromASTUntyped(argument.value, variables);
    let email: unknown;
    if (argument.name.value === 'email') {
      email = value;
    } else if (isRecord(value)) {
      email = value.email;
    }
    if (typeof email === 'string' && email.trim()) return email.trim().toLowerCase();
  }
  return null;
};

/**
 * Work out what a GraphQL request will run: its root fields (for the strict limits) and its
 * depth, root field and alias counts (for the complexity limits). A request that doesn't
 * parse only gets the general limit; Apollo returns the error.
 */
export const analyzeGraphQLRequest = ({
  query,
  operationName,
  variables,
}: GraphQLRequestParams): GraphQLRequestAnalysis => {
  const unparsed: GraphQLRequestAnalysis = { isMutation: false, rootFields: [], complexityError: null };
  if (typeof query !== 'string') return unparsed;

  let document: DocumentNode;
  try {
    document = parse(query);
  } catch {
    return unparsed;
  }

  const operations: OperationDefinitionNode[] = [];
  const fragments = new Map<string, FragmentDefinitionNode>();
  for (const definition of document.definitions) {
    if (definition.kind === Kind.OPERATION_DEFINITION) {
      operations.push(definition);
    } else if (definition.kind === Kind.FRAGMENT_DEFINITION) {
      fragments.set(definition.name.value, definition);
    }
  }

  // graphql-js runs the operation named by operationName, or the only one. When that doesn't
  // pick exactly one, nothing runs, and looking at all of them errs on the safe side.
  const named =
    typeof operationName === 'string'
      ? operations.filter((operation) => operation.name?.value === operationName)
      : operations;
  const selected = named.length === 1 ? named : operations;

  const measure = createSelectionMeasurer(fragments);
  let depth = 0;
  let aliases = 0;
  const fields: FieldNode[] = [];
  try {
    for (const operation of selected) {
      const cost = measure(operation.selectionSet);
      depth = Math.max(depth, cost.depth + 1);
      aliases += cost.aliases;
      fields.push(...cost.fields);
    }
  } catch {
    // e.g. a chain of fragments long enough to overflow the stack
    return { ...unparsed, complexityError: 'Query is too complex' };
  }

  let complexityError: string | null = null;
  if (depth > MAX_QUERY_DEPTH) {
    complexityError = `Query depth ${depth} exceeds maximum allowed depth of ${MAX_QUERY_DEPTH}`;
  } else if (fields.length > MAX_ROOT_FIELDS) {
    complexityError = `A request may select at most ${MAX_ROOT_FIELDS} root fields`;
  } else if (aliases > MAX_ALIASES) {
    complexityError = `A request may use at most ${MAX_ALIASES} aliases`;
  }
  if (complexityError) return { ...unparsed, complexityError };

  // Variable values as graphql-js sees them: the ones sent, else the declared defaults
  const variableValues: Record<string, unknown> = isRecord(variables) ? { ...variables } : {};
  for (const operation of selected) {
    for (const definition of operation.variableDefinitions ?? []) {
      const name = definition.variable.name.value;
      if (definition.defaultValue && !Object.prototype.hasOwnProperty.call(variableValues, name)) {
        variableValues[name] = valueFromASTUntyped(definition.defaultValue);
      }
    }
  }

  return {
    isMutation: selected.some((operation) => operation.operation === OperationTypeNode.MUTATION),
    rootFields: fields.map((field) => ({
      name: field.name.value,
      email: STRICT_LIMIT_FIELDS.has(field.name.value) ? findEmail(field, variableValues) : null,
    })),
    complexityError: null,
  };
};

/** Outcome of counting a request against every limit that applies to it */
export interface RateLimitDecision {
  limited: boolean;
  /** The bucket closest to its limit or, when limited, the one that frees up last */
  limit: number;
  remaining: number;
  resetIn: number;
}

interface Charge {
  type: RateLimitType;
  identity: string;
  cost: number;
}

type ChargeResult = Awaited<ReturnType<typeof rateLimit.check>> & { limit: number };

const charge = async ({ type, identity, cost }: Charge): Promise<ChargeResult> => {
  const { limit, windowSeconds } = RateLimitConfig[type];
  const result = await rateLimit.check(`gql:${type.toLowerCase()}:${identity}`, limit, windowSeconds, cost);
  return { ...result, limit };
};

const decide = (results: ChargeResult[]): RateLimitDecision => {
  const denied = results.filter((result) => !result.allowed);
  const reported =
    denied.length > 0
      ? denied.reduce((a, b) => (b.resetIn > a.resetIn ? b : a))
      : results.reduce((a, b) =>
          b.remaining < a.remaining || (b.remaining === a.remaining && b.limit < a.limit) ? b : a
        );

  return {
    limited: denied.length > 0,
    limit: reported.limit,
    remaining: reported.remaining,
    resetIn: reported.resetIn,
  };
};

const hashEmail = (email: string): string => createHash('sha256').update(email).digest('hex');

/**
 * Count a GraphQL request against its general limit and, when that allows it, against the
 * strict limit of every root field it selects (once per occurrence, so aliases don't help)
 */
export const checkGraphQLRateLimit = async (
  request: Request,
  analysis: GraphQLRequestAnalysis
): Promise<RateLimitDecision> => {
  const ip = `ip:${getClientIp(request)}`;
  const userId = getRateLimitUserId(request);
  const user = userId ? `user:${userId}` : null;

  let generalType: RateLimitType = 'ANONYMOUS';
  if (user) generalType = analysis.isMutation ? 'WRITE' : 'READ';
  const general = await charge({ type: generalType, identity: user ?? ip, cost: 1 });
  if (!general.allowed) return decide([general]);

  const charges = new Map<string, Charge>();
  const addCharge = (type: RateLimitType, identity: string) => {
    const key = `${type}:${identity}`;
    const existing = charges.get(key);
    if (existing) {
      existing.cost += 1;
    } else {
      charges.set(key, { type, identity, cost: 1 });
    }
  };

  for (const field of analysis.rootFields) {
    const type = STRICT_LIMIT_FIELDS.get(field.name);
    if (!type) continue;

    const perIpType = PER_IP_LIMITS[type];
    if (!perIpType) {
      addCharge(type, user ?? ip);
      continue;
    }
    addCharge(perIpType, ip);
    if (field.email) addCharge(type, `email:${hashEmail(field.email)}`);
    if (user) addCharge(type, user);
  }

  const strict = await Promise.all([...charges.values()].map(charge));
  return decide([general, ...strict]);
};

/**
 * Rate limit response headers
 */
export const rateLimitHeaders = (
  remaining: number,
  resetIn: number,
  limit: number
): Record<string, string> => ({
  'X-RateLimit-Limit': limit.toString(),
  'X-RateLimit-Remaining': remaining.toString(),
  'X-RateLimit-Reset': resetIn.toString(),
});

/**
 * Rate limited error response
 */
export const rateLimitedResponse = (resetIn: number): NextResponse => {
  return NextResponse.json(
    {
      errors: [
        {
          message: `Too many requests. Please try again in ${resetIn} seconds.`,
          extensions: { code: 'RATE_LIMITED' },
        },
      ],
    },
    {
      status: 429,
      headers: {
        'Retry-After': resetIn.toString(),
      },
    }
  );
};

const blockedIpKey = (ip: string): string => `blocked_ip:${ip}`;

/**
 * Whether an IP is on the blocklist (false when Redis can't be reached)
 */
export const isBlockedIp = async (ip: string): Promise<boolean> => {
  try {
    const client = await RedisClient.connect();
    return (await client.exists(blockedIpKey(ip))) === 1;
  } catch {
    return false;
  }
};

/**
 * Add IP to blocklist. The block is a Redis key that expires on its own, so it
 * survives restarts and needs no timer.
 */
export const blockIp = async (ip: string, durationSeconds: number = 86400): Promise<void> => {
  try {
    const client = await RedisClient.connect();
    await client.set(blockedIpKey(ip), '1', 'EX', Math.max(1, Math.ceil(durationSeconds)));
  } catch (error) {
    console.error('Failed to block IP:', error);
  }
};
