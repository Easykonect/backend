/**
 * Redis Integration Tests
 * Tests actual Redis connection and operations
 * 
 * Requires: REDIS_URL set in .env
 * Run with: npm run test:integration
 */

import RedisClient from '@/lib/redis';

describe('Redis Integration', () => {
  let client: Awaited<ReturnType<typeof RedisClient.connect>>;

  beforeAll(async () => {
    client = await RedisClient.connect();
  }, 15000);

  afterAll(async () => {
    // Clean up test keys
    const keys = await client.keys('test:*');
    if (keys.length > 0) await client.del(...keys);
    await RedisClient.disconnect();
  });

  // ==================
  // Connection
  // ==================
  describe('Connection', () => {
    it('should connect to Redis successfully', async () => {
      expect(client).toBeDefined();
      expect(client.status).toBe('ready');
    });

    it('should respond to PING', async () => {
      const result = await client.ping();
      expect(result).toBe('PONG');
    });
  });

  // ==================
  // Basic Operations
  // ==================
  describe('Basic Operations', () => {
    it('should SET and GET a string value', async () => {
      await client.set('test:string', 'hello-world');
      const value = await client.get('test:string');
      expect(value).toBe('hello-world');
    });

    it('should SET a value with TTL and expire it', async () => {
      await client.setex('test:ttl', 1, 'temporary');
      const before = await client.get('test:ttl');
      expect(before).toBe('temporary');

      // Wait for expiry
      await new Promise((r) => setTimeout(r, 1500));
      const after = await client.get('test:ttl');
      expect(after).toBeNull();
    }, 10000);

    it('should DEL a key', async () => {
      await client.set('test:delete', 'to-delete');
      await client.del('test:delete');
      const value = await client.get('test:delete');
      expect(value).toBeNull();
    });

    it('should check key EXISTS', async () => {
      await client.set('test:exists', '1');
      const exists = await client.exists('test:exists');
      expect(exists).toBe(1);

      const notExists = await client.exists('test:nonexistent');
      expect(notExists).toBe(0);
    });

    it('should INCR a counter', async () => {
      await client.set('test:counter', '0');
      const val1 = await client.incr('test:counter');
      const val2 = await client.incr('test:counter');
      expect(val1).toBe(1);
      expect(val2).toBe(2);
    });
  });

  // ==================
  // Hash Operations
  // ==================
  describe('Hash Operations', () => {
    it('should HSET and HGET a hash field', async () => {
      await client.hset('test:hash', 'field1', 'value1');
      const value = await client.hget('test:hash', 'field1');
      expect(value).toBe('value1');
    });

    it('should HGETALL return all hash fields', async () => {
      await client.hset('test:hashall', 'a', '1', 'b', '2', 'c', '3');
      const all = await client.hgetall('test:hashall');
      expect(all).toEqual({ a: '1', b: '2', c: '3' });
    });

    it('should HDEL a hash field', async () => {
      await client.hset('test:hdel', 'key', 'value');
      await client.hdel('test:hdel', 'key');
      const value = await client.hget('test:hdel', 'key');
      expect(value).toBeNull();
    });
  });

  // ==================
  // Set Operations
  // ==================
  describe('Set Operations', () => {
    it('should SADD and SMEMBERS a set', async () => {
      await client.sadd('test:set', 'member1', 'member2', 'member3');
      const members = await client.smembers('test:set');
      expect(members).toContain('member1');
      expect(members).toContain('member2');
      expect(members).toHaveLength(3);
    });

    it('should SREM a member from a set', async () => {
      await client.sadd('test:srem', 'a', 'b');
      await client.srem('test:srem', 'a');
      const members = await client.smembers('test:srem');
      expect(members).not.toContain('a');
      expect(members).toContain('b');
    });
  });

  // ==================
  // Token Store (Application Logic)
  // ==================
  describe('Token Store Pattern', () => {
    it('should store and retrieve a token', async () => {
      const userId = 'test-user-123';
      const token = 'hashed-refresh-token';
      const key = `refresh:${userId}`;

      await client.hset(key, token, Date.now().toString());
      await client.expire(key, 3600);

      const stored = await client.hexists(key, token);
      expect(stored).toBe(1);
    });

    it('should invalidate a token by deleting it', async () => {
      const key = 'refresh:invalidate-test';
      await client.hset(key, 'some-token', '123456789');
      await client.del(key);

      const exists = await client.exists(key);
      expect(exists).toBe(0);
    });
  });

  // ==================
  // Rate Limit Pattern
  // ==================
  describe('Rate Limit Pattern', () => {
    it('should track and increment request count', async () => {
      const key = 'test:ratelimit:user1';
      await client.del(key); // Clean start

      const count1 = await client.incr(key);
      const count2 = await client.incr(key);
      const count3 = await client.incr(key);

      expect(count1).toBe(1);
      expect(count2).toBe(2);
      expect(count3).toBe(3);
    });

    it('should set TTL on rate limit key', async () => {
      const key = 'test:ratelimit:ttl-user';
      await client.del(key);
      await client.incr(key);
      await client.expire(key, 60);

      const ttl = await client.ttl(key);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(60);
    });
  });
});
