// HTTP hardening for every response: security headers, a Content-Security-Policy and a cap on
// request bodies. The board is a single-origin app with no inline script, so its policy is strict.
import { randomBytes } from 'node:crypto'
import type { MiddlewareHandler } from 'hono'
import { bodyLimit } from 'hono/body-limit'

// Styles stay 'unsafe-inline': the UI sets style attributes (chart colours, widths) at runtime.
export const BOARD_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ')

/** The public showcase page carries its script and styles inline, allowed by a nonce per response. */
export const showcaseCsp = (nonce: string) =>
  [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    `style-src 'nonce-${nonce}'`,
    "img-src 'self'",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ')

export const newNonce = () => randomBytes(16).toString('base64')

const HEADERS: Record<string, string> = {
  'content-security-policy': BOARD_CSP,
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'same-origin',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
}

/** Sets the headers on every response. A route that sets one itself (the showcase CSP) keeps its own. */
export const securityHeaders: MiddlewareHandler = async (c, next) => {
  await next()
  const headers = c.res.headers
  for (const [name, value] of Object.entries(HEADERS)) if (!headers.has(name)) headers.set(name, value)
}

// The largest legitimate bodies are blueprints and issue texts (capped at 20 000 chars each).
export const MAX_BODY_BYTES = 1024 * 1024

export const limitBody = bodyLimit({
  maxSize: MAX_BODY_BYTES,
  onError: (c) => c.json({ error: 'Request too large (max. 1 MB)' }, 413),
})
