/**
 * Business Name and Amount Validation Tests
 *
 * Covers:
 *   - validateBusinessName allows the punctuation business, service, category
 *     and place names use (& , / ( ) ' . -), and accented letters
 *   - validateName (person names) stays strict
 *   - validateAmount refuses 0, matching its "must be positive" message
 */

jest.mock('@/lib/redis', () => ({
  __esModule: true,
  default: { getInstance: jest.fn() },
}));

import { validateAmount, validateBusinessName, validateName } from '@/utils/security';

describe('validateBusinessName', () => {
  it.each([
    'Hair & Makeup',
    'AC/Fridge Repair',
    'Ikeja, Lagos',
    'Painting (Interior)',
    "Mama's Kitchen",
    'Mama’s Kitchen',
    'St. Mary’s Plumbing',
    'Ọ̀ṣọ́ Ilé Décor',
    'Ƙwararru Ɗinki',
    'Port-Harcourt',
  ])('accepts "%s"', (name) => {
    expect(validateBusinessName(name, 'Business name')).toBe(name);
  });

  it('removes HTML tags and surrounding spaces', () => {
    expect(validateBusinessName('  <b>Hair</b> & Makeup ', 'Business name')).toBe('Hair & Makeup');
  });

  it.each(['Glam!!!', 'Clean@Home', '50% Off', 'A+ Plumbing', 'Hair < Makeup', 'Cleaning #1', 'Fast; Cheap'])(
    'refuses "%s"',
    (name) => {
      expect(() => validateBusinessName(name, 'Business name')).toThrow('Business name contains invalid characters');
    }
  );

  it('keeps the 2 to 100 character limits', () => {
    expect(() => validateBusinessName('A', 'City')).toThrow('City must be at least 2 characters');
    expect(() => validateBusinessName('', 'City')).toThrow('City must be at least 2 characters');
    expect(() => validateBusinessName('a'.repeat(101), 'City')).toThrow('City too long (max 100 characters)');
  });

  it('uses INVALID_INPUT', () => {
    expect(() => validateBusinessName('Glam!!!', 'Service name')).toThrow(
      expect.objectContaining({ extensions: expect.objectContaining({ code: 'INVALID_INPUT' }) })
    );
  });
});

describe('validateName — person names stay strict', () => {
  it.each(['Ada & Co', 'O/Brien', 'Eze, Chinedu', 'Ada (Nne)'])('refuses "%s"', (name) => {
    expect(() => validateName(name, 'First name')).toThrow('First name contains invalid characters');
  });

  it.each(["O'Brien", 'Adéwálé', 'Mary-Jane'])('accepts "%s"', (name) => {
    expect(validateName(name, 'First name')).toBe(name);
  });
});

describe('validateAmount', () => {
  it.each([0, -0, -1, -0.01])('refuses %d', (amount) => {
    expect(() => validateAmount(amount, 'Price')).toThrow('Price must be positive');
  });

  it.each([0.01, 1, 45000, 45000.5])('accepts %d', (amount) => {
    expect(validateAmount(amount, 'Price')).toBe(amount);
  });

  it('refuses more than 2 decimal places', () => {
    expect(() => validateAmount(45000.555, 'Price')).toThrow('Price can have at most 2 decimal places');
  });

  it('refuses a value that is not a number', () => {
    expect(() => validateAmount(Number.NaN, 'Duration')).toThrow('Duration must be a number');
  });
});
