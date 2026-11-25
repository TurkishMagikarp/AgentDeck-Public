/**
 * Cross-site request forgery guard for browser sessions that sit behind a proxy login (Authelia):
 * the cookie travels with every request the browser makes, so a page on another site could make
 * the browser post to us. Browsers name the page's origin on such writes; if it is not our own
 * host, the write is refused. Requests without an Origin header (curl, the agents, scripts) and
 * requests with a bearer token do not come from a browser session and pass.
 */
const WRITES = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

export function isCrossSiteWrite(
  method: string,
  header: (name: string) => string | undefined,
): boolean {
  if (!WRITES.has(method.toUpperCase())) return false
  // A bearer call without a session cookie is not a browser session. With a cookie present, the
  // header proves nothing: the browser would send the cookie along.
  if (header('authorization') && !header('cookie')) return false

  // Modern browsers say it themselves, and no proxy setup can break this: trust it first.
  const site = header('sec-fetch-site')
  if (site === 'same-origin') return false
  if (site === 'cross-site' || site === 'same-site') return true

  const origin = header('origin')
  if (!origin) return false
  let originHost: string
  try {
    originHost = new URL(origin).host
  } catch {
    // "null" and other opaque origins come from sandboxed frames and file pages: never ours.
    return true
  }

  const ours = [header('host'), header('x-forwarded-host')]
    .flatMap((value) => (value ?? '').split(','))
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
  return !ours.includes(originHost.toLowerCase())
}
