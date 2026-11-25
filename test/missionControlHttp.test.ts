import assert from 'node:assert/strict'
import { type ChildProcess, spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

// Starts the real server in mock mode on a free port and talks to it over HTTP: the routes, the
// auth middleware, the CSRF guard and the audit log together, not each piece on its own.
const PORT = 18000 + Math.floor(Math.random() * 1000)
const base = `http://127.0.0.1:${PORT}`
const data = mkdtempSync(join(tmpdir(), 'agentdeck-http-'))
let server: ChildProcess

const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

before(async () => {
  server = spawn(process.execPath, ['server/main.ts'], {
    env: { ...process.env, AGENTDECK_MOCK: '1', AGENTDECK_DATA: data, PORT: String(PORT), AGENTDECK_SANDBOX: '0' },
    stdio: 'ignore',
  })
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(base + '/api/overview')).ok) return
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error('server did not start')
})

after(() => {
  server.kill()
  try {
    rmSync(data, { recursive: true, force: true })
  } catch {
    // Windows may still hold the database file for a moment; the temp folder is cleaned by the OS.
  }
})

test('overview answers with every section the page reads', async () => {
  const overview = await (await call('GET', '/api/overview')).json()
  for (const key of ['projects', 'running', 'inbox', 'feed', 'totals', 'killSwitch', 'guard', 'daily', 'agents', 'health'])
    assert.ok(key in overview, `missing ${key}`)
  assert.equal(overview.daily.length, 14)
})

test('spend guard validates, saves and shows up in the overview', async () => {
  assert.equal((await call('PUT', '/api/spend-guard', { capUsd: -1 })).status, 400)
  assert.equal((await call('PUT', '/api/spend-guard', { capUsd: 12.5 })).status, 200)
  assert.equal((await (await call('GET', '/api/overview')).json()).guard.capUsd, 12.5)
  await call('PUT', '/api/spend-guard', { capUsd: 0 })
})

test('kill switch refuses unknown actions and survives a stop and resume round', async () => {
  assert.equal((await call('POST', '/api/kill-switch', { action: 'explode' })).status, 400)
  assert.equal((await call('POST', '/api/kill-switch', { action: 'stop' })).status, 200)
  assert.equal((await (await call('GET', '/api/overview')).json()).killSwitch, false, 'nothing was running, so nothing to remember')
  assert.equal((await call('POST', '/api/kill-switch', { action: 'resume' })).status, 200)
})

test('a browser write from another site is refused, a same-origin one passes', async () => {
  const foreign = await call('POST', '/api/kill-switch', { action: 'stop' }, { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' })
  assert.equal(foreign.status, 403)
  const own = await call('PUT', '/api/spend-guard', { capUsd: 0 }, { origin: base, 'sec-fetch-site': 'same-origin' })
  assert.equal(own.status, 200)
})

test('since summary clamps garbage input instead of failing', async () => {
  const summary = await (await call('GET', '/api/overview/since?t=abc')).json()
  assert.equal(summary.hours, 0)
})
