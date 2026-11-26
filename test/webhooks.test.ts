import './setup.ts'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { createServer, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, describe, test } from 'node:test'
import { createIssue, mergeSettings, patchIssue } from '../server/core.ts'
import { run } from '../server/db.ts'
import {
  checkUrl,
  createWebhook,
  isBlockedAddress,
  request,
  resolveChecked,
  sign,
  timing,
  wanting,
} from '../server/webhooks.ts'

describe('SSRF guard', () => {
  test('refuses loopback, private, link-local and mapped addresses', () => {
    for (const address of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '224.0.0.1',
      '::1',
      '::',
      'fe80::1',
      'fc00::1',
      'fd12:3456::1',
      '::ffff:127.0.0.1',
      '::ffff:10.0.0.1',
      '64:ff9b::a00:1',
      '2002:7f00:1::',
      'not-an-ip',
    ])
      assert.equal(isBlockedAddress(address), true, address)
  })

  test('lets public addresses through', () => {
    for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '2a00:1450:4001::200e'])
      assert.equal(isBlockedAddress(address), false, address)
  })

  test('local test mode opens loopback only', () => {
    assert.equal(isBlockedAddress('127.0.0.1', true), false)
    assert.equal(isBlockedAddress('::1', true), false)
    assert.equal(isBlockedAddress('10.0.0.1', true), true)
    assert.equal(isBlockedAddress('169.254.169.254', true), true)
  })

  test('only https URLs without credentials, http only for localhost in test mode', () => {
    assert.throws(() => checkUrl('http://example.com/hook', false), /Nur https/)
    assert.throws(() => checkUrl('ftp://example.com/hook', false), /Nur https/)
    assert.throws(() => checkUrl('https://user:pw@example.com/hook', false), /Zugangsdaten/)
    assert.throws(() => checkUrl('https://127.0.0.1/hook', false), /privaten Netz/)
    assert.throws(() => checkUrl('https://[::1]/hook', false), /privaten Netz/)
    assert.throws(() => checkUrl('https://169.254.169.254/latest', false), /privaten Netz/)
    assert.throws(() => checkUrl('http://localhost:3000/hook', false), /Nur https/)
    assert.throws(() => checkUrl('kein url', false), /Ungültige/)
    assert.equal(checkUrl('https://hooks.slack.com/services/x', false).host, 'hooks.slack.com')
    assert.equal(checkUrl('http://127.0.0.1:3000/hook', true).isLocal, true)
    assert.throws(() => checkUrl('http://10.0.0.1/hook', true), /Nur https/)
  })

  test('every resolved address is checked, not only the URL text', async () => {
    await assert.rejects(resolveChecked('localhost', false), /privaten Netz/)
    await assert.rejects(resolveChecked('127.0.0.1', false), /privaten Netz/)
    assert.equal((await resolveChecked('127.0.0.1', true)).address, '127.0.0.1')
  })
})

test('signature is HMAC-SHA256 of the exact body', () => {
  const body = '{"project":"AD"}'
  assert.equal(sign('geheim', body), 'sha256=' + createHmac('sha256', 'geheim').update(body).digest('hex'))
  assert.notEqual(sign('anders', body), sign('geheim', body))
})

test('settings keep only well-formed webhooks and known events', () => {
  const settings = mergeSettings({
    webhooks: [
      { id: '0123456789abcdef', kind: 'slack', host: 'hooks.slack.com', events: ['done', 'evil'] },
      { id: '0123456789abcdef', kind: 'generic', host: 'dup', events: ['done'] },
      { id: '../../x', kind: 'generic', host: 'x', events: ['done'] },
      { id: 'fedcba9876543210', kind: 'other', events: 'done' },
    ],
  })
  assert.deepEqual(settings.webhooks, [
    { id: '0123456789abcdef', kind: 'slack', host: 'hooks.slack.com', events: ['done'] },
    { id: 'fedcba9876543210', kind: 'generic', host: '', events: [] },
  ])
  assert.deepEqual(
    wanting(settings.webhooks, 'done').map((hook) => hook.id),
    ['0123456789abcdef'],
  )
  assert.deepEqual(wanting(settings.webhooks, 'blocked'), [])
})

describe('delivery', () => {
  const received: { headers: IncomingMessage['headers']; body: string }[] = []
  let failNext = 0
  let base = ''
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      received.push({ headers: req.headers, body })
      res.statusCode = failNext-- > 0 ? 503 : 204
      res.end()
    })
  })
  const until = async (check: () => boolean) => {
    for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 10))
  }

  before(async () => {
    process.env.AGENTDECK_ALLOW_OPEN = '1'
    timing.coalesceMs = 30
    timing.backoffMs = 10
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  after(() => {
    delete process.env.AGENTDECK_ALLOW_OPEN
    server.close()
  })

  function project(key: string, kind: 'slack' | 'generic', events: string[]) {
    const pid = Number(
      run('INSERT INTO projects (key, name, settings, created_at) VALUES (?,?,?,?)', key, key, '{}', Date.now())
        .lastInsertRowid,
    )
    const created = createWebhook(pid, { url: `${base}/hook`, kind, events })
    run('UPDATE projects SET settings=? WHERE id=?', JSON.stringify({ webhooks: [created.webhook] }), pid)
    return { pid, ...created }
  }

  test('only chosen status changes are sent, coalesced and signed', async () => {
    received.length = 0
    const { pid, secret } = project('WH', 'generic', ['done'])
    assert.match(secret!, /^[0-9a-f]{64}$/)
    const issue = createIssue(pid, { title: 'Login reparieren', status: 'todo' })!
    patchIssue(issue.id, { status: 'review' }) // not chosen
    patchIssue(issue.id, { status: 'done' })
    patchIssue(issue.id, { status: 'review' })
    patchIssue(issue.id, { status: 'done' }) // same issue and event: told once
    patchIssue(issue.id, { title: 'nur Titel' }) // no status change
    await until(() => received.length > 0)
    await new Promise((r) => setTimeout(r, 80))

    assert.equal(received.length, 1)
    const { headers, body } = received[0]
    assert.equal(headers['x-agentdeck-signature'], sign(secret!, body))
    const payload = JSON.parse(body)
    assert.equal(payload.project, 'WH')
    assert.equal(payload.events.length, 1)
    assert.deepEqual(
      { ...payload.events[0], at: 0 },
      {
        event: 'done',
        issue: { number: issue.number, title: 'Login reparieren' },
        oldStatus: 'review',
        newStatus: 'done',
        at: 0,
        link: null,
      },
    )
  })

  test('slack gets text and no signature; a failing endpoint is retried', async () => {
    received.length = 0
    failNext = 2
    const { pid, secret } = project('SL', 'slack', ['blocked'])
    assert.equal(secret, undefined)
    const issue = createIssue(pid, { title: 'A <b> & c', status: 'todo' })!
    patchIssue(issue.id, { status: 'blocked' })
    await until(() => received.length >= 3)

    assert.equal(received.length, 3, 'two 503 answers, then success')
    assert.equal(received[2].headers['x-agentdeck-signature'], undefined)
    const { text } = JSON.parse(received[2].body)
    assert.match(text, /^\*Blockiert\*: SL-1 A &lt;b&gt; &amp; c \(To Do → Blockiert\)$/)
  })

  test('a webhook id copied into another project sends nothing', () => {
    const { webhook } = project('OWN', 'generic', ['done'])
    assert.ok(request(webhook, 999_999, 'X', []) === null)
  })
})
