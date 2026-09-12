/**
 * validateEnv: stops startup without the variables the server can't run
 * without, and only warns about the ones some features need
 */

import type { validateEnv as ValidateEnv } from '@/config';

const REQUIRED = ['DATABASE_URL', 'JWT_SECRET'];
const RECOMMENDED = [
  'REDIS_URL',
  'RESEND_API_KEY',
  'EMAIL_FROM_ADDRESS',
  'PAYSTACK_SECRET_KEY',
  'CLOUDINARY_CLOUD_NAME',
  'CLOUDINARY_API_KEY',
  'CLOUDINARY_API_SECRET',
  'ONESIGNAL_APP_ID',
  'ONESIGNAL_REST_API_KEY',
  'FRONTEND_URL',
  'BACKEND_URL',
  'SUPPORT_EMAIL',
];

const originalEnv = process.env;

/** A fresh copy of the config module, loaded against the current process.env */
const loadValidateEnv = (): typeof ValidateEnv => {
  let validateEnv!: typeof ValidateEnv;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- re-import inside an isolated module registry
    ({ validateEnv } = require('@/config'));
  });
  return validateEnv;
};

// Placeholder values only, so no real configuration can appear in test output
const setVariables = (keys: string[]) => {
  for (const key of keys) process.env[key] = `placeholder-${key.toLowerCase()}`;
};

const silenceWarnings = () => jest.spyOn(console, 'warn').mockImplementation(() => undefined);

beforeEach(() => {
  process.env = { ...originalEnv };
  for (const key of [...REQUIRED, ...RECOMMENDED]) delete process.env[key];
});

afterEach(() => {
  process.env = originalEnv;
});

describe('validateEnv', () => {
  it.each(REQUIRED)('stops startup when %s is missing', (missing) => {
    silenceWarnings();
    setVariables(REQUIRED.filter((key) => key !== missing));
    setVariables(RECOMMENDED);

    const validateEnv = loadValidateEnv();

    expect(() => validateEnv()).toThrow(new Error(`Missing required environment variables: ${missing}`));
  });

  it('names every missing required variable', () => {
    silenceWarnings();
    setVariables(RECOMMENDED);

    const validateEnv = loadValidateEnv();

    expect(() => validateEnv()).toThrow(
      new Error('Missing required environment variables: DATABASE_URL, JWT_SECRET')
    );
  });

  it('treats an empty value as missing', () => {
    silenceWarnings();
    setVariables(REQUIRED);
    setVariables(RECOMMENDED);
    process.env.JWT_SECRET = '';

    const validateEnv = loadValidateEnv();

    expect(() => validateEnv()).toThrow(new Error('Missing required environment variables: JWT_SECRET'));
  });

  it('only warns when recommended variables are missing', () => {
    const warn = silenceWarnings();
    setVariables(REQUIRED);

    const validateEnv = loadValidateEnv();

    expect(validateEnv()).toEqual({ missingRecommended: RECOMMENDED });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(RECOMMENDED.join(', ')));
  });

  it('lists only the recommended variables that are missing', () => {
    silenceWarnings();
    setVariables(REQUIRED);
    setVariables(RECOMMENDED.filter((key) => key !== 'RESEND_API_KEY' && key !== 'BACKEND_URL'));

    const validateEnv = loadValidateEnv();

    expect(validateEnv()).toEqual({ missingRecommended: ['RESEND_API_KEY', 'BACKEND_URL'] });
  });

  it('returns an empty list and does not warn when everything is set', () => {
    const warn = silenceWarnings();
    setVariables(REQUIRED);
    setVariables(RECOMMENDED);

    const validateEnv = loadValidateEnv();

    expect(validateEnv()).toEqual({ missingRecommended: [] });
    expect(warn).not.toHaveBeenCalled();
  });
});
