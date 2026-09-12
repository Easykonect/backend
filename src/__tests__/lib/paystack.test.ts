/**
 * Paystack client: how failures are classified, URL encoding and commission
 */

jest.mock('@/config', () => ({
  config: {
    payment: { paystack: { secretKey: 'sk_test_secret' } },
    platform: { commissionRate: 0.1 },
  },
}));

import { config } from '@/config';
import {
  PaystackRequestError,
  calculatePlatformCommission,
  calculateProviderPayout,
  fetchTransfer,
  verifyTransaction,
  verifyTransfer,
} from '@/lib/paystack';

const originalFetch = global.fetch;
const fetchMock = jest.fn();

const respond = (status: number, body: unknown) =>
  fetchMock.mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });

beforeEach(() => {
  fetchMock.mockReset();
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterAll(() => {
  global.fetch = originalFetch;
});

describe('Paystack requests', () => {
  it('authenticates with the secret key, sets a timeout and returns the response body', async () => {
    respond(200, { status: true, message: 'Transfer retrieved', data: { status: 'success', transfer_code: 'TRF_1' } });

    const response = await verifyTransfer('wdr_66e2b4c1f0a9d83b5c7e1a2f_0');

    expect(response.data.transfer_code).toBe('TRF_1');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.paystack.co/transfer/verify/wdr_66e2b4c1f0a9d83b5c7e1a2f_0',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ Authorization: 'Bearer sk_test_secret' }),
        signal: expect.any(AbortSignal),
      })
    );
  });

  it('records the HTTP status when Paystack answers with an error', async () => {
    respond(404, { status: false, message: 'Transfer not found' });

    const error = await verifyTransfer('wdr_missing_0').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PaystackRequestError);
    expect(error).toMatchObject({ httpStatus: 404, message: 'Paystack request failed: Transfer not found' });
  });

  it.each([
    ['the request times out', () => fetchMock.mockRejectedValueOnce(new Error('The operation was aborted due to timeout'))],
    [
      'the response is not JSON',
      () => fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 502,
        json: async () => {
          throw new SyntaxError('Unexpected token < in JSON');
        },
      }),
    ],
  ])('leaves the HTTP status unset when %s, since the outcome is unknown', async (_label, fail) => {
    fail();

    const error = await verifyTransfer('wdr_unknown_0').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PaystackRequestError);
    expect((error as PaystackRequestError).httpStatus).toBeUndefined();
  });

  it('encodes references so they cannot reach other Paystack endpoints', async () => {
    respond(200, { status: true, data: {} });
    respond(200, { status: true, data: {} });
    respond(200, { status: true, data: {} });

    await verifyTransaction('../balance');
    await verifyTransfer('wdr/x');
    await fetchTransfer('TRF 1');

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://api.paystack.co/transaction/verify/..%2Fbalance',
      'https://api.paystack.co/transfer/verify/wdr%2Fx',
      'https://api.paystack.co/transfer/TRF%201',
    ]);
  });
});

describe('commission', () => {
  const platform = config.platform as { commissionRate: number };

  afterEach(() => {
    platform.commissionRate = 0.1;
  });

  it('uses the configured commission rate', () => {
    expect(calculatePlatformCommission(600_000)).toBe(60_000);
    expect(calculateProviderPayout(600_000)).toMatchObject({ platformCommission: 60_000, providerPayout: 540_000 });

    platform.commissionRate = 0.07;

    expect(calculatePlatformCommission(600_000)).toBe(42_000);
  });
});
