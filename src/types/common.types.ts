/**
 * Common Types
 * Shared types used across the application
 */

/**
 * Pagination input
 */
export interface PaginationInput {
  page?: number;
  limit?: number;
  cursor?: string;
}

/**
 * Paginated response
 */
export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
}

/**
 * Cursor-based pagination response
 */
export interface CursorPaginatedResponse<T> {
  items: T[];
  cursor: string | null;
  hasMore: boolean;
}

/**
 * Sort order
 */
export type SortOrder = 'asc' | 'desc';

/**
 * Base filter
 */
export interface BaseFilter {
  search?: string;
  sortBy?: string;
  sortOrder?: SortOrder;
}

/**
 * Date range filter
 */
export interface DateRangeFilter {
  startDate?: Date;
  endDate?: Date;
}

/**
 * API Response wrapper
 */
export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
  };
}

/**
 * ID params
 */
export interface IdParams {
  id: string;
}
