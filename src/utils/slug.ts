/**
 * URL slugs for services and categories
 */

import { randomBytes } from 'crypto';

// Letters that don't break down into a base letter plus accents
const SPECIAL_LETTERS: Record<string, string> = {
  ß: 'ss',
  æ: 'ae',
  œ: 'oe',
  ø: 'o',
  đ: 'd',
  ð: 'd',
  ł: 'l',
  þ: 'th',
  ı: 'i',
  // Hausa hooked letters
  ɓ: 'b',
  ɗ: 'd',
  ƙ: 'k',
  ƴ: 'y',
};

/**
 * Lowercase ASCII slug. Accents are dropped from letters ("Ọlá" becomes "ola"),
 * and every run of other characters becomes a hyphen. Can be empty, e.g. for "...".
 */
export const slugify = (text: string): string =>
  text
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/[ßæœøđðłþıɓɗƙƴ]/g, (letter) => SPECIAL_LETTERS[letter])
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

/**
 * Short random suffix to keep a slug unique
 */
export const slugSuffix = (): string => randomBytes(4).toString('hex');

/**
 * Slug for a name, or `{fallback}-{random}` when the name has no letters or
 * digits a slug can use
 */
export const slugOrFallback = (name: string, fallback: string): string =>
  slugify(name) || `${fallback}-${slugSuffix()}`;
