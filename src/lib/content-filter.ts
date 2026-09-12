/**
 * Content Filter
 *
 * Screens text people post (messages, reviews, names and listings) for
 * blocked language, and for contact or bank details that would let a deal be
 * taken off the platform. Blocked terms match whole words, ignoring case,
 * look-alike characters (sh1t, $hit) and stretched letters (shiiit).
 */

import { GraphQLError } from 'graphql';
import { config } from '@/config';

// Strong profanity and slurs; more can be added with CONTENT_FILTER_TERMS
const DEFAULT_BLOCKED_TERMS = [
  'fuck',
  'fucked',
  'fucker',
  'fucking',
  'motherfucker',
  'shit',
  'bullshit',
  'bitch',
  'bastard',
  'asshole',
  'cunt',
  'dickhead',
  'pussy',
  'pussies',
  'whore',
  'slut',
  'wanker',
  'twat',
  'nigger',
  'nigga',
  'faggot',
  'retard',
  'rapist',
  'ashawo',
];

// Characters people type in place of a letter to get past filters
const LOOKALIKES: Record<string, string> = {
  a: '4@',
  e: '3',
  i: '1!',
  o: '0',
  s: '5$',
  t: '7',
};

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * One character of a term: a letter or its look-alikes, possibly repeated.
 * Spaces inside a term match any whitespace; anything else matches as typed.
 */
const characterPattern = (char: string): string => {
  if (/\s/.test(char)) return '\\s*';
  const lookalikes = LOOKALIKES[char];
  return lookalikes ? `[${escapeRegExp(char + lookalikes)}]+` : `${escapeRegExp(char)}+`;
};

interface TermPattern {
  pattern: RegExp;
  // Terms written with digits (e.g. 419) may match text that is mostly digits
  hasDigits: boolean;
}

let compiled: { signature: string; terms: TermPattern[] } | null = null;

/**
 * One pattern per term, matched against the text as written: a whole word,
 * any case, with an optional plural ending. Look-alikes live in the pattern,
 * so punctuation next to a word (shit!) still counts as a word boundary.
 */
const blockedTermPatterns = (): TermPattern[] => {
  const terms = [...new Set([...DEFAULT_BLOCKED_TERMS, ...(config.moderation?.extraBlockedTerms ?? [])])]
    .map((term) => term.trim().toLowerCase())
    .filter(Boolean);
  const signature = terms.join('|');

  if (compiled?.signature !== signature) {
    compiled = {
      signature,
      terms: terms.map((term) => ({
        pattern: new RegExp(
          `(?<![\\p{L}\\p{N}])${[...term].map(characterPattern).join('')}(?:[e3]?[s5$])?(?![\\p{L}\\p{N}])`,
          'giu'
        ),
        hasDigits: /\d/.test(term),
      })),
    };
  }

  return compiled.terms;
};

const blockedSpans = (text: string): { start: number; end: number }[] => {
  const spans: { start: number; end: number }[] = [];

  for (const { pattern, hasDigits } of blockedTermPatterns()) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const digits = match[0].replace(/\D/g, '').length;
      // Half digits or more is a code (SH17, 7W47), not a disguised word
      if (!hasDigits && digits * 2 >= match[0].length) continue;
      spans.push({ start: match.index, end: match.index + match[0].length });
    }
  }

  return spans;
};

/**
 * Whether the text contains blocked language
 */
export const containsBlockedTerms = (text: string): boolean => blockedSpans(text).length > 0;

/**
 * Replace blocked language with asterisks
 */
export const maskBlockedTerms = (text: string): string => {
  const characters = text.split('');
  for (const { start, end } of blockedSpans(text)) {
    for (let i = start; i < end; i++) characters[i] = '*';
  }
  return characters.join('');
};

const EMAIL = /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/i;
// Nigerian mobile numbers, with or without the country code
const PHONE = /(?:\+?234|\b0)[\s-]?[789][01](?:[\s-]?\d){8}\b/;
// Account numbers and other long numbers: 10 or more digits in a row, or digits
// grouped the way phone and account numbers are written (0123 456 789). Groups of
// two (dates, times) or runs of four-digit prices don't qualify.
const LONG_NUMBER = /(?<!\d)(?:\d{10,}|\d{3,4}(?:[\s.-]\d{3}){1,2}[\s.-]\d{3,4})(?!\d)/g;
// Words that come with bank details. They must start a word but may run on
// (accounts, GTBank)
const BANK_WORDS =
  /(?<!\p{L})(?:account|acct|a\/c|bank|gtbank|gtb|firstbank|nuban|transfer|opay|palmpay|moniepoint|kuda|zenith|uba|wema|fidelity|polaris|providus|stanbic|ecobank|fcmb|keystone)/iu;

const containsLongNumber = (text: string): boolean =>
  (text.match(LONG_NUMBER) ?? []).some((match) => match.replace(/\D/g, '').length >= 10);

/**
 * Whether the text includes an email address, phone number or account number
 */
export const containsContactDetails = (text: string): boolean =>
  EMAIL.test(text) || PHONE.test(text) || containsLongNumber(text);

/**
 * Whether the text looks like someone sharing bank details for a payment
 */
export const containsBankDetails = (text: string): boolean =>
  containsLongNumber(text) && BANK_WORDS.test(text);

/**
 * Reject text shown to other people (names, listings, reviews) if it contains
 * blocked language, or contact details unless they're allowed for the field
 */
export const assertAcceptableText = (
  text: string | null | undefined,
  field: string,
  options: { allowContactDetails?: boolean } = {}
): void => {
  if (!text) return;

  if (containsBlockedTerms(text)) {
    throw new GraphQLError(`${field} contains language that isn't allowed on Easykonnet`, {
      extensions: { code: 'INAPPROPRIATE_CONTENT' },
    });
  }

  if (!options.allowContactDetails && containsContactDetails(text)) {
    throw new GraphQLError(
      `${field} can't include phone numbers, email addresses or account numbers. You can share contact details in chat once a booking is made.`,
      { extensions: { code: 'CONTACT_DETAILS_NOT_ALLOWED' } }
    );
  }
};
