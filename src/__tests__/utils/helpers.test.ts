/**
 * Helper Functions Tests
 * Tests all utility helper functions
 */

import {
  calculateCommission,
  calculateProviderPayout,
  formatCurrency,
  generateSlug,
  paginate,
  sleep,
  omit,
} from '@/utils/helpers';

describe('Helper Functions', () => {
  // ==================
  // Commission
  // ==================
  describe('calculateCommission', () => {
    it('should calculate 10% commission on a given amount', () => {
      const commission = calculateCommission(1000);
      expect(commission).toBeCloseTo(100, 2); // 10% of 1000
    });

    it('should return 0 commission for 0 amount', () => {
      expect(calculateCommission(0)).toBe(0);
    });

    it('should handle decimal amounts', () => {
      const commission = calculateCommission(1500.50);
      expect(commission).toBeCloseTo(150.05, 2);
    });
  });

  describe('calculateProviderPayout', () => {
    it('should return amount minus commission', () => {
      const payout = calculateProviderPayout(1000);
      const commission = calculateCommission(1000);
      expect(payout).toBeCloseTo(1000 - commission, 2);
    });

    it('should return 0 for 0 amount', () => {
      expect(calculateProviderPayout(0)).toBe(0);
    });

    it('payout + commission should equal original amount', () => {
      const amount = 2500;
      const payout = calculateProviderPayout(amount);
      const commission = calculateCommission(amount);
      expect(payout + commission).toBeCloseTo(amount, 5);
    });
  });

  // ==================
  // Currency Formatter
  // ==================
  describe('formatCurrency', () => {
    it('should format NGN currency correctly', () => {
      const formatted = formatCurrency(1000, 'NGN');
      expect(formatted).toContain('1,000');
    });

    it('should handle zero amount', () => {
      const formatted = formatCurrency(0, 'NGN');
      expect(formatted).toContain('0');
    });

    it('should handle large amounts', () => {
      const formatted = formatCurrency(1000000, 'NGN');
      expect(formatted).toContain('1,000,000');
    });
  });

  // ==================
  // Slug Generator
  // ==================
  describe('generateSlug', () => {
    it('should convert a string to a slug', () => {
      expect(generateSlug('Hello World')).toBe('hello-world');
    });

    it('should remove special characters', () => {
      expect(generateSlug('Plumbing & Repairs!')).toBe('plumbing-repairs');
    });

    it('should handle multiple spaces', () => {
      expect(generateSlug('Home   Cleaning')).toBe('home-cleaning');
    });

    it('should trim leading and trailing hyphens', () => {
      expect(generateSlug('  trim me  ')).toBe('trim-me');
    });

    it('should handle already-lowercase input', () => {
      expect(generateSlug('already lower')).toBe('already-lower');
    });
  });

  // ==================
  // Paginate
  // ==================
  describe('paginate', () => {
    const items = Array.from({ length: 25 }, (_, i) => i + 1); // [1..25]

    it('should return the first page correctly', () => {
      const result = paginate(items, 1, 10);
      expect(result.items).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      expect(result.total).toBe(25);
      expect(result.page).toBe(1);
      expect(result.totalPages).toBe(3);
    });

    it('should return the second page correctly', () => {
      const result = paginate(items, 2, 10);
      expect(result.items).toEqual([11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
    });

    it('should return a partial last page', () => {
      const result = paginate(items, 3, 10);
      expect(result.items).toEqual([21, 22, 23, 24, 25]);
      expect(result.items).toHaveLength(5);
    });

    it('should return empty items for an out-of-range page', () => {
      const result = paginate(items, 99, 10);
      expect(result.items).toEqual([]);
    });

    it('should handle empty arrays', () => {
      const result = paginate([], 1, 10);
      expect(result.items).toEqual([]);
      expect(result.total).toBe(0);
      expect(result.totalPages).toBe(0);
    });
  });

  // ==================
  // Sleep
  // ==================
  describe('sleep', () => {
    it('should resolve after the given delay', async () => {
      const start = Date.now();
      await sleep(50);
      const elapsed = Date.now() - start;
      expect(elapsed).toBeGreaterThanOrEqual(40);
      expect(elapsed).toBeLessThan(150); // Allow for timing jitter
    });
  });

  // ==================
  // Omit
  // ==================
  describe('omit', () => {
    it('should omit specified keys from an object', () => {
      const obj = { id: '1', password: 'secret', email: 'test@test.com' };
      const result = omit(obj, ['password']);
      expect(result).toEqual({ id: '1', email: 'test@test.com' });
      expect(result).not.toHaveProperty('password');
    });

    it('should omit multiple keys', () => {
      const obj = { a: 1, b: 2, c: 3, d: 4 };
      const result = omit(obj, ['b', 'd']);
      expect(result).toEqual({ a: 1, c: 3 });
    });

    it('should return original object if no keys to omit', () => {
      const obj = { a: 1, b: 2 };
      const result = omit(obj, []);
      expect(result).toEqual(obj);
    });
  });
});
