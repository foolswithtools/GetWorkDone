// Security response headers (GWP#48, docs/security.md): one fixed set on every response the API sends,
// registered in createApp before the static files, so the built JS and CSS, every Nest route, the SPA
// fallback and the guards' 401 and 403 answers all carry it. Enforced from the first deploy: no
// report-only phase, no report endpoint, no switch. Not helmet: these are fixed strings.
//
// The policy admits the request-4-change widget as its contract stands (spec §4.2): /__r4c/widget.js is
// a same-origin module script (script-src 'self') and its calls to /__r4c/ are same-origin
// (connect-src 'self'). docs/security.md holds the policy verbatim; headers.test.ts compares the two.

import type { RequestHandler } from 'express';

export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

export const SECURITY_HEADERS: Record<string, string> = {
  // No preload: the hostnames sit under the platform's shared zone, whose owner decides that.
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'Content-Security-Policy': CONTENT_SECURITY_POLICY,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  // The legacy twin of frame-ancestors 'none'.
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

/** Sets every header in SECURITY_HEADERS on the response, then hands on. */
export function securityHeaders(): RequestHandler {
  const headers = Object.entries(SECURITY_HEADERS);
  return (_req, res, next) => {
    for (const [name, value] of headers) res.setHeader(name, value);
    next();
  };
}
