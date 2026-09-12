/**
 * Links the Paystack callback bridge may send a customer back to
 */

jest.mock('@/config', () => ({
  config: {
    platform: {
      frontendUrl: 'https://app.easykonnet.com',
      backendUrl: 'https://api.easykonnet.com',
      appUrlSchemes: ['easykonnect', 'easykonnet'],
    },
  },
}));

import { config } from '@/config';
import { isAllowedCallbackUrl, isAllowedReturnLink } from '@/lib/return-link';

describe('isAllowedCallbackUrl', () => {
  it.each([
    'https://app.easykonnet.com/payment/callback',
    'https://app.easykonnet.com/bookings/1/paid?tab=receipt',
    'https://api.easykonnet.com/payment/done',
  ])('allows %s', (link) => {
    expect(isAllowedCallbackUrl(link)).toBe(true);
  });

  it.each([
    ['another website', 'https://evil.example/pay'],
    ['a lookalike domain', 'https://app.easykonnet.com.evil.example/'],
    ['our site over plain http', 'http://app.easykonnet.com/payment/callback'],
    ['an app link, which Paystack can’t redirect to', 'easykonnect://payment-callback'],
    ['a script URL', 'javascript:alert(document.domain)'],
    ['a protocol-relative link', '//app.easykonnet.com/payment/callback'],
    ['text that is not a link', 'not a link'],
  ])('refuses %s', (_label, link) => {
    expect(isAllowedCallbackUrl(link)).toBe(false);
  });
});

// The mocked config can be changed per test
const platform = config.platform as { appUrlSchemes?: string[] };

describe('isAllowedReturnLink', () => {
  it.each([
    'easykonnect://payment-callback',
    'EASYKONNECT://payment-callback?booking=1',
    'easykonnet://payments/done',
    'https://app.easykonnet.com/payment/callback',
    'https://api.easykonnet.com/api/payments/paystack/callback',
  ])('allows %s', (link) => {
    expect(isAllowedReturnLink(link)).toBe(true);
  });

  it.each([
    ['another website', 'https://evil.example/pay'],
    ['a lookalike domain', 'https://app.easykonnet.com.evil.example/'],
    ['our site over plain http', 'http://app.easykonnet.com/payment/callback'],
    ['a script URL', 'javascript:alert(document.domain)'],
    ['a data URL', 'data:text/html,<script>alert(1)</script>'],
    ['an Android intent', 'intent://pay#Intent;scheme=https;end'],
    ['another app', 'someapp://callback'],
    ['text that is not a link', 'not a link'],
  ])('refuses %s', (_label, link) => {
    expect(isAllowedReturnLink(link)).toBe(false);
  });

  it('falls back to the Easykonnet app schemes when none are configured', () => {
    const configured = platform.appUrlSchemes;
    platform.appUrlSchemes = undefined;

    try {
      expect(isAllowedReturnLink('easykonnect://payment-callback')).toBe(true);
      expect(isAllowedReturnLink('someapp://callback')).toBe(false);
    } finally {
      platform.appUrlSchemes = configured;
    }
  });

  it('follows the configured schemes', () => {
    const configured = platform.appUrlSchemes;
    platform.appUrlSchemes = ['easykonnect-staging'];

    try {
      expect(isAllowedReturnLink('easykonnect-staging://payment-callback')).toBe(true);
      expect(isAllowedReturnLink('easykonnect://payment-callback')).toBe(false);
    } finally {
      platform.appUrlSchemes = configured;
    }
  });
});
