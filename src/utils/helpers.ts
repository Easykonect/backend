/**
 * Helper Functions
 * General utility functions used across the application
 */

import { config } from '@/config';

/**
 * Calculate platform commission
 */
export const calculateCommission = (amount: number): number => {
  return amount * config.platform.commissionRate;
};

/**
 * Calculate provider payout (after commission)
 */
export const calculateProviderPayout = (amount: number): number => {
  return amount - calculateCommission(amount);
};

/**
 * Format currency
 */
export const formatCurrency = (
  amount: number,
  currency: string = config.platform.currency

): string => {
  return new Intl.NumberFormat('en-NG', {
    style: 'currency',
    currency,
    
  }).format(amount);
};

/**
 * Generate slug from string
 */
export const generateSlug = (text: string): string => {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
};

/**
 * Paginate array
 */
export const paginate = <T>(
  items: T[],
  page: number = 1,
  limit: number = config.pagination.defaultLimit
): { items: T[]; total: number; page: number; totalPages: number } => {
  const total = items.length;
  const totalPages = Math.ceil(total / limit);
  const startIndex = (page - 1) * limit;
  const paginatedItems = items.slice(startIndex, startIndex + limit);

  return {
    items: paginatedItems,
    total,
    page,
    totalPages,
  };
};

/**
 * Sleep/delay function
 */
export const sleep = (ms: number): Promise<void> => {
  return new Promise((resolve) => setTimeout(resolve, ms));
};

/**
 * Omit keys from object
 */
export const omit = <T extends object, K extends keyof T>(
  obj: T,
  keys: K[]
): Omit<T, K> => {
  const result = { ...obj };
  keys.forEach((key) => delete result[key]);
  return result;
};

/**
 * Pick keys from object
 */
export const pick = <T extends object, K extends keyof T>(
  obj: T,
  keys: K[]
): Pick<T, K> => {
  const result = {} as Pick<T, K>;
  keys.forEach((key) => {
    if (key in obj) {
      result[key] = obj[key];
    }
  });
  return result;
};

/**
 * Check if value is empty (null, undefined, empty string, empty array, empty object)
 */
export const isEmpty = (value: unknown): boolean => {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value).length === 0;
  return false;
};
