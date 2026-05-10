/**
 * Paystack Callback Bridge
 *
 * Why this exists:
 *   Paystack's hosted checkout cannot redirect a browser directly to a
 *   non-http(s) URL (e.g. "easykonnect://..."). When a native app passes
 *   `returnDeepLink` to `initializePayment`, the backend tells Paystack to
 *   redirect HERE (HTTPS, allowed) instead. This route then:
 *     1. Verifies the payment with Paystack (idempotent, also runs the
 *        Payment.status -> COMPLETED + Booking.status -> IN_PROGRESS update,
 *        in case the webhook hasn't landed yet).
 *     2. Recovers the original `returnDeepLink` from Paystack's transaction
 *        metadata (we stored it at initialize time).
 *     3. Returns a tiny HTML page that immediately navigates the user-agent
 *        to the deep link, dropping the user back into the app.
 *
 * Paystack appends `?reference=<ref>` (and on cancel, may append
 * `?trxref=<ref>` only). We accept either.
 */

import { NextRequest, NextResponse } from 'next/server';
import { verifyPayment } from '@/services/payment.service';
import * as paystack from '@/lib/paystack';
import { config } from '@/config';

export const dynamic = 'force-dynamic';

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeJs(input: string): string {
  // For embedding inside a single-quoted JS string literal in the page below.
  return input.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/</g, '\\u003c');
}

function renderBouncePage(deepLink: string, fallbackHref: string, status: 'success' | 'failed'): string {
  const safeDeep = escapeJs(deepLink);
  const safeFallback = escapeHtml(fallbackHref);
  const heading = status === 'success' ? 'Payment Successful' : 'Payment Update';
  const message =
    status === 'success'
      ? 'Returning you to the app…'
      : 'Returning you to the app to retry…';

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(heading)}</title>
    <style>
      html, body { height: 100%; margin: 0; }
      body {
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        display: flex; align-items: center; justify-content: center;
        background: #0b1220; color: #e6edf7; text-align: center; padding: 24px;
      }
      .card { max-width: 420px; }
      h1 { font-size: 20px; margin: 0 0 8px; }
      p { margin: 0 0 20px; opacity: 0.8; line-height: 1.5; }
      a.btn {
        display: inline-block; padding: 12px 20px; border-radius: 10px;
        background: #4f46e5; color: white; text-decoration: none; font-weight: 600;
      }
      .spinner {
        width: 28px; height: 28px; border-radius: 50%;
        border: 3px solid rgba(255,255,255,0.2); border-top-color: #4f46e5;
        animation: spin 0.9s linear infinite; margin: 0 auto 16px;
      }
      @keyframes spin { to { transform: rotate(360deg); } }
    </style>
  </head>
  <body>
    <div class="card">
      <div class="spinner" aria-hidden="true"></div>
      <h1>${escapeHtml(heading)}</h1>
      <p>${escapeHtml(message)}</p>
      <a class="btn" href="${safeFallback}">Open the app</a>
    </div>
    <script>
      // Trigger the deep link as soon as the page loads. Most mobile browsers
      // honour this when the navigation is initiated by the page itself
      // (rather than from inside a sandboxed iframe like Paystack's checkout).
      (function () {
        var target = '${safeDeep}';
        try { window.location.replace(target); } catch (e) { window.location.href = target; }
      })();
    </script>
  </body>
</html>`;
}

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const reference = url.searchParams.get('reference') || url.searchParams.get('trxref') || '';

  // Default fallback if anything below fails: send the user to the frontend.
  const frontendFallback = `${config.platform.frontendUrl}/payment/callback${
    reference ? `?reference=${encodeURIComponent(reference)}` : ''
  }`;

  if (!reference) {
    return new NextResponse(
      renderBouncePage(frontendFallback, frontendFallback, 'failed'),
      { status: 400, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    );
  }

  let returnDeepLink: string | null = null;
  let paymentStatus: 'success' | 'failed' = 'failed';

  // 1. Pull metadata from Paystack so we know where to bounce the user.
  //    We do this even if our local verify fails so the app still gets the
  //    reference and can decide what to show.
  try {
    const verifyResp = await paystack.verifyTransaction(reference);
    const meta = verifyResp?.data?.metadata as Record<string, any> | undefined;
    if (meta && typeof meta.returnDeepLink === 'string' && meta.returnDeepLink.length > 0) {
      returnDeepLink = meta.returnDeepLink;
    }
    if (verifyResp?.data?.status === 'success') {
      paymentStatus = 'success';
    }
  } catch (err) {
    console.error('Paystack callback bridge: verifyTransaction failed', err);
  }

  // 2. Run our own verifyPayment so Payment + Booking statuses are updated
  //    before the app reopens (idempotent — webhook firing later is safe).
  try {
    await verifyPayment(reference);
  } catch (err) {
    console.error('Paystack callback bridge: verifyPayment failed', err);
    // Continue — bouncing back to the app is more important than
    // surfacing this error here. The webhook will retry.
  }

  // 3. Build the deep link to bounce to. If we couldn't recover one from
  //    metadata, fall back to the frontend URL so the user isn't stranded.
  const finalLink = returnDeepLink
    ? `${returnDeepLink}${returnDeepLink.includes('?') ? '&' : '?'}reference=${encodeURIComponent(reference)}&status=${paymentStatus}`
    : frontendFallback;

  return new NextResponse(
    renderBouncePage(finalLink, finalLink, paymentStatus),
    { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
  );
}
