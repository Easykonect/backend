/**
 * Content filter: blocked language (whole words, character swaps, stretched
 * letters, plurals) and contact or bank details in text people post
 */

jest.mock('@/config', () => ({ config: { moderation: { extraBlockedTerms: [] as string[] } } }));

import { GraphQLError } from 'graphql';
import { config } from '@/config';
import {
  assertAcceptableText,
  containsBankDetails,
  containsBlockedTerms,
  containsContactDetails,
  maskBlockedTerms,
} from '@/lib/content-filter';

const moderation = config.moderation as { extraBlockedTerms: string[] };

const errorFrom = (run: () => void): unknown => {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
};

afterEach(() => {
  moderation.extraBlockedTerms = [];
});

describe('containsBlockedTerms', () => {
  it.each(['shit', 'SHIT', 'Shit.', 'What the fuck?', 'you bastards', '(shit)', 'bullshit'])(
    'blocks "%s" whatever the case',
    (text) => {
      expect(containsBlockedTerms(text)).toBe(true);
    }
  );

  it.each(['sh1t', '$hit', 'B!tch', 'sh!t', '5hit', 'a$$hole', '4sshole', 'n1gga', 'f@ggot'])(
    'sees through the character swaps in "%s"',
    (text) => {
      expect(containsBlockedTerms(text)).toBe(true);
    }
  );

  it.each(['shiiiit', 'fuuuuck'])('blocks the stretched spelling "%s"', (text) => {
    expect(containsBlockedTerms(text)).toBe(true);
  });

  it.each(['bitches', 'BITCHES', 'sluts', 'rapists', 'dickheads', 'motherfuckers'])('blocks the plural "%s"', (text) => {
    expect(containsBlockedTerms(text)).toBe(true);
  });

  it.each([
    'Scunthorpe',
    'assessment',
    'class',
    'classes',
    'shiitake',
    'cocktail',
    'Dickens',
    'therapist',
    'therapists',
    'Nigerian',
    'Niger Delta',
    'snigger',
    'pussycat',
    'retardant',
    'passion',
    'Hitchcock',
    'Penistone',
    'Arsenal',
    'Bitcoin',
    'Sh!ft',
    'N5,000 for 3 hours',
  ])('does not block "%s", which only contains a blocked word or a swapped character', (text) => {
    expect(containsBlockedTerms(text)).toBe(false);
  });

  it('uses the extra terms from the config, and picks up changes to them', () => {
    expect(containsBlockedTerms('mumu')).toBe(false);

    moderation.extraBlockedTerms = ['mumu'];
    expect(containsBlockedTerms('mumu')).toBe(true);
    expect(containsBlockedTerms('MUMU')).toBe(true);
    expect(containsBlockedTerms('mumuu')).toBe(true);

    moderation.extraBlockedTerms = [];
    expect(containsBlockedTerms('mumu')).toBe(false);
  });

  it('matches an extra term of several words across any whitespace', () => {
    moderation.extraBlockedTerms = ['go die'];

    expect(containsBlockedTerms('Just go die')).toBe(true);
    expect(containsBlockedTerms('go  die')).toBe(true);
    expect(containsBlockedTerms('go\ndie')).toBe(true);
    expect(containsBlockedTerms('go and die')).toBe(false);
  });

  it.each(['Shit!', 'fuck!', 'You are a bitch!', 'what the fuck!!!', 'sh1t!', 'shit?!', '@bitch'])(
    'blocks "%s", where punctuation touches the word',
    (text) => {
      expect(containsBlockedTerms(text)).toBe(true);
    }
  );

  it('blocks the plural "pussies"', () => {
    expect(containsBlockedTerms('pussies')).toBe(true);
  });

  it.each(['Flat SH17', 'Plot 7W47'])('does not block the code in "%s"', (text) => {
    expect(containsBlockedTerms(text)).toBe(false);
  });

  it('matches extra terms written with digits or punctuation', () => {
    moderation.extraBlockedTerms = ['419', 'you mumu!'];

    expect(containsBlockedTerms('a 419 scam')).toBe(true);
    expect(containsBlockedTerms('call 4190 now')).toBe(false);
    expect(containsBlockedTerms('Oga, you mumu!')).toBe(true);
  });
});

describe('maskBlockedTerms', () => {
  it.each([
    ['You are a bastard.', 'You are a *******.'],
    ['This is $h1t, honestly', 'This is ****, honestly'],
    ['shiiiit', '*******'],
    ['Stop it, bitches', 'Stop it, *******'],
    ['shit and bullshit', '**** and ********'],
    ['You are a bitch!', 'You are a *****!'],
  ])('masks "%s" as "%s"', (text, masked) => {
    expect(maskBlockedTerms(text)).toBe(masked);
    expect(maskBlockedTerms(text)).toHaveLength(text.length);
  });

  it('leaves clean text unchanged', () => {
    const text = 'See you at 10:30 in Lekki. Class starts at 11!';

    expect(maskBlockedTerms(text)).toBe(text);
  });

  it('masks extra terms from the config', () => {
    moderation.extraBlockedTerms = ['mumu'];

    expect(maskBlockedTerms('Oga, you be mumu.')).toBe('Oga, you be ****.');
  });
});

describe('containsContactDetails', () => {
  it.each([
    'ada@example.com',
    'Email me at Ada.Okafor+jobs@mail.example.ng',
    '08031234567',
    '0803 123 4567',
    '0803-123-4567',
    '+234 803 123 4567',
    '+2348031234567',
    '2348031234567',
    '07012345678',
    '09123456789',
    '0123456789',
    'Acct: 0123 456 789',
    '012 345 6789',
  ])('finds contact details in "%s"', (text) => {
    expect(containsContactDetails(text)).toBe(true);
  });

  it.each([
    '₦15,000',
    '5000 naira',
    'N5000',
    '₦1,500,000',
    '2026-09-12',
    '12/09/2026',
    '10:30',
    'Book for 2026-09-12 at 10:30',
    '3 bedrooms',
    'Plot 12, Lekki Phase 1',
    '24/7',
    'Order #123456789',
    'ref 1234-5678',
    'Opens 2026-09-14 09:00',
    'Available 2026-09-12 10:30',
    'Prices: 5000 7500 10000',
    'Sizes 1000 2000 3000',
  ])('does not treat "%s" as contact details', (text) => {
    expect(containsContactDetails(text)).toBe(false);
  });
});

describe('containsBankDetails', () => {
  it.each([
    'Send to my account 0123456789',
    'acct no 0123456789',
    'Access Bank 0123456789',
    'transfer to 0123456789',
    'Opay: 8031234567',
    'PALMPAY 0123456789',
    'moniepoint 0123456789',
    'Kuda 0123456789',
    'GTBank 0123456789',
    'my accounts 0123456789',
    'Zenith 0123456789',
  ])('finds bank details in "%s"', (text) => {
    expect(containsBankDetails(text)).toBe(true);
  });

  it.each([
    ['a long number without a bank word', '0123456789'],
    ['a bank word without a long number', 'My account is ready'],
    ['a bank word with a short number', 'Pay 5000 by bank transfer'],
    ['a word that only contains a bank name', 'Cuba 0123456789'],
  ])('needs both a long number and a bank word, so not %s', (_label, text) => {
    expect(containsBankDetails(text)).toBe(false);
  });
});

describe('assertAcceptableText', () => {
  it.each([null, undefined, ''])('accepts %p', (text) => {
    expect(() => assertAcceptableText(text, 'Your review')).not.toThrow();
  });

  it('accepts clean text', () => {
    expect(() => assertAcceptableText('Great job, very neat and on time', 'Your review')).not.toThrow();
  });

  it('rejects blocked language, naming the field', () => {
    const error = errorFrom(() => assertAcceptableText('This provider is a bastard', 'Your review'));

    expect(error).toBeInstanceOf(GraphQLError);
    expect(error).toMatchObject({
      message: expect.stringContaining('Your review'),
      extensions: { code: 'INAPPROPRIATE_CONTENT' },
    });
  });

  it('rejects contact details, naming the field', () => {
    const error = errorFrom(() => assertAcceptableText('Call me on 0803 123 4567', 'Business description'));

    expect(error).toBeInstanceOf(GraphQLError);
    expect(error).toMatchObject({
      message: expect.stringContaining('Business description'),
      extensions: { code: 'CONTACT_DETAILS_NOT_ALLOWED' },
    });
  });

  it('allows contact details where the field permits them, but still rejects blocked language', () => {
    expect(() =>
      assertAcceptableText('Call me on 0803 123 4567', 'Business description', { allowContactDetails: true })
    ).not.toThrow();

    expect(
      errorFrom(() => assertAcceptableText('Call this sh1t on 0803 123 4567', 'Business description', { allowContactDetails: true }))
    ).toMatchObject({ extensions: { code: 'INAPPROPRIATE_CONTENT' } });
  });
});
