/**
 * Input Sanitization Utilities
 * Protects against XSS, NoSQL injection, and other injection attacks
 * 
 * CRITICAL: Use these functions for ALL user-generated content
 */

import { GraphQLError } from 'graphql';

// ==================
// XSS Prevention
// ==================

/**
 * HTML entity encoding map
 */
const HTML_ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#x27;',
  '/': '&#x2F;',
  '`': '&#x60;',
  '=': '&#x3D;',
};

/**
 * Escape HTML special characters to prevent XSS
 * Use for all user-generated text content
 */
export const escapeHtml = (input: string): string => {
  if (typeof input !== 'string') return '';
  return input.replace(/[&<>"'`=/]/g, (char) => HTML_ENTITIES[char] || char);
};

/**
 * Strip all HTML tags from input
 * Use for plain text fields like names, comments
 */
export const stripHtmlTags = (input: string): string => {
  if (typeof input !== 'string') return '';
  return input
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '') // Remove script tags first
    .replace(/<[^>]*>/g, '') // Remove all HTML tags
    .replace(/javascript:/gi, '') // Remove javascript: protocol
    .replace(/on\w+\s*=/gi, '') // Remove event handlers
    .trim();
};

/**
 * Sanitize text content - removes HTML and normalizes whitespace
 * Use for: comments, descriptions, messages, names
 */
export const sanitizeText = (input: string, maxLength?: number): string => {
  if (typeof input !== 'string') return '';
  
  let sanitized = stripHtmlTags(input)
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '') // Remove control characters
    .replace(/\s+/g, ' ') // Normalize whitespace
    .trim();
  
  if (maxLength && sanitized.length > maxLength) {
    sanitized = sanitized.substring(0, maxLength);
  }
  
  return sanitized;
};

/**
 * Sanitize rich text - allows some formatting but removes dangerous content
 * Use for: business descriptions, service descriptions
 */
export const sanitizeRichText = (input: string, maxLength?: number): string => {
  if (typeof input !== 'string') return '';
  
  let sanitized = input
    // Remove script tags and their content
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    // Remove style tags and their content
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
    // Remove event handlers
    .replace(/\s*on\w+\s*=\s*["'][^"']*["']/gi, '')
    .replace(/\s*on\w+\s*=\s*[^\s>]*/gi, '')
    // Remove javascript: protocol
    .replace(/javascript:/gi, '')
    // Remove data: URLs (can contain malicious content)
    .replace(/data:/gi, '')
    // Remove iframe, object, embed tags
    .replace(/<(iframe|object|embed|form|input|button)[^>]*>.*?<\/\1>/gi, '')
    .replace(/<(iframe|object|embed|form|input|button)[^>]*\/?>/gi, '')
    // Remove meta and link tags
    .replace(/<(meta|link)[^>]*\/?>/gi, '')
    .trim();
  
  if (maxLength && sanitized.length > maxLength) {
    sanitized = sanitized.substring(0, maxLength);
  }
  
  return sanitized;
};

// ==================
// NoSQL Injection Prevention
// ==================

/**
 * Dangerous MongoDB operators that should never appear in user input
 */
const NOSQL_DANGEROUS_PATTERNS = [
  /\$where/i,
  /\$gt/i,
  /\$gte/i,
  /\$lt/i,
  /\$lte/i,
  /\$ne/i,
  /\$in/i,
  /\$nin/i,
  /\$or/i,
  /\$and/i,
  /\$not/i,
  /\$nor/i,
  /\$exists/i,
  /\$type/i,
  /\$regex/i,
  /\$text/i,
  /\$expr/i,
  /\$jsonSchema/i,
  /\$mod/i,
  /\$all/i,
  /\$elemMatch/i,
  /\$size/i,
  /\$slice/i,
  /\$comment/i,
  /mapReduce/i,
  /\$function/i,
  /\$accumulator/i,
];

/**
 * Check if input contains NoSQL injection attempts
 * Returns true if input is SAFE
 */
export const isNoSqlSafe = (input: unknown): boolean => {
  if (input === null || input === undefined) return true;
  
  const stringified = typeof input === 'string' ? input : JSON.stringify(input);
  
  return !NOSQL_DANGEROUS_PATTERNS.some(pattern => pattern.test(stringified));
};

/**
 * Validate and sanitize search query
 * Prevents ReDoS and NoSQL injection
 */
export const sanitizeSearchQuery = (query: string, maxLength: number = 100): string => {
  if (typeof query !== 'string') return '';
  
  // Check for NoSQL injection
  if (!isNoSqlSafe(query)) {
    throw new GraphQLError('Invalid search query', {
      extensions: { code: 'VALIDATION_ERROR' },
    });
  }
  
  return query
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&') // Escape regex special chars
    .substring(0, maxLength)
    .trim();
};

// ==================
// Input Validation
// ==================

/**
 * Validate MongoDB ObjectId format
 */
export const isValidObjectId = (id: string): boolean => {
  return /^[a-f\d]{24}$/i.test(id);
};

/**
 * Validate and sanitize ID parameter
 * Throws if invalid
 */
export const validateId = (id: string, fieldName: string = 'ID'): string => {
  if (!id || typeof id !== 'string') {
    throw new GraphQLError(`${fieldName} is required`, {
      extensions: { code: 'VALIDATION_ERROR' },
    });
  }
  
  const trimmed = id.trim();
  
  if (!isValidObjectId(trimmed)) {
    throw new GraphQLError(`Invalid ${fieldName} format`, {
      extensions: { code: 'VALIDATION_ERROR' },
    });
  }
  
  return trimmed;
};

/**
 * Validate enum value
 * Prevents injection through invalid enum values
 */
export const validateEnum = <T extends string>(
  value: string,
  allowedValues: readonly T[],
  fieldName: string
): T => {
  if (!allowedValues.includes(value as T)) {
    throw new GraphQLError(`Invalid ${fieldName}. Allowed values: ${allowedValues.join(', ')}`, {
      extensions: { code: 'VALIDATION_ERROR' },
    });
  }
  return value as T;
};

/**
 * Validate pagination parameters
 * Prevents excessive data retrieval
 */
export const validatePagination = (
  page?: number,
  limit?: number,
  maxLimit: number = 100
): { page: number; limit: number } => {
  const validPage = Math.max(1, Math.floor(Number(page) || 1));
  const validLimit = Math.min(maxLimit, Math.max(1, Math.floor(Number(limit) || 10)));
  
  return { page: validPage, limit: validLimit };
};

// ==================
// URL Validation
// ==================

/**
 * Validate URL to prevent SSRF attacks
 */
export const validateUrl = (url: string, allowedProtocols: string[] = ['https', 'http']): boolean => {
  try {
    const parsed = new URL(url);
    
    // Check protocol
    if (!allowedProtocols.includes(parsed.protocol.replace(':', ''))) {
      return false;
    }
    
    // Block internal IPs and localhost
    const hostname = parsed.hostname.toLowerCase();
    const blockedPatterns = [
      /^localhost$/,
      /^127\./,
      /^10\./,
      /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
      /^192\.168\./,
      /^0\.0\.0\.0$/,
      /^::1$/,
      /^fe80:/,
      /^169\.254\./,
      /\.local$/,
      /\.internal$/,
    ];
    
    if (blockedPatterns.some(pattern => pattern.test(hostname))) {
      return false;
    }
    
    return true;
  } catch {
    return false;
  }
};

/**
 * Sanitize Cloudinary URL
 * Only allows valid Cloudinary domains
 */
export const sanitizeCloudinaryUrl = (url: string): string => {
  if (!url) return '';
  
  try {
    const parsed = new URL(url);
    
    // Only allow Cloudinary domains
    if (!parsed.hostname.endsWith('.cloudinary.com') && 
        parsed.hostname !== 'res.cloudinary.com') {
      throw new GraphQLError('Invalid image URL', {
        extensions: { code: 'VALIDATION_ERROR' },
      });
    }
    
    return url;
  } catch (error) {
    if (error instanceof GraphQLError) throw error;
    throw new GraphQLError('Invalid image URL format', {
      extensions: { code: 'VALIDATION_ERROR' },
    });
  }
};

// ==================
// File Upload Validation
// ==================

/**
 * Allowed MIME types for file uploads
 */
const ALLOWED_MIME_TYPES: Record<string, string[]> = {
  image: ['image/jpeg', 'image/png', 'image/gif', 'image/webp'],
  document: ['application/pdf', 'image/jpeg', 'image/png'],
};

/**
 * Validate file MIME type
 */
export const validateFileMimeType = (
  mimeType: string,
  category: 'image' | 'document'
): boolean => {
  const allowed = ALLOWED_MIME_TYPES[category];
  return allowed ? allowed.includes(mimeType.toLowerCase()) : false;
};

/**
 * Validate filename to prevent path traversal
 */
export const sanitizeFilename = (filename: string): string => {
  return filename
    .replace(/\.\./g, '') // Remove path traversal
    .replace(/[/\\]/g, '') // Remove path separators
    .replace(/[<>:"|?*\x00-\x1f]/g, '') // Remove invalid chars
    .substring(0, 255); // Limit length
};

// ==================
// Content-Type Specific Sanitizers
// ==================

/**
 * Sanitize user name (first name, last name)
 */
export const sanitizeName = (name: string): string => {
  return sanitizeText(name, 100)
    .replace(/[^a-zA-Z\s\-']/g, '') // Only allow letters, spaces, hyphens, apostrophes
    .trim();
};

/**
 * Sanitize business name (allows more characters)
 */
export const sanitizeBusinessName = (name: string): string => {
  return sanitizeText(name, 200);
};

/**
 * Sanitize comment/review content
 */
export const sanitizeComment = (comment: string): string => {
  return sanitizeText(comment, 2000);
};

/**
 * Sanitize message content
 */
export const sanitizeMessage = (message: string): string => {
  return sanitizeText(message, 5000);
};

/**
 * Sanitize address
 */
export const sanitizeAddress = (address: string): string => {
  return sanitizeText(address, 500);
};

/**
 * Sanitize phone number
 */
export const sanitizePhone = (phone: string): string => {
  return phone.replace(/[^\d+\-\s()]/g, '').substring(0, 20);
};
