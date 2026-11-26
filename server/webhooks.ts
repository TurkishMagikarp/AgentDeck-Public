// Webhooks: tells Slack or any HTTP endpoint when an issue changes status, besides push and mail.
// The URL and signing secret of each webhook live encrypted in the secrets table, never in the
// project settings: those go to the UI with every board load, and a Slack URL is itself a key.
// Every request goes through an SSRF check: an agent can make issues change status at will, so a
// webhook must never be a way to reach the server's own network.
import { createHmac, randomBytes } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import http from 'node:http'
import https from 'node:https'
import { BlockList, isIP } from 'node:net'
import { getSecret, setSecret } from './auth.ts'
import { getProject, onStatusChange, WEBHOOK_EVENTS, type WebhookEvent } from './core.ts'
import { get } from './db.ts'
import { forProject, t } from './i18n.ts'

export type Webhook = { id: string; kind: 'slack' | 'generic'; host: string; events: WebhookEvent[] }
type Target = { pid: number; url: string; secret: string }
type Item = {
  event: WebhookEvent
  issue: { number: number; title: string }
  oldStatus: string | null
  newStatus: string | null
  at: number
}

const TIMEOUT_MS = 5_000
const MAX_ATTEMPTS = 3
const MAX_BATCH = 50
/** Mutable for the tests: how long a burst is collected, and the first retry delay. */
export const timing = { coalesceMs: 2_000, backoffMs: 1_000 }

const PUBLIC_URL = (process.env.AGENTDECK_PUBLIC_URL ?? '').replace(/\/$/, '')
/** Plain http to localhost only for local tests, like the open API. Read late so tests can set it. */
const allowLocal = () => process.env.AGENTDECK_ALLOW_OPEN === '1' || process.env.AGENTDECK_MOCK === '1'
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1'])

// German keys, translated where a message is built (slackBody).
const STATUS_LABEL: Record<string, string> = {
  backlog: 'Backlog',
  todo: 'To Do',
  in_progress: 'In Arbeit',
  review: 'Review',
  blocked: 'Blockiert',
  done: 'Erledigt',
}
export const EVENT_LABEL: Record<WebhookEvent, string> = {
  review: 'Zur Prüfung',
  blocked: 'Blockiert',
  done: 'Erledigt',
  failed: 'Lauf fehlgeschlagen',
  owner: 'Wartet auf dich',
}

// ---------- SSRF guard ----------

// Everything that is not the public internet: loopback, private, link-local (cloud metadata),
// carrier NAT, multicast, reserved, documentation ranges, and IPv6 forms that embed IPv4.
// Two lists: a BlockList matches IPv4 addresses against IPv4-mapped IPv6 rules too, so the
// ::ffff:0:0/96 rule in one shared list would refuse every IPv4 address.
const blocked4 = new BlockList()
const blocked6 = new BlockList()
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  blocked4.addSubnet(net, prefix, 'ipv4')
for (const [net, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['::ffff:0:0', 96],
  ['::', 96],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 32],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
] as const)
  blocked6.addSubnet(net, prefix, 'ipv6')
const loopback = new BlockList()
loopback.addSubnet('127.0.0.0', 8, 'ipv4')
loopback.addAddress('::1', 'ipv6')

/** True for any address a webhook must not reach. Anything that is not an IP is refused too. */
export function isBlockedAddress(address: string, local = false) {
  const family = isIP(address)
  if (!family) return true
  const type = family === 4 ? 'ipv4' : 'ipv6'
  if (local && loopback.check(address, type)) return false
  return family === 4 ? blocked4.check(address, 'ipv4') : blocked6.check(address, 'ipv6')
}

/** An address a webhook may not use. Trying again does not change that, so it is never retried. */
class Refused extends Error {}

/** Parses and checks a webhook URL without the network. Throws a message for the person. */
export function checkUrl(raw: string, local = allowLocal()) {
  if (typeof raw !== 'string' || raw.length > 2048) throw new Refused(t('Ungültige Webhook-Adresse'))
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    throw new Refused(t('Ungültige Webhook-Adresse'))
  }
  if (url.username || url.password) throw new Error(t('Zugangsdaten gehören nicht in die Webhook-Adresse'))
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (!host) throw new Refused(t('Ungültige Webhook-Adresse'))
  const isLocal = local && LOCAL_HOSTS.has(host)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocal))
    throw new Refused(t('Nur https-Adressen sind erlaubt'))
  if (isIP(host) && isBlockedAddress(host, isLocal))
    throw new Refused(t('Adresse im privaten Netz ist nicht erlaubt'))
  return { url, host, isLocal }
}

/**
 * Resolves the host and checks every address it has: one private address among public ones
 * is enough to refuse, since the connection could pick either. Returns the address to connect to.
 */
export async function resolveChecked(host: string, local: boolean) {
  const addresses = isIP(host)
    ? [{ address: host, family: isIP(host) }]
    : await lookup(host, { all: true, verbatim: true })
  if (!addresses.length) throw new Error(t('Host nicht gefunden'))
  for (const { address } of addresses)
    if (isBlockedAddress(address, local)) throw new Refused(t('Adresse im privaten Netz ist nicht erlaubt'))
  return addresses[0]
}

/**
 * One POST, at most 5 s, no redirects. The socket connects to the address that was checked:
 * the lookup hook hands it over, so a second DNS answer (rebinding) never gets a say.
 */
export async function post(raw: string, body: string, headers: Record<string, string>): Promise<number> {
  const { url, host, isLocal } = checkUrl(raw)
  const target = await resolveChecked(host, isLocal)
  const client = url.protocol === 'https:' ? https : http
  const timedOut = t('Zeitüberschreitung (5 s)')
  return new Promise((resolve, reject) => {
    const req = client.request(
      {
        method: 'POST',
        protocol: url.protocol,
        hostname: host,
        port: url.port || undefined,
        path: url.pathname + url.search,
        agent: false,
        headers: { ...headers, 'content-length': String(Buffer.byteLength(body)) },
        lookup: ((_host: string, options: any, callback: any) => {
          if (options?.all) callback(null, [{ address: target.address, family: target.family }])
          else callback(null, target.address, target.family)
        }) as any,
      },
      (res) => {
        res.resume() // the answer is not read, only its status
        resolve(res.statusCode ?? 0)
      },
    )
    const timer = setTimeout(() => req.destroy(new Error(timedOut)), TIMEOUT_MS)
    req.on('error', reject)
    req.on('close', () => clearTimeout(timer))
    req.end(body)
  })
}

// ---------- payloads ----------

export const sign = (secret: string, body: string) => 'sha256=' + createHmac('sha256', secret).update(body).digest('hex')

const link = (key: string, number: number) => (PUBLIC_URL ? `${PUBLIC_URL}/#${key}-${number}` : null)
const slackEscape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** Only fixed facts: key, number, title, statuses. No comments or run output, they can hold code or secrets. */
export function genericBody(projectKey: string, items: Item[]) {
  return JSON.stringify({
    project: projectKey,
    sentAt: Date.now(),
    events: items.map((item) => ({ ...item, link: link(projectKey, item.issue.number) })),
  })
}

export function slackBody(projectKey: string, items: Item[]) {
  const lines = items.map((item) => {
    const ref = `${projectKey}-${item.issue.number}`
    const url = link(projectKey, item.issue.number)
    const name = url ? `<${url}|${ref}>` : ref
    const status = (value: string) => (STATUS_LABEL[value] ? t(STATUS_LABEL[value]) : value)
    const move = item.oldStatus && item.newStatus ? ` (${status(item.oldStatus)} → ${status(item.newStatus)})` : ''
    return `*${t(EVENT_LABEL[item.event])}*: ${name} ${slackEscape(item.issue.title)}${move}`
  })
  return JSON.stringify({ text: lines.join('\n') })
}

// ---------- targets: URL and secret, decrypted once ----------

const targets = new Map<string, Target | null>()
const secretName = (id: string) => `webhook.${id}`

function targetOf(id: string): Target | null {
  if (!targets.has(id)) {
    const stored = getSecret(secretName(id))
    targets.set(id, stored ? JSON.parse(stored) : null)
  }
  return targets.get(id)!
}

/** Stores a new webhook's URL with a fresh secret. The secret is returned here and never again. */
export function createWebhook(pid: number, input: { url?: unknown; kind?: unknown; events?: unknown }) {
  const { url } = checkUrl(String(input.url ?? ''))
  const kind: Webhook['kind'] = input.kind === 'slack' ? 'slack' : 'generic'
  const events = WEBHOOK_EVENTS.filter((e) => Array.isArray(input.events) && input.events.includes(e))
  if (!events.length) throw new Error(t('Mindestens ein Ereignis wählen'))
  const id = randomBytes(8).toString('hex')
  const secret = randomBytes(32).toString('hex')
  const target: Target = { pid, url: url.href, secret }
  setSecret(secretName(id), JSON.stringify(target))
  targets.set(id, target)
  const webhook: Webhook = { id, kind, host: url.host, events }
  return { webhook, secret: kind === 'generic' ? secret : undefined }
}

export function deleteWebhook(id: string) {
  setSecret(secretName(id), '')
  targets.delete(id)
  pending.delete(id)
}

// ---------- queue: bursts coalesce per webhook, sending never blocks the caller ----------

type Batch = { pid: number; projectKey: string; hook: Webhook; items: Map<string, Item>; timer: NodeJS.Timeout }
const pending = new Map<string, Batch>()

/** Which events of the project's webhooks want this one. Pure, for the tests. */
export const wanting = (hooks: Webhook[], event: WebhookEvent) => hooks.filter((hook) => hook.events.includes(event))

/** The status a move leads to is the event, for the three statuses a person cares about. */
export const statusEvent = (status: string): WebhookEvent | null =>
  status === 'review' || status === 'blocked' || status === 'done' ? status : null

export function notifyWebhooks(
  pid: number,
  issue: { number: number; title: string },
  event: WebhookEvent,
  oldStatus: string | null = null,
  newStatus: string | null = null,
) {
  const project = getProject(pid)
  const hooks = wanting(project?.settings.webhooks ?? [], event)
  if (!hooks.length) return
  const item: Item = {
    event,
    issue: { number: issue.number, title: String(issue.title ?? '').slice(0, 200) },
    oldStatus,
    newStatus,
    at: Date.now(),
  }
  for (const hook of hooks) {
    let batch = pending.get(hook.id)
    if (!batch) {
      const timer = setTimeout(() => flush(hook.id), timing.coalesceMs)
      timer.unref()
      batch = { pid, projectKey: project.key, hook, items: new Map(), timer }
      pending.set(hook.id, batch)
    }
    // The same issue and event twice in one burst (blocked, freed, blocked again) is told once.
    const key = `${issue.number}:${event}`
    batch.items.delete(key)
    batch.items.set(key, item)
    if (batch.items.size > MAX_BATCH) batch.items.delete(batch.items.keys().next().value!)
  }
}

function flush(id: string) {
  const batch = pending.get(id)
  if (!batch) return
  pending.delete(id)
  // The receiver reads the message in the project's language, whoever moved the issue.
  forProject(getProject(batch.pid), () => send(batch.hook, batch.pid, batch.projectKey, [...batch.items.values()])).catch(
    (error) => console.error('webhook', batch.hook.host, error.message),
  )
}

/** Builds the request for a webhook. Null when its target is gone or belongs to another project. */
export function request(hook: Webhook, pid: number, projectKey: string, items: Item[]) {
  const target = targetOf(hook.id)
  if (!target || target.pid !== pid) return null
  const headers: Record<string, string> = { 'content-type': 'application/json', 'user-agent': 'AgentDeck-Webhook' }
  if (hook.kind === 'slack') return { url: target.url, body: slackBody(projectKey, items), headers }
  const body = genericBody(projectKey, items)
  headers['x-agentdeck-signature'] = sign(target.secret, body)
  return { url: target.url, body, headers }
}

/** 2xx is done; 4xx other than 429 and refused addresses will not get better, so no retry. */
async function send(hook: Webhook, pid: number, projectKey: string, items: Item[]) {
  const req = request(hook, pid, projectKey, items)
  if (!req) return
  for (let attempt = 1; ; attempt++) {
    let retry = true
    let reason = ''
    try {
      const status = await post(req.url, req.body, req.headers)
      if (status >= 200 && status < 300) return
      reason = `HTTP ${status}`
      retry = status >= 500 || status === 429
    } catch (error: any) {
      reason = error.message
      retry = !(error instanceof Refused)
    }
    if (!retry || attempt >= MAX_ATTEMPTS)
      throw new Error(t('{reason} nach {attempt} Versuch(en)', { reason, attempt }))
    await new Promise((resolve) => setTimeout(resolve, timing.backoffMs * 4 ** (attempt - 1)).unref())
  }
}

/** The test button: one request right away, no queue, no retry. Returns the HTTP status. */
export async function testWebhook(pid: number, hook: Webhook) {
  const project = getProject(pid)
  // The message itself is in the project's language, the errors in the language of who pressed the button.
  const req = forProject(project, () =>
    request(hook, pid, project.key, [
      {
        event: hook.events[0] ?? 'done',
        issue: { number: 0, title: t('Test von AgentDeck') },
        oldStatus: null,
        newStatus: null,
        at: Date.now(),
      },
    ]),
  )
  if (!req) throw new Error(t('Webhook nicht gefunden, bitte neu anlegen'))
  const status = await post(req.url, req.body, req.headers)
  if (status < 200 || status >= 300) throw new Error(t('Der Empfänger antwortet mit HTTP {status}', { status }))
  return status
}

/** A run failed: told with the issue as it is now. */
export function runFailed(pid: number, issueId: number) {
  const issue = get('SELECT number, title, status FROM issues WHERE id=?', issueId)
  if (issue) notifyWebhooks(pid, issue, 'failed')
}

// Status moves come from patchIssue, wherever the change was made (engine, UI, agent API).
onStatusChange((issue, oldStatus, newStatus) => {
  const event = statusEvent(newStatus)
  if (event) notifyWebhooks(issue.project_id, issue, event, oldStatus, newStatus)
})
