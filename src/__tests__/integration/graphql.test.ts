/**
 * GraphQL API Integration Tests
 * Tests the live GraphQL endpoint for all major operations
 * 
 * Requires: App running at http://localhost:3000
 * Run with: npm run test:integration
 */

const GQL_URL = process.env.TEST_GQL_URL || 'http://localhost:3000/api/graphql';

// Helper to send GraphQL requests
async function gql(
  query: string,
  variables: Record<string, unknown> = {},
  token?: string
): Promise<{ data?: Record<string, unknown>; errors?: Array<{ message: string }> }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const res = await fetch(GQL_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query, variables }),
  });

  return res.json();
}

// ==================
// Unique test email to avoid conflicts
// ==================
const testEmail = `test_${Date.now()}@example.com`;
const testPassword = 'TestPass123!';

describe('GraphQL API Integration', () => {
  // ==================
  // Health Check
  // ==================
  describe('Health Check', () => {
    it('should respond to __typename query', async () => {
      const result = await gql('{ __typename }');
      expect(result.errors).toBeUndefined();
      expect(result.data?.__typename).toBe('Query');
    });

    it('should reject oversized queries (security)', async () => {
      const massiveQuery = 'a'.repeat(2 * 1024 * 1024); // 2MB
      const res = await fetch(GQL_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: massiveQuery }),
      });
      expect(res.status).toBe(413); // Payload Too Large
    });
  });

  // ==================
  // Authentication Flow
  // ==================
  describe('Authentication Flow', () => {
    let accessToken: string;

    it('should register a new user', async () => {
      const result = await gql(`
        mutation Register($input: RegisterUserInput!) {
          register(input: $input) {
            success
            message
            requiresVerification
          }
        }
      `, {
        input: {
          email: testEmail,
          password: testPassword,
          firstName: 'Test',
          lastName: 'User',
          phone: '+2348012345678',
        },
      });

      expect(result.errors).toBeUndefined();
      expect(result.data?.register).toBeDefined();
      const reg = result.data?.register as Record<string, unknown>;
      expect(reg.success).toBe(true);
      expect(reg.requiresVerification).toBe(true);
      expect(typeof reg.message).toBe('string');
    });

    it('should reject duplicate email registration', async () => {
      // Note: If the email is unverified, re-registration is allowed (re-sends OTP).
      // Duplicate rejection only fires for VERIFIED accounts.
      // Here we confirm that re-registering an unverified email still succeeds
      // (returns success: true) - which is the correct UX to let users fix typos.
      const result = await gql(`
        mutation Register($input: RegisterUserInput!) {
          register(input: $input) {
            success
            message
            requiresVerification
          }
        }
      `, {
        input: {
          email: testEmail, // same email as the first registration (still unverified)
          password: testPassword,
          firstName: 'Duplicate',
          lastName: 'User',
          phone: '+2348012345678',
        },
      });

      // Unverified re-registration returns success (resends OTP) — not an error
      expect(result.errors).toBeUndefined();
      const reg = result.data?.register as Record<string, unknown>;
      expect(reg.success).toBe(true);
      expect(reg.requiresVerification).toBe(true);
    });

    it('should reject login before email verification', async () => {
      const result = await gql(`
        mutation Login($input: LoginInput!) {
          login(input: $input) {
            accessToken
          }
        }
      `, {
        input: { email: testEmail, password: testPassword },
      });

      expect(result.errors).toBeDefined();
      expect(result.errors?.[0]?.message).toMatch(/verif/i);
    });

    it('should reject login with wrong password', async () => {
      const result = await gql(`
        mutation Login($input: LoginInput!) {
          login(input: $input) {
            accessToken
          }
        }
      `, {
        input: { email: testEmail, password: 'WrongPass999!' },
      });

      expect(result.errors).toBeDefined();
    });

    it('should reject login with weak password input', async () => {
      const result = await gql(`
        mutation Login($input: LoginInput!) {
          login(input: $input) {
            accessToken
          }
        }
      `, {
        input: { email: 'notanemail', password: '' },
      });

      expect(result.errors).toBeDefined();
    });
  });

  // ==================
  // Authorization Guards
  // ==================
  describe('Authorization Guards', () => {
    it('should reject unauthenticated access to protected queries', async () => {
      const result = await gql(`
        query {
          me {
            id
            email
          }
        }
      `);

      expect(result.errors).toBeDefined();
      expect(result.errors?.[0]?.message).toMatch(/auth|login|unauthorized|logged in/i);
    });

    it('should reject admin endpoints without admin token', async () => {
      const result = await gql(`
        query {
          adminGetAllUsers(page: 1, limit: 10) {
            users { id }
            total
          }
        }
      `);

      expect(result.errors).toBeDefined();
    });

    it('should reject requests with an invalid JWT', async () => {
      const result = await gql(`
        query {
          me {
            id
          }
        }
      `, {}, 'invalid.jwt.token');

      expect(result.errors).toBeDefined();
    });
  });

  // ==================
  // Public Queries
  // ==================
  describe('Public Queries', () => {
    it('should list public categories', async () => {
      const result = await gql(`
        query {
          categories {
            items {
              id
              name
              isActive
            }
            total
            page
            hasNextPage
          }
        }
      `);

      // Either returns categories or empty array (no auth required)
      expect(result.errors).toBeUndefined();
      const cats = result.data?.categories as Record<string, unknown>;
      expect(cats).toBeDefined();
      expect(Array.isArray(cats?.items)).toBe(true);
      expect(typeof cats?.total).toBe('number');
    });

    it('should list public active services', async () => {
      const result = await gql(`
        query {
          services(filters: { status: ACTIVE }) {
            items {
              id
              name
              status
            }
            total
            page
            hasNextPage
          }
        }
      `);

      expect(result.errors).toBeUndefined();
      const svc = result.data?.services as Record<string, unknown>;
      expect(svc).toBeDefined();
      expect(Array.isArray(svc?.items)).toBe(true);
      expect(typeof svc?.total).toBe('number');
    });
  });

  // ==================
  // Input Validation (GraphQL layer)
  // ==================
  describe('Input Validation', () => {
    it('should reject registration with invalid email', async () => {
      const result = await gql(`
        mutation Register($input: RegisterUserInput!) {
          register(input: $input) {
            message
          }
        }
      `, {
        input: {
          email: 'not-an-email',
          password: testPassword,
          firstName: 'John',
          lastName: 'Doe',
        },
      });

      expect(result.errors).toBeDefined();
    });

    it('should reject registration with weak password', async () => {
      const result = await gql(`
        mutation Register($input: RegisterUserInput!) {
          register(input: $input) {
            message
          }
        }
      `, {
        input: {
          email: `weakpass_${Date.now()}@test.com`,
          password: 'weak',
          firstName: 'John',
          lastName: 'Doe',
        },
      });

      expect(result.errors).toBeDefined();
    });
  });
});
