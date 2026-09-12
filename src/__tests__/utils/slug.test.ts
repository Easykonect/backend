/**
 * Slug Tests
 *
 * Covers:
 *   - accented and hooked letters become their plain letters instead of vanishing
 *   - names with nothing a slug can use fall back to a random suffix
 */

import { slugify, slugOrFallback, slugSuffix } from '@/utils/slug';

describe('slugify', () => {
  it.each([
    ['Home Cleaning', 'home-cleaning'],
    ['Ọlá Plumbing', 'ola-plumbing'],
    ['Ìbàdàn Ṣọ̀ọ̀bù', 'ibadan-soobu'],
    ['Ƙwararru Ɗinki', 'kwararru-dinki'],
    ['Straße Café', 'strasse-cafe'],
    ['Hair & Makeup', 'hair-makeup'],
    ['AC/Fridge Repair', 'ac-fridge-repair'],
    ['  --Déjà Vu (Lekki)--  ', 'deja-vu-lekki'],
  ])('turns "%s" into "%s"', (name, slug) => {
    expect(slugify(name)).toBe(slug);
  });

  it.each(['...', '清洁服务', "'-'"])('gives an empty slug for "%s"', (name) => {
    expect(slugify(name)).toBe('');
  });
});

describe('slugOrFallback', () => {
  it('uses the slug when there is one', () => {
    expect(slugOrFallback('Generator Repair', 'category')).toBe('generator-repair');
  });

  it('falls back to a random suffix for a name with no letters or digits', () => {
    const first = slugOrFallback('...', 'category');
    const second = slugOrFallback('...', 'category');

    expect(first).toMatch(/^category-[0-9a-f]{8}$/);
    expect(second).toMatch(/^category-[0-9a-f]{8}$/);
    expect(first).not.toBe(second);
  });
});

describe('slugSuffix', () => {
  it('is 8 hex characters', () => {
    expect(slugSuffix()).toMatch(/^[0-9a-f]{8}$/);
  });
});
