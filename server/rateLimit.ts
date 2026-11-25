// Brakes for guessing the board token. Only attempts with the raw token count (login form, Bearer
// header): the session cookie is a SHA-256 hash and cannot be guessed, so an owner who is logged
// in is never locked out. Run tokens are 192 random bits and every agent calls from the same local
// address, so limiting them would only let one agent with an expired token block all the others.
import type { Context } from 'hono'
import { getConnInfo } from '@hono/node-server/conninfo'

type Bucket = { tokens: number; at: number }
type Rule = { capacity: number; refillMs: number }

export class FailureLimiter {
  private buckets = new Map<string, Bucket>()
  private global: Bucket
  private perClient: Rule
  private overall: Rule
  private maxKeys: number

  constructor(
    perClient: Rule = { capacity: 10, refillMs: 60_000 },
    overall: Rule = { capacity: 100, refillMs: 6_000 },
    maxKeys = 10_000,
  ) {
    this.perClient = perClient
    this.overall = overall
    this.maxKeys = maxKeys
    this.global = { tokens: overall.capacity, at: 0 }
  }

  private level(bucket: Bucket, rule: Rule, now: number) {
    return Math.min(rule.capacity, bucket.tokens + (now - bucket.at) / rule.refillMs)
  }

  private wait(bucket: Bucket | undefined, rule: Rule, now: number) {
    if (!bucket) return 0
    const level = this.level(bucket, rule, now)
    return level >= 1 ? 0 : Math.ceil(((1 - level) * rule.refillMs) / 1000)
  }

  /** Seconds the client has to wait before its next attempt; 0 when it may try now. */
  retryAfter(key: string, now = Date.now()) {
    return Math.max(this.wait(this.buckets.get(key), this.perClient, now), this.wait(this.global, this.overall, now))
  }

  /** Records a failed attempt. */
  fail(key: string, now = Date.now()) {
    const bucket = this.buckets.get(key)
    const level = bucket ? this.level(bucket, this.perClient, now) : this.perClient.capacity
    this.buckets.delete(key) // re-inserted at the end: the map stays ordered by last failure
    this.buckets.set(key, { tokens: level - 1, at: now })
    this.global = { tokens: this.level(this.global, this.overall, now) - 1, at: now }
    if (this.buckets.size > this.maxKeys) this.prune(now)
  }

  private prune(now: number) {
    for (const [key, bucket] of this.buckets)
      if (this.level(bucket, this.perClient, now) >= this.perClient.capacity) this.buckets.delete(key)
    // Still too many: drop the clients whose last failure is oldest.
    for (const key of this.buckets.keys()) {
      if (this.buckets.size <= this.maxKeys) break
      this.buckets.delete(key)
    }
  }
}

/** IPv4 as is, IPv6 by its /64, so one host cannot rotate through its addresses. */
export function addressKey(address: string) {
  const plain = address.trim().replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, '')
  if (!plain.includes(':')) return plain
  const [head, tail = ''] = plain.toLowerCase().split('::')
  const left = head ? head.split(':') : []
  const right = plain.includes('::') && tail ? tail.split(':') : []
  const groups = [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right]
  return groups.slice(0, 4).map((group) => group.replace(/^0+(?=.)/, '')).join(':') + '::/64'
}

/**
 * The client behind a request. X-Real-IP is only believed when the request comes through the
 * trusted proxy (it carries the proxy secret); anyone else could send any address.
 */
export function clientKey(c: Context, viaProxy: boolean) {
  const forwarded = viaProxy ? c.req.header('x-real-ip') : undefined
  if (forwarded) return addressKey(forwarded)
  try {
    return addressKey(getConnInfo(c).remote.address ?? 'unknown')
  } catch {
    return 'unknown'
  }
}
