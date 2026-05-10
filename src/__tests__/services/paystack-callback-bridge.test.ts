/**
 * Paystack Callback Bridge Route Tests
 *
 * Covers the HTTPS bridge that bounces Paystack's redirect into the
 * mobile app's deep link.
 */

// ==================
// Mocks
// ==================

jest.mock('@/services/payment.service', () => ({
  verifyPayment: jest.fn().mockResolvedValue({ verified: true }),
}));

jest.mock('@/lib/paystack', () => ({
  verifyTransaction: jest.fn(),
}));

jest.mock('@/config', () => ({
  config: {
    platform: {
      frontendUrl: 'https://app.easykonnect.com',
      backendUrl: 'https://api.easykonnect.com',
    },
  },
}));

import { verifyPayment } from '@/services/payment.service';
import * as paystackLib from '@/lib/paystack';
import { GET } from '@/app/api/payments/paystack/callback/route';

// Polyfill NextRequest by using stdlib Request — Next's NextRequest is just a
// thin extension of Request and our handler only uses request.url.
const buildRequest = (url: string) => new Request(url) as any;

beforeEach(() => {
  (verifyPayment as jest.Mock).mockClear();
  (paystackLib.verifyTransaction as jest.Mock).mockReset();
});

// ==================
// Tests
// ==================

describe('Paystack callback bridge — GET /api/payments/paystack/callback', () => {
  it('returns 400 with HTML when no reference query param is present', async () => {
    const res = await GET(buildRequest('https://api.easykonnect.com/api/payments/paystack/callback'));

    expect(res.status).toBe(400);
    expect(res.headers.get('Content-Type')).toMatch(/text\/html/);
    expect(verifyPayment).not.toHaveBeenCalled();
  });

  it('verifies the payment and bounces to the deep link recovered from metadata', async () => {
    (paystackLib.verifyTransaction as jest.Mock).mockResolvedValueOnce({
      data: {
        status: 'success',
        metadata: { returnDeepLink: 'easykonnect://payment-callback' },
      },
    });

    const res = await GET(
      buildRequest('https://api.easykonnect.com/api/payments/paystack/callback?reference=ref_abc')
    );

    expect(res.status).toBe(200);
    expect(verifyPayment).toHaveBeenCalledWith('ref_abc');

    const body = await res.text();
    expect(body).toContain('easykonnect://payment-callback');
    expect(body).toContain('reference=ref_abc');
    expect(body).toContain('status=success');
    // Should auto-trigger window.location to fire the deep link
    expect(body).toContain('window.location');
  });

  it('accepts the trxref query param if reference is missing', async () => {
    (paystackLib.verifyTransaction as jest.Mock).mockResolvedValueOnce({
      data: { status: 'success', metadata: { returnDeepLink: 'easykonnect://payment-callback' } },
    });

    const res = await GET(
      buildRequest('https://api.easykonnect.com/api/payments/paystack/callback?trxref=ref_xyz')
    );

    expect(res.status).toBe(200);
    expect(verifyPayment).toHaveBeenCalledWith('ref_xyz');
  });

  it('falls back to FRONTEND_URL when no returnDeepLink is in metadata', async () => {
    (paystackLib.verifyTransaction as jest.Mock).mockResolvedValueOnce({
      data: { status: 'success', metadata: {} },
    });

    const res = await GET(
      buildRequest('https://api.easykonnect.com/api/payments/paystack/callback?reference=ref_abc')
    );

    const body = await res.text();
    expect(body).toContain('https://app.easykonnect.com/payment/callback');
    expect(body).not.toContain('easykonnect://');
  });

  it('still bounces to the deep link if verifyPayment throws (webhook will retry)', async () => {
    (paystackLib.verifyTransaction as jest.Mock).mockResolvedValueOnce({
      data: { status: 'success', metadata: { returnDeepLink: 'easykonnect://payment-callback' } },
    });
    (verifyPayment as jest.Mock).mockRejectedValueOnce(new Error('db down'));

    const res = await GET(
      buildRequest('https://api.easykonnect.com/api/payments/paystack/callback?reference=ref_abc')
    );

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('easykonnect://payment-callback');
  });

  it('still bounces if Paystack verifyTransaction throws (we still have the reference)', async () => {
    (paystackLib.verifyTransaction as jest.Mock).mockRejectedValueOnce(new Error('paystack 500'));

    const res = await GET(
      buildRequest('https://api.easykonnect.com/api/payments/paystack/callback?reference=ref_abc')
    );

    expect(res.status).toBe(200);
    const body = await res.text();
    // No metadata recovered → fallback to frontend URL with reference attached
    expect(body).toContain('https://app.easykonnect.com/payment/callback');
    expect(body).toContain('reference=ref_abc');
  });

  it('escapes user-controlled metadata to prevent HTML/JS injection', async () => {
    (paystackLib.verifyTransaction as jest.Mock).mockResolvedValueOnce({
      data: {
        status: 'success',
        metadata: {
          returnDeepLink: "easykonnect://x'<script>alert(1)</script>",
        },
      },
    });

    const res = await GET(
      buildRequest('https://api.easykonnect.com/api/payments/paystack/callback?reference=ref_abc')
    );

    const body = await res.text();
    // Raw <script> tag from the deep link must not appear unescaped — the
    // opening "<" must be escaped so it can't break out of the JS string
    // literal and become an actual <script> element.
    expect(body).not.toContain("<script>alert(1)");
    // The escaped form should be present in the embedded JS literal
    expect(body).toMatch(/\\u003cscript/);
  });

  it('marks status=failed when Paystack reports a non-success transaction', async () => {
    (paystackLib.verifyTransaction as jest.Mock).mockResolvedValueOnce({
      data: { status: 'failed', metadata: { returnDeepLink: 'easykonnect://payment-callback' } },
    });

    const res = await GET(
      buildRequest('https://api.easykonnect.com/api/payments/paystack/callback?reference=ref_abc')
    );

    const body = await res.text();
    expect(body).toContain('status=failed');
  });
});
