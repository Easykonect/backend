/**
 * Validation Schema Tests
 * Tests all Zod validation schemas
 */

import {
  emailSchema,
  passwordSchema,
  phoneSchema,
  objectIdSchema,
  paginationSchema,
  loginSchema,
  registerUserSchema,
} from '@/utils/validation';

describe('Validation Schemas', () => {
  // ==================
  // Email Validation
  // ==================
  describe('emailSchema', () => {
    it('should accept valid email addresses', () => {
      const validEmails = [
        'test@example.com',
        'user.name+tag@domain.co.uk',
        'admin@easykonnect.com',
        'user123@sub.domain.org',
      ];
      validEmails.forEach((email) => {
        expect(() => emailSchema.parse(email)).not.toThrow();
      });
    });

    it('should reject invalid email addresses', () => {
      const invalidEmails = [
        'notanemail',
        '@nodomain.com',
        'missing@.com',
        'spaces in@email.com',
        '',
      ];
      invalidEmails.forEach((email) => {
        expect(() => emailSchema.parse(email)).toThrow();
      });
    });
  });

  // ==================
  // Password Validation
  // ==================
  describe('passwordSchema', () => {
    it('should accept a valid strong password', () => {
      expect(() => passwordSchema.parse('StrongPass1!')).not.toThrow();
      expect(() => passwordSchema.parse('My$ecureP4ss')).not.toThrow();
    });

    it('should reject a password that is too short', () => {
      expect(() => passwordSchema.parse('Ab1!')).toThrow(/at least 8/);
    });

    it('should reject a password without an uppercase letter', () => {
      expect(() => passwordSchema.parse('lowercase1!')).toThrow(/uppercase/);
    });

    it('should reject a password without a lowercase letter', () => {
      expect(() => passwordSchema.parse('UPPERCASE1!')).toThrow(/lowercase/);
    });

    it('should reject a password without a number', () => {
      expect(() => passwordSchema.parse('NoNumbers!')).toThrow(/number/);
    });

    it('should reject a password without a special character', () => {
      expect(() => passwordSchema.parse('NoSpecial1A')).toThrow(/special/);
    });

    it('should reject a password that is too long', () => {
      const longPass = 'Aa1!' + 'x'.repeat(130);
      expect(() => passwordSchema.parse(longPass)).toThrow(/exceed/);
    });
  });

  // ==================
  // Phone Validation
  // ==================
  describe('phoneSchema', () => {
    it('should accept valid phone numbers', () => {
      expect(() => phoneSchema.parse('+2348012345678')).not.toThrow();
      expect(() => phoneSchema.parse('+12345678901')).not.toThrow();
      expect(() => phoneSchema.parse('2348012345678')).not.toThrow();
    });

    it('should reject invalid phone numbers', () => {
      expect(() => phoneSchema.parse('not-a-number')).toThrow();
      expect(() => phoneSchema.parse('')).toThrow();
      expect(() => phoneSchema.parse('+0')).toThrow();
    });
  });

  // ==================
  // ObjectId Validation
  // ==================
  describe('objectIdSchema', () => {
    it('should accept valid MongoDB ObjectIds', () => {
      expect(() => objectIdSchema.parse('507f1f77bcf86cd799439011')).not.toThrow();
      expect(() => objectIdSchema.parse('507F1F77BCF86CD799439011')).not.toThrow(); // Case-insensitive
    });

    it('should reject invalid ObjectIds', () => {
      expect(() => objectIdSchema.parse('not-an-objectid')).toThrow();
      expect(() => objectIdSchema.parse('507f1f77bcf86cd7994390')).toThrow(); // Too short
      expect(() => objectIdSchema.parse('507f1f77bcf86cd7994390111')).toThrow(); // Too long
      expect(() => objectIdSchema.parse('')).toThrow();
    });
  });

  // ==================
  // Pagination Validation
  // ==================
  describe('paginationSchema', () => {
    it('should accept valid pagination params', () => {
      const result = paginationSchema.parse({ page: 1, limit: 10 });
      expect(result.page).toBe(1);
      expect(result.limit).toBe(10);
    });

    it('should apply default values when omitted', () => {
      const result = paginationSchema.parse({});
      expect(result.page).toBe(1);
      expect(result.limit).toBe(10);
    });

    it('should reject limit above 100', () => {
      expect(() => paginationSchema.parse({ page: 1, limit: 101 })).toThrow();
    });

    it('should reject negative or zero values', () => {
      expect(() => paginationSchema.parse({ page: 0, limit: 10 })).toThrow();
      expect(() => paginationSchema.parse({ page: 1, limit: -5 })).toThrow();
    });
  });

  // ==================
  // Login Schema
  // ==================
  describe('loginSchema', () => {
    it('should accept valid login input', () => {
      expect(() =>
        loginSchema.parse({ email: 'user@example.com', password: 'anypassword' })
      ).not.toThrow();
    });

    it('should reject missing email', () => {
      expect(() => loginSchema.parse({ password: 'anypassword' })).toThrow();
    });

    it('should reject missing password', () => {
      expect(() => loginSchema.parse({ email: 'user@example.com' })).toThrow();
    });

    it('should reject invalid email in login', () => {
      expect(() =>
        loginSchema.parse({ email: 'invalidemail', password: 'anypassword' })
      ).toThrow();
    });
  });

  // ==================
  // Register Schema
  // ==================
  describe('registerUserSchema', () => {
    const validInput = {
      email: 'newuser@example.com',
      password: 'StrongPass1!',
      firstName: 'John',
      lastName: 'Doe',
    };

    it('should accept valid registration input', () => {
      expect(() => registerUserSchema.parse(validInput)).not.toThrow();
    });

    it('should accept optional phone number', () => {
      expect(() =>
        registerUserSchema.parse({ ...validInput, phone: '+2348012345678' })
      ).not.toThrow();
    });

    it('should reject a first name that is too short', () => {
      expect(() =>
        registerUserSchema.parse({ ...validInput, firstName: 'J' })
      ).toThrow(/at least 2/);
    });

    it('should reject a last name that is too short', () => {
      expect(() =>
        registerUserSchema.parse({ ...validInput, lastName: 'D' })
      ).toThrow(/at least 2/);
    });

    it('should reject weak passwords during registration', () => {
      expect(() =>
        registerUserSchema.parse({ ...validInput, password: 'weakpass' })
      ).toThrow();
    });
  });
});
