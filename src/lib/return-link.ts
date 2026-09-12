/**
 * Where a customer may be sent after Paystack checkout: the bridge's return
 * link, and the page Paystack itself redirects to on the web
 */

import { config } from '@/config';

const DEFAULT_APP_SCHEMES = ['easykonnect', 'easykonnet'];

const ownOrigins = () =>
  [config.platform.frontendUrl, config.platform.backendUrl]
    .map((url) => {
      try {
        return new URL(url).origin;
      } catch {
        return null;
      }
    })
    .filter((origin): origin is string => Boolean(origin));

/**
 * One of the app's URL schemes, or a page on our own site. Anything else would
 * let the bridge redirect to an arbitrary site, or run script on our domain.
 */
export const isAllowedReturnLink = (link: string): boolean => {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return false;
  }

  const scheme = url.protocol.slice(0, -1).toLowerCase();

  if (scheme === 'http' || scheme === 'https') {
    return ownOrigins().includes(url.origin);
  }

  const appSchemes = config.platform.appUrlSchemes ?? DEFAULT_APP_SCHEMES;
  return appSchemes.includes(scheme);
};

/**
 * A page on our own site (FRONTEND_URL or BACKEND_URL origin). Paystack
 * redirects the browser straight to a callbackUrl, so anything else would send
 * customers, with their payment reference, to another site.
 */
export const isAllowedCallbackUrl = (link: string): boolean => {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return false;
  }

  return (url.protocol === 'https:' || url.protocol === 'http:') && ownOrigins().includes(url.origin);
};
