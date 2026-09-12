/**
 * Email: the Resend client is created on first use, sends time out, background
 * delivery retries with backoff, and user-supplied values are escaped in the HTML
 */

import type * as EmailModule from '@/lib/email';

const mockSend = jest.fn();
const mockCreateClient = jest.fn();
const mockCaptureException = jest.fn();

jest.mock('resend', () => ({
  Resend: class {
    emails = { send: (...args: unknown[]) => mockSend(...args) };

    constructor(key?: string) {
      mockCreateClient(key);
      // Like the real client, which throws when constructed without an API key
      if (!key) throw new Error('Missing API key. Pass it to the constructor `new Resend("re_123")`');
    }
  },
}));
jest.mock('@/lib/sentry', () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
}));
jest.mock('@/config', () => ({
  config: {
    email: { fromName: 'Easykonnet', fromAddress: 'no-reply@easykonnet.com' },
    platform: { frontendUrl: 'https://easykonnet.com', supportEmail: 'support@easykonnet.com' },
  },
}));

type Email = typeof EmailModule;

const API_KEY = 're_test_key';
const originalEnv = process.env;

/** A fresh copy of the module, so the lazily created client isn't shared between tests */
const loadEmail = (): Email => {
  let email!: Email;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- re-import inside an isolated module registry
    email = require('@/lib/email');
  });
  return email;
};

const loadEmailWithApiKey = (): Email => {
  process.env.RESEND_API_KEY = API_KEY;
  return loadEmail();
};

const message = {
  to: 'ada@example.com',
  subject: 'Your booking is confirmed',
  html: '<p>See you on Saturday</p>',
  text: 'See you on Saturday',
};

const accepted = { data: { id: 'email_123' }, error: null };
const refused = {
  data: null,
  error: { name: 'validation_error', message: 'The from address is not verified', statusCode: 422 },
};

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
};

const never = () => new Promise<never>(() => undefined);

const sentHtml = (call = 0): string => (mockSend.mock.calls[call][0] as { html: string }).html;

beforeEach(() => {
  process.env = { ...originalEnv };
  delete process.env.RESEND_API_KEY;
  mockSend.mockReset();
  mockCreateClient.mockReset();
  mockCaptureException.mockReset();
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  jest.useRealTimers();
  process.env = originalEnv;
});

describe('Resend client', () => {
  it('is not created when the module loads, so a missing RESEND_API_KEY does not break imports', () => {
    expect(() => loadEmail()).not.toThrow();
    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  it('is created once with the API key and reused', async () => {
    const email = loadEmailWithApiKey();
    mockSend.mockResolvedValue(accepted);

    await email.sendEmail(message);
    await email.sendEmail(message);

    expect(mockCreateClient).toHaveBeenCalledTimes(1);
    expect(mockCreateClient).toHaveBeenCalledWith(API_KEY);
    expect(mockSend).toHaveBeenCalledTimes(2);
  });
});

describe('escapeHtml', () => {
  it('escapes the characters that can form markup or break out of an attribute', () => {
    const { escapeHtml } = loadEmail();

    expect(escapeHtml(`<a href="https://evil.example" title='x'>Tom & Jerry</a>`)).toBe(
      '&lt;a href=&quot;https://evil.example&quot; title=&#39;x&#39;&gt;Tom &amp; Jerry&lt;/a&gt;'
    );
  });

  it('leaves ordinary text unchanged', () => {
    expect(loadEmail().escapeHtml('Ada Okafor, Lekki Phase 1')).toBe('Ada Okafor, Lekki Phase 1');
  });
});

describe('sendEmail', () => {
  it('returns false without RESEND_API_KEY and does not call Resend', async () => {
    const email = loadEmail();

    await expect(email.sendEmail(message)).resolves.toBe(false);
    expect(mockCreateClient).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('sends from the configured address and returns true once Resend accepts the email', async () => {
    const email = loadEmailWithApiKey();
    mockSend.mockResolvedValue(accepted);

    await expect(email.sendEmail(message)).resolves.toBe(true);
    expect(mockSend).toHaveBeenCalledWith({ from: 'Easykonnet <no-reply@easykonnet.com>', ...message });
  });

  it('returns false when Resend answers with an error', async () => {
    const email = loadEmailWithApiKey();
    mockSend.mockResolvedValue(refused);

    await expect(email.sendEmail(message)).resolves.toBe(false);
  });

  it('returns false when the request throws', async () => {
    const email = loadEmailWithApiKey();
    mockSend.mockRejectedValue(new Error('getaddrinfo ENOTFOUND api.resend.com'));

    await expect(email.sendEmail(message)).resolves.toBe(false);
  });

  it('gives up and returns false when Resend has not responded after 10 seconds', async () => {
    jest.useFakeTimers();
    const email = loadEmailWithApiKey();
    mockSend.mockReturnValue(never());

    let settled = false;
    const result = email.sendEmail(message).finally(() => {
      settled = true;
    });

    await jest.advanceTimersByTimeAsync(9_999);
    expect(settled).toBe(false);

    await jest.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBe(false);
  });

  it('clears the timeout once Resend responds', async () => {
    jest.useFakeTimers();
    const email = loadEmailWithApiKey();
    mockSend.mockResolvedValue(accepted);

    await email.sendEmail(message);

    expect(jest.getTimerCount()).toBe(0);
  });
});

describe('sendEmailInBackground', () => {
  it('returns false straight away without RESEND_API_KEY and never calls Resend', async () => {
    jest.useFakeTimers();
    const email = loadEmail();

    expect(email.sendEmailInBackground(message)).toBe(false);

    await jest.advanceTimersByTimeAsync(60_000);
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it('returns true before Resend has responded', async () => {
    jest.useFakeTimers();
    const email = loadEmailWithApiKey();
    const response = deferred<typeof accepted>();
    mockSend.mockReturnValue(response.promise);

    expect(email.sendEmailInBackground(message)).toBe(true);
    expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({ to: message.to, subject: message.subject }));

    response.resolve(accepted);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it('makes three attempts, 2 seconds then 10 seconds apart, and reports only the final failure to Sentry', async () => {
    jest.useFakeTimers();
    const email = loadEmailWithApiKey();
    mockSend.mockResolvedValue(refused);

    email.sendEmailInBackground(message);
    await jest.advanceTimersByTimeAsync(0);
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockCaptureException).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(1_999);
    expect(mockSend).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(mockCaptureException).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(9_999);
    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(mockCaptureException).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(mockSend).toHaveBeenCalledTimes(3);

    expect(mockCaptureException).toHaveBeenCalledTimes(1);
    expect(mockCaptureException).toHaveBeenCalledWith(expect.any(Error), {
      tags: { area: 'email' },
      extra: { subject: message.subject },
    });

    await jest.advanceTimersByTimeAsync(10 * 60_000);
    expect(mockSend).toHaveBeenCalledTimes(3);
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
  });

  it('stops retrying once an attempt succeeds', async () => {
    jest.useFakeTimers();
    const email = loadEmailWithApiKey();
    mockSend.mockResolvedValueOnce(refused).mockResolvedValueOnce(accepted);

    email.sendEmailInBackground(message);
    await jest.advanceTimersByTimeAsync(10 * 60_000);

    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it('counts an attempt that times out as failed and tries again', async () => {
    jest.useFakeTimers();
    const email = loadEmailWithApiKey();
    mockSend.mockReturnValueOnce(never()).mockResolvedValueOnce(accepted);

    email.sendEmailInBackground(message);

    // 10 second timeout, then the 2 second wait before the second attempt
    await jest.advanceTimersByTimeAsync(11_999);
    expect(mockSend).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(mockSend).toHaveBeenCalledTimes(2);

    await jest.advanceTimersByTimeAsync(10 * 60_000);
    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(mockCaptureException).not.toHaveBeenCalled();
  });
});

describe('email helpers', () => {
  const helpers: [string, (email: Email) => Promise<boolean>][] = [
    ['sendVerificationEmail', (email) => email.sendVerificationEmail('ada@example.com', 'Ada', '482913')],
    ['sendPasswordResetEmail', (email) => email.sendPasswordResetEmail('ada@example.com', 'Ada', '482913')],
    ['sendLoginAlertEmail', (email) => email.sendLoginAlertEmail('ada@example.com', 'Ada', '102.89.33.10')],
    ['sendProviderApprovedEmail', (email) => email.sendProviderApprovedEmail('ada@example.com', 'Ada', 'Sparkle Cleaners')],
    [
      'sendProviderRejectedEmail',
      (email) => email.sendProviderRejectedEmail('ada@example.com', 'Ada', 'Sparkle Cleaners', 'The ID document is unreadable'),
    ],
    ['sendProviderSubmissionEmail', (email) => email.sendProviderSubmissionEmail('ada@example.com', 'Ada', 'Sparkle Cleaners')],
    ['sendProfileUpdatedEmail', (email) => email.sendProfileUpdatedEmail('ada@example.com', 'Ada', ['phone', 'address'])],
    ['sendEmailChangeOtpEmail', (email) => email.sendEmailChangeOtpEmail('ada.new@example.com', 'Ada', '482913')],
  ];

  it.each(helpers)('%s resolves without waiting for Resend', async (_name, send) => {
    jest.useFakeTimers();
    const email = loadEmailWithApiKey();
    const response = deferred<typeof accepted>();
    mockSend.mockReturnValue(response.promise);

    await expect(send(email)).resolves.toBe(true);
    expect(mockSend).toHaveBeenCalledTimes(1);

    response.resolve(accepted);
    await jest.advanceTimersByTimeAsync(0);
  });

  it.each(helpers)('%s returns false when email is not set up', async (_name, send) => {
    const email = loadEmail();

    await expect(send(email)).resolves.toBe(false);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('sends the email change code to the new address', async () => {
    const email = loadEmailWithApiKey();
    mockSend.mockResolvedValue(accepted);

    await email.sendEmailChangeOtpEmail('ada.new@example.com', 'Ada', '482913');

    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'ada.new@example.com', subject: 'Confirm Your New Email Address — Easykonnet' })
    );
    expect(sentHtml()).toContain('482913');
  });
});

describe('user-supplied values in the HTML', () => {
  const SCRIPT = '<script>alert(1)</script>';
  const ESCAPED_SCRIPT = '&lt;script&gt;alert(1)&lt;/script&gt;';

  it.each<[string, (email: Email) => Promise<boolean>]>([
    ['sendVerificationEmail', (email) => email.sendVerificationEmail('ada@example.com', SCRIPT, '482913')],
    ['sendPasswordResetEmail', (email) => email.sendPasswordResetEmail('ada@example.com', SCRIPT, '482913')],
    ['sendLoginAlertEmail', (email) => email.sendLoginAlertEmail('ada@example.com', SCRIPT, SCRIPT)],
    ['sendProviderApprovedEmail', (email) => email.sendProviderApprovedEmail('ada@example.com', SCRIPT, SCRIPT)],
    ['sendProviderRejectedEmail', (email) => email.sendProviderRejectedEmail('ada@example.com', SCRIPT, SCRIPT, SCRIPT)],
    ['sendProviderSubmissionEmail', (email) => email.sendProviderSubmissionEmail('ada@example.com', SCRIPT, SCRIPT)],
    ['sendProfileUpdatedEmail', (email) => email.sendProfileUpdatedEmail('ada@example.com', SCRIPT, [SCRIPT])],
    ['sendEmailChangeOtpEmail', (email) => email.sendEmailChangeOtpEmail(SCRIPT, SCRIPT, '482913')],
  ])('%s escapes them', async (_name, send) => {
    const email = loadEmailWithApiKey();
    mockSend.mockResolvedValue(accepted);

    await send(email);

    expect(sentHtml()).not.toContain('<script');
    expect(sentHtml()).toContain(ESCAPED_SCRIPT);
  });

  it('shows a rejection reason as text, so it cannot add a link to a genuine Easykonnet email', async () => {
    const email = loadEmailWithApiKey();
    mockSend.mockResolvedValue(accepted);

    await email.sendProviderRejectedEmail(
      'ada@example.com',
      'Ada',
      "Ada's Cleaning",
      'Appeal at <a href="https://evil.example">easykonnet-support.com</a>'
    );

    expect(sentHtml()).toContain(
      'Appeal at &lt;a href=&quot;https://evil.example&quot;&gt;easykonnet-support.com&lt;/a&gt;'
    );
    expect(sentHtml()).not.toContain('href="https://evil.example"');
    expect(sentHtml()).toContain('Ada&#39;s Cleaning');
  });
});
