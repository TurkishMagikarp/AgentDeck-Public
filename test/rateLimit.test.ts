import './setup.ts'
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { Hono } from 'hono'
import { addressKey, clientKey, FailureLimiter } from '../server/rateLimit.ts'

describe('FailureLimiter', () => {
  const limiter = () => new FailureLimiter({ capacity: 3, refillMs: 60_000 }, { capacity: 10, refillMs: 6_000 }, 100)

  test('lets a client try until its bucket is empty, then names the wait', () => {
    const l = limiter()
    for (let i = 0; i < 3; i++) {
      assert.equal(l.retryAfter('a', 0), 0)
      l.fail('a', 0)
    }
    assert.equal(l.retryAfter('a', 0), 60)
    assert.equal(l.retryAfter('a', 30_000), 30)
    assert.equal(l.retryAfter('a', 60_000), 0)
  })

  test('one client does not block another, unless the overall budget is used up', () => {
    const l = limiter()
    for (let i = 0; i < 3; i++) l.fail('a', 0)
    assert.equal(l.retryAfter('b', 0), 0)
    for (let i = 0; i < 7; i++) l.fail(`c${i}`, 0)
    assert.equal(l.retryAfter('fresh', 0), 6)
    assert.equal(l.retryAfter('fresh', 6_000), 0)
  })

  test('a client without failures waits for nothing', () => {
    assert.equal(limiter().retryAfter('nobody'), 0)
  })

  test('keeps at most maxKeys clients', () => {
    const l = new FailureLimiter({ capacity: 3, refillMs: 60_000 }, { capacity: 1e9, refillMs: 1 }, 5)
    for (let i = 0; i < 20; i++) l.fail(`k${i}`, 0)
    assert.equal((l as any).buckets.size, 5)
    assert.ok((l as any).buckets.has('k19'))
  })
})

describe('addressKey', () => {
  test('IPv4 stays, mapped IPv4 loses its prefix', () => {
    assert.equal(addressKey('203.0.113.7'), '203.0.113.7')
    assert.equal(addressKey('::ffff:203.0.113.7'), '203.0.113.7')
  })
  test('IPv6 counts by its /64', () => {
    assert.equal(addressKey('2001:db8:0:1::5'), '2001:db8:0:1::/64')
    assert.equal(addressKey('2001:0db8:0000:0001:aaaa:bbbb:cccc:dddd'), '2001:db8:0:1::/64')
    assert.equal(addressKey('::1'), '0:0:0:0::/64')
  })
})

describe('clientKey', () => {
  const app = new Hono()
  app.get('/trusted', (c) => c.text(clientKey(c, true)))
  app.get('/direct', (c) => c.text(clientKey(c, false)))

  test('believes X-Real-IP only through the trusted proxy', async () => {
    const headers = { 'x-real-ip': '198.51.100.4' }
    assert.equal(await (await app.request('/trusted', { headers })).text(), '198.51.100.4')
    assert.equal(await (await app.request('/direct', { headers })).text(), 'unknown')
  })
})
