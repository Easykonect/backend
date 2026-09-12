/**
 * Phone numbers: register and updateProfile accept the same Nigerian mobile
 * formats and store them the same way (+234 followed by 10 digits)
 */

jest.mock('@/lib/redis', () => ({
  __esModule: true,
  default: { getInstance: jest.fn(), connect: jest.fn() },
}));

import { normalizeNigerianPhone, phoneSchema, registerUserSchema } from '@/utils/validation';
import { validatePhone } from '@/utils/security';

describe('normalizeNigerianPhone', () => {
  it.each([
    '08031234567',
    '0803 123 4567',
    '0803-123-4567',
    '(0803) 123 4567',
    '+2348031234567',
    '+234 803 123 4567',
    '2348031234567',
    '+234 (0) 803 123 4567',
    '  08031234567  ',
  ])('reads %p as +2348031234567', (phone) => {
    expect(normalizeNigerianPhone(phone)).toBe('+2348031234567');
  });

  it.each(['07012345678', '07112345678', '09012345678', '09112345678', '08112345678'])(
    'accepts the mobile prefix in %s',
    (phone) => {
      expect(normalizeNigerianPhone(phone)).toBe(`+234${phone.slice(1)}`);
    }
  );

  it.each([
    '',
    '   ',
    'not-a-number',
    'tel: 08031234567',
    '0803+1234567',
    '+12025550123',
    '08231234567',
    '0803123456',
    '080312345678',
    '0'.repeat(31),
  ])('rejects %p', (phone) => {
    expect(normalizeNigerianPhone(phone)).toBeNull();
  });

  it('rejects values that are not strings', () => {
    expect(normalizeNigerianPhone(8031234567)).toBeNull();
    expect(normalizeNigerianPhone(null)).toBeNull();
  });
});

describe('validatePhone (updateProfile)', () => {
  it('returns the stored form', () => {
    expect(validatePhone('0803 123 4567')).toBe('+2348031234567');
  });

  it('throws INVALID_PHONE for anything else', () => {
    expect(() => validatePhone('+12025550123')).toThrow(
      expect.objectContaining({
        message: 'Invalid Nigerian phone number',
        extensions: { code: 'INVALID_PHONE' },
      })
    );
  });
});

describe('registerUserSchema phone', () => {
  const input = {
    email: 'ada@example.com',
    password: 'Str0ng!Pass',
    firstName: 'Ada',
    lastName: 'Obi',
  };

  it.each(['08031234567', '0803 123 4567', '+2348031234567', '', null, undefined])(
    'accepts %p',
    (phone) => {
      expect(registerUserSchema.safeParse({ ...input, phone }).success).toBe(true);
    }
  );

  it('rejects a number updateProfile would also reject, with the register message', () => {
    const result = registerUserSchema.safeParse({ ...input, phone: '+12025550123' });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe('Invalid phone number');
  });

  it('phoneSchema matches normalizeNigerianPhone', () => {
    expect(phoneSchema.safeParse('0803 123 4567').success).toBe(true);
    expect(phoneSchema.safeParse('+12025550123').success).toBe(false);
  });
});
