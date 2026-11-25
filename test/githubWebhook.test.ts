import './setup.ts'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { describe, test } from 'node:test'
import { run } from '../server/db.ts'
import { failureLimiter, verifySignature, webhookApp, webhookTargets } from '../server/githubWebhook.ts'
import { pollInterval, waitingIssuesFor } from '../server/landing.ts'

const SECRET = 'a-webhook-secret-of-some-length'
const sign = (body: string, secret = SECRET) => 'sha256=' + createHmac('sha256', secret).update(body).digest('hex')

function deliver(app: ReturnType<typeof webhookApp>, event: string, payload: unknown, signature?: string) {
  const body = JSON.stringify(payload)
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-github-event': event }
  const sig = signature ?? sign(body)
  if (sig) headers['x-hub-signature-256'] = sig
  return app.request('/webhook', { method: 'POST', headers, body })
}

// One project with a pull request that waits, and one issue of it that does not.
const project = Number(
  run("INSERT INTO projects (key, name, settings, created_at) VALUES ('WH-X', 'Webhooks', '{}', ?)", Date.now())
    .lastInsertRowid,
)
const waiting = Number(
  run(
    "INSERT INTO issues (project_id, number, title, created_at, updated_at, landing, pr_number) VALUES (?, 3, 'w', 0, 0, 'waiting', 9)",
    project,
  ).lastInsertRowid,
)
run("INSERT INTO issues (project_id, number, title, created_at, updated_at, landing, pr_number) VALUES (?, 4, 'n', 0, 0, '', 10)", project)

describe('signature', () => {
  test('only the HMAC of the raw body under the secret passes', () => {
    const body = new TextEncoder().encode('{"a":1}')
    assert.equal(verifySignature(SECRET, body, sign('{"a":1}')), true)
    assert.equal(verifySignature(SECRET, body, sign('{"a":2}')), false)
    assert.equal(verifySignature(SECRET, body, sign('{"a":1}', 'another-secret-entirely')), false)
    assert.equal(verifySignature(SECRET, body, undefined), false)
    assert.equal(verifySignature(SECRET, body, 'sha1=abc'), false)
    assert.equal(verifySignature(SECRET, body, sign('{"a":1}').toUpperCase()), false)
    assert.equal(verifySignature('', body, sign('{"a":1}', '')), false)
  })
})

describe('event routing', () => {
  test('finished checks, final statuses and closed pull requests name their branch', () => {
    const pr = { number: 9, head: { ref: 'agentdeck/WH-X-3' } }
    assert.deepEqual(webhookTargets('check_suite', { action: 'completed', check_suite: { pull_requests: [pr], head_branch: 'x' } }), [
      { branch: 'agentdeck/WH-X-3', pr: 9 },
    ])
    assert.deepEqual(
      webhookTargets('check_run', { action: 'completed', check_run: { pull_requests: [], check_suite: { head_branch: 'agentdeck/WH-X-3' } } }),
      [{ branch: 'agentdeck/WH-X-3' }],
    )
    assert.deepEqual(webhookTargets('status', { state: 'success', branches: [{ name: 'agentdeck/WH-X-3' }, { name: 42 }] }), [
      { branch: 'agentdeck/WH-X-3' },
    ])
    assert.deepEqual(webhookTargets('pull_request', { action: 'closed', pull_request: pr }), [{ branch: 'agentdeck/WH-X-3', pr: 9 }])
  })

  test('events that cannot end the wait are ignored', () => {
    assert.deepEqual(webhookTargets('check_run', { action: 'created', check_run: {} }), [])
    assert.deepEqual(webhookTargets('status', { state: 'pending', branches: [{ name: 'agentdeck/WH-X-3' }] }), [])
    assert.deepEqual(webhookTargets('pull_request', { action: 'synchronize', pull_request: {} }), [])
    assert.deepEqual(webhookTargets('push', { ref: 'refs/heads/main' }), [])
    assert.deepEqual(webhookTargets('check_suite', null), [])
  })

  test('a branch finds its waiting issue; another pull request number or a settled issue does not', () => {
    assert.deepEqual(waitingIssuesFor([{ branch: 'agentdeck/WH-X-3' }]), [waiting])
    assert.deepEqual(waitingIssuesFor([{ branch: 'agentdeck/WH-X-3', pr: 9 }]), [waiting])
    assert.deepEqual(waitingIssuesFor([{ branch: 'agentdeck/WH-X-3', pr: 8 }]), [])
    assert.deepEqual(waitingIssuesFor([{ branch: 'agentdeck/WH-X-4' }]), [])
    assert.deepEqual(waitingIssuesFor([{ branch: 'feature/WH-X-3' }]), [])
  })
})

describe('webhook route', () => {
  test('a signed delivery settles the waiting issue it names', async () => {
    const nudged: number[][] = []
    const app = webhookApp(SECRET, (ids) => nudged.push(ids))
    const payload = { action: 'completed', check_suite: { pull_requests: [{ number: 9, head: { ref: 'agentdeck/WH-X-3' } }] } }
    const res = await deliver(app, 'check_suite', payload)
    assert.equal(res.status, 200)
    assert.deepEqual(nudged, [[waiting]])

    assert.equal((await deliver(app, 'ping', { zen: 'hi' })).status, 200)
    assert.equal(nudged.length, 1)
  })

  test('unsigned and wrongly signed deliveries are refused and change nothing', async () => {
    const nudged: number[][] = []
    const app = webhookApp(SECRET, (ids) => nudged.push(ids))
    const payload = { action: 'closed', pull_request: { number: 9, head: { ref: 'agentdeck/WH-X-3' } } }
    assert.equal((await deliver(app, 'pull_request', payload, '')).status, 401)
    assert.equal((await deliver(app, 'pull_request', payload, sign('{}'))).status, 401)
    assert.deepEqual(nudged, [])
  })

  test('a sender that keeps failing is turned away before the body is checked', async () => {
    const app = webhookApp(SECRET, () => {})
    for (let i = 0; i < 20; i++) assert.equal((await deliver(app, 'ping', {}, sign('x'))).status, 401)
    assert.equal((await deliver(app, 'ping', {}, sign('x'))).status, 429)
    assert.equal((await deliver(app, 'ping', {})).status, 429)
  })

  test('without a secret the route does not exist', async () => {
    const app = webhookApp('', () => {})
    assert.equal((await deliver(app, 'ping', {}, sign('{}', ''))).status, 404)
  })

  test('the failure limit expires', () => {
    let now = 0
    const limiter = failureLimiter(() => now)
    for (let i = 0; i < 20; i++) limiter.failed('1.2.3.4')
    assert.equal(limiter.blocked('1.2.3.4'), true)
    assert.equal(limiter.blocked('5.6.7.8'), false)
    now += 11 * 60_000
    assert.equal(limiter.blocked('1.2.3.4'), false)
  })
})

describe('polling fallback', () => {
  test('polls every minute without webhooks, every ten minutes while they arrive', () => {
    const now = 1_000_000_000
    assert.equal(pollInterval(now, 0), 60_000)
    assert.equal(pollInterval(now, now - 5 * 60_000), 10 * 60_000)
    assert.equal(pollInterval(now, now - 25 * 3_600_000), 60_000)
  })
})
