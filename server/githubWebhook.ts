// GitHub webhooks: GitHub tells AgentDeck when checks finish or a pull request closes, so a waiting
// pull request is settled within seconds instead of at the next poll. Only signed deliveries
// count (X-Hub-Signature-256, HMAC-SHA256 over the raw body with a shared secret). A delivery only
// names where to look: the decision is made by asking GitHub again (landing.ts), so even a
// signed but odd payload cannot land anything by itself.
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { t } from './i18n.ts'
import { takeGithubIssue } from './intake.ts'
import { nudgePullRequests, waitingIssuesFor, webhookArrived } from './landing.ts'

/** GitHub caps payloads at 25 MB, but the events used here are far smaller. */
const MAX_BODY = 5 * 1024 * 1024

/** True when header is the HMAC-SHA256 of body under secret, compared in constant time. */
export function verifySignature(secret: string, body: Uint8Array, header: string | undefined) {
  if (!secret || !header || !/^sha256=[0-9a-f]{64}$/.test(header)) return false
  const wanted = Buffer.from(createHmac('sha256', secret).update(body).digest('hex'))
  return timingSafeEqual(wanted, Buffer.from(header.slice(7)))
}

export type Target = { branch: string; pr?: number }

const branchName = (value: unknown) =>
  typeof value === 'string' && value.length > 0 && value.length <= 255 ? value : ''
const prNumber = (value: unknown) =>
  Number.isSafeInteger(value) && (value as number) > 0 ? (value as number) : undefined

/** The pull requests a check result belongs to, or its branch when GitHub lists none. */
function fromPullRequests(list: unknown, headBranch: unknown): Target[] {
  const targets: Target[] = []
  for (const pr of Array.isArray(list) ? list.slice(0, 50) : []) {
    const branch = branchName(pr?.head?.ref)
    if (branch) targets.push({ branch, pr: prNumber(pr?.number) })
  }
  const head = branchName(headBranch)
  if (!targets.length && head) targets.push({ branch: head })
  return targets
}

/**
 * Where an event asks AgentDeck to look. Only events that can end the wait count: a finished
 * check, a final commit status, a closed pull request. Everything else (queued and running checks,
 * comments, pushes) is ignored, so a push with twenty checks costs one look per finished check.
 */
export function webhookTargets(event: string, payload: any): Target[] {
  switch (event) {
    case 'pull_request': {
      if (payload?.action !== 'closed') return []
      const branch = branchName(payload.pull_request?.head?.ref)
      return branch ? [{ branch, pr: prNumber(payload.pull_request?.number) }] : []
    }
    case 'check_suite':
      if (payload?.action !== 'completed') return []
      return fromPullRequests(payload.check_suite?.pull_requests, payload.check_suite?.head_branch)
    case 'check_run':
      if (payload?.action !== 'completed') return []
      return fromPullRequests(payload.check_run?.pull_requests, payload.check_run?.check_suite?.head_branch)
    case 'status': {
      if (payload?.state === 'pending') return []
      const branches = Array.isArray(payload?.branches) ? payload.branches.slice(0, 50) : []
      return branches.map((b: any) => branchName(b?.name)).filter(Boolean).map((branch: string) => ({ branch }))
    }
    default:
      return []
  }
}

/**
 * Bad signatures per address. A sender that keeps failing is turned away before its body is read
 * or hashed, so guessing costs it more than it costs the server.
 */
const FAIL_WINDOW = 10 * 60_000
const MAX_FAILS = 20
export function failureLimiter(now = () => Date.now()) {
  const fails = new Map<string, { count: number; since: number }>()
  return {
    blocked(address: string) {
      const entry = fails.get(address)
      if (!entry) return false
      if (now() - entry.since > FAIL_WINDOW) {
        fails.delete(address)
        return false
      }
      return entry.count >= MAX_FAILS
    },
    failed(address: string) {
      if (fails.size > 10_000) {
        for (const [key, entry] of fails) if (now() - entry.since > FAIL_WINDOW) fails.delete(key)
        if (fails.size > 10_000) fails.clear() // still full: forget rather than grow without bound
      }
      const entry = fails.get(address)
      if (entry && now() - entry.since <= FAIL_WINDOW) entry.count++
      else fails.set(address, { count: 1, since: now() })
    },
  }
}

type Handler = (issueIds: number[]) => void

/** The peer address. Behind a reverse proxy all deliveries share one, and so share the limit. */
const addressOf = (c: any): string => c.env?.incoming?.socket?.remoteAddress ?? 'unknown'

/**
 * The webhook route: finished checks wake waiting pull requests, labelled issues are filed
 * (intake.ts). secret empty: webhooks are off and the route does not exist (404).
 * It sits in front of the board login: GitHub authenticates with the signature alone.
 */
export function webhookApp(
  secret: string,
  handle: Handler = nudgePullRequests,
  takeIssue: (payload: unknown) => void = takeGithubIssue,
) {
  const app = new Hono()
  const limiter = failureLimiter()
  app.post(
    '/webhook',
    async (c, next) => {
      if (!secret) return c.json({ error: t('Webhook nicht eingerichtet') }, 404)
      if (limiter.blocked(addressOf(c))) return c.json({ error: t('zu viele ungültige Anfragen') }, 429)
      return next()
    },
    bodyLimit({ maxSize: MAX_BODY, onError: (c) => c.json({ error: t('zu groß') }, 413) }),
    async (c) => {
      const raw = new Uint8Array(await c.req.arrayBuffer())
      if (!verifySignature(secret, raw, c.req.header('x-hub-signature-256'))) {
        limiter.failed(addressOf(c))
        return c.json({ error: 'unauthorized' }, 401)
      }
      const event = c.req.header('x-github-event') ?? ''
      let payload: unknown
      try {
        payload = JSON.parse(Buffer.from(raw).toString('utf8'))
      } catch {
        return c.json({ error: t('JSON erwartet') }, 400)
      }
      if (event === 'issues') {
        takeIssue(payload)
        return c.json({ ok: true })
      }
      // Only now: a hook that sends nothing but issues must not slow down the pull request poll.
      webhookArrived()
      const ids = waitingIssuesFor(webhookTargets(event, payload))
      if (ids.length) handle(ids)
      return c.json({ ok: true })
    },
  )
  return app
}

/** The secret from the environment; too short a secret is refused, as for the proxy secret. */
export function webhookSecret(value = process.env.AGENTDECK_GITHUB_WEBHOOK_SECRET ?? '') {
  if (value && value.length < 16) {
    console.error('AGENTDECK_GITHUB_WEBHOOK_SECRET ist kürzer als 16 Zeichen, GitHub-Webhooks bleiben aus.')
    return ''
  }
  return value
}
