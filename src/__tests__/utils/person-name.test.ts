/**
 * Person names: letters with combining accents (as in Yoruba names) and curly
 * apostrophes are accepted; other punctuation isn't
 */

jest.mock('@/lib/redis', () => ({ __esModule: true, default: {}, rateLimit: { check: jest.fn() } }));

import { GraphQLError } from 'graphql';
import { validateName } from '@/utils/security';

describe('validateName', () => {
  it.each(['Ọ̀pẹ́', 'Adébáyọ̀', 'Chiamaka', "O'Neil", 'O’Brien', 'Mary-Jane', 'Ngozi Jr.'])('accepts %s', (name) => {
    expect(validateName(name, 'First name')).toBe(name);
  });

  it.each(['Ada!', 'Bola@home', 'Tunde & Co', 'Kemi, Lagos', 'Ife;'])('rejects %s', (name) => {
    expect(() => validateName(name, 'First name')).toThrow(GraphQLError);
  });
});
