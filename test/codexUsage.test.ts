import './setup.ts'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { before, beforeEach, describe, test } from 'node:test'
import { readCodexUsage, saveCodexWindows } from '../server/codexUsage.ts'
import { all } from '../server/db.ts'
import { resetsOf, setResetsEnabled } from '../server/resets.ts'
import { clearQuota, setMode } from './helpers.ts'

const bin = mkdtempSync(join(tmpdir(), 'fake-codex-'))
const stateFile = join(bin, 'state.json')
const logFile = join(bin, 'requests.log')
const fake = resolve(import.meta.dirname, 'fake-codex.mjs')

before(() => {
  // A `codex` on PATH that runs the fake app-server, for Windows and for Linux.
  writeFileSync(join(bin, 'codex.cmd'), `@node "${fake}" %*\r\n`)
  writeFileSync(join(bin, 'codex'), `#!/bin/sh\nexec node "${fake}" "$@"\n`)
  chmodSync(join(bin, 'codex'), 0o755)
  process.env.PATH = bin + delimiter + process.env.PATH
  process.env.FAKE_CODEX_STATE = stateFile
  process.env.FAKE_CODEX_LOG = logFile
})

const HOUR_S = 3600
function codexReports(usedPercent: number, available: number, resetsInHours = 72) {
  const resetsAt = Math.floor(Date.now() / 1000) + resetsInHours * HOUR_S
  writeFileSync(
    stateFile,
    JSON.stringify({ available, primary: { usedPercent, windowDurationMins: 10080, resetsAt } }),
  )
}
const requests = () =>
  existsSync(logFile)
    ? readFileSync(logFile, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
    : []
const consumed = () => requests().filter((r) => r.method === 'account/rateLimitResetCredit/consume')

beforeEach(() => {
  clearQuota()
  rmSync(logFile, { force: true })
  setMode('openai', 'subscription')
  setResetsEnabled('openai', false)
})

describe('saveCodexWindows', () => {
  test('stores the windows under the names of the session files', () => {
    saveCodexWindows({
      primary: { usedPercent: 56, windowDurationMins: 10080, resetsAt: 1795903512 },
      secondary: { usedPercent: 10, windowDurationMins: 300, resetsAt: null },
    })
    const rows = all(
      'SELECT window, utilization, resets_at FROM quota WHERE provider=? ORDER BY window',
      'openai',
    )
    assert.deepEqual(
      rows.map((r) => ({ ...r })),
      [
        { window: '10080min', utilization: 0.56, resets_at: 1795903512000 },
        { window: '300min', utilization: 0.1, resets_at: null },
      ],
    )
  })

  test('skips windows without a percentage', () => {
    saveCodexWindows({ primary: null, secondary: { windowDurationMins: 300 } })
    assert.equal(all('SELECT * FROM quota WHERE provider=?', 'openai').length, 0)
  })

  test('copes with a missing snapshot', () => {
    saveCodexWindows(undefined)
    assert.equal(all('SELECT * FROM quota').length, 0)
  })
})

describe('readCodexUsage', () => {
  test('stores the window and the number of resets', async () => {
    codexReports(56, 2)
    await readCodexUsage()
    assert.equal(all('SELECT utilization FROM quota WHERE provider=?', 'openai')[0].utilization, 0.56)
    assert.equal(resetsOf('openai')?.available, 2)
  })

  test('speaks the app-server protocol: initialize, initialized, then the request', async () => {
    codexReports(10, 0)
    await readCodexUsage()
    assert.deepEqual(
      requests().map((r) => r.method),
      ['initialize', 'initialized', 'account/rateLimits/read'],
    )
  })

  test('does not redeem while the setting is off', async () => {
    codexReports(100, 1)
    await readCodexUsage()
    assert.equal(consumed().length, 0)
  })

  test('redeems a reset once the limit is used up and the setting is on', async () => {
    setResetsEnabled('openai', true)
    codexReports(100, 1)
    await readCodexUsage()
    assert.equal(consumed().length, 1)
    assert.match(consumed()[0].params.idempotencyKey, /^[0-9a-f-]{36}$/)
    // After the reset it reads again and stores the fresh state.
    assert.equal(all('SELECT utilization FROM quota WHERE provider=?', 'openai')[0].utilization, 0)
    assert.equal(resetsOf('openai')?.available, 0)
  })

  test('does not redeem while quota is left', async () => {
    setResetsEnabled('openai', true)
    codexReports(80, 1)
    await readCodexUsage()
    assert.equal(consumed().length, 0)
  })

  test('does not redeem without an available reset', async () => {
    setResetsEnabled('openai', true)
    codexReports(100, 0)
    await readCodexUsage()
    assert.equal(consumed().length, 0)
  })

  test('does not redeem when the window resets on its own soon', async () => {
    setResetsEnabled('openai', true)
    codexReports(100, 1, 0.5)
    await readCodexUsage()
    assert.equal(consumed().length, 0)
  })

  test('redeems only one reset per check', async () => {
    setResetsEnabled('openai', true)
    codexReports(100, 3)
    await readCodexUsage()
    assert.equal(consumed().length, 1)
    assert.equal(resetsOf('openai')?.available, 2)
  })

  test('asks nothing with an API key', async () => {
    setMode('openai', 'apikey')
    codexReports(100, 1)
    await readCodexUsage()
    assert.equal(requests().length, 0)
  })
})
