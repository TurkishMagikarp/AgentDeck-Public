import './setup.ts'
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { rememberResets, resetsEnabled, resetsOf, setResetsEnabled, shouldRedeem } from '../server/resets.ts'

const HOUR = 3_600_000
const now = Date.parse('2026-11-22T12:00:00Z')
const full = { utilization: 1, resets_at: now + 72 * HOUR }

describe('reset setting', () => {
  test('is off until the owner switches it on', () => {
    assert.equal(resetsEnabled('never-set'), false)
  })
  test('can be switched on and off again', () => {
    setResetsEnabled('openai', true)
    assert.equal(resetsEnabled('openai'), true)
    setResetsEnabled('openai', false)
    assert.equal(resetsEnabled('openai'), false)
  })
  test('is kept per provider', () => {
    setResetsEnabled('openai', true)
    assert.equal(resetsEnabled('anthropic'), false)
    setResetsEnabled('openai', false)
  })
})

describe('resetsOf', () => {
  test('is null while the provider never reported resets', () => {
    assert.equal(resetsOf('anthropic'), null)
  })
  test('shows the count and the setting', () => {
    rememberResets('openai', 2, now)
    setResetsEnabled('openai', true)
    assert.deepEqual(resetsOf('openai'), { available: 2, checkedAt: now, enabled: true })
    setResetsEnabled('openai', false)
  })
  test('a new count replaces the old one', () => {
    rememberResets('openai', 2, now)
    rememberResets('openai', 0, now + 1)
    assert.equal(resetsOf('openai')?.available, 0)
  })
})

describe('shouldRedeem', () => {
  const base = { enabled: true, available: 1, windows: [full], now }

  test('redeems when allowed, available and the limit is used up', () => {
    assert.equal(shouldRedeem(base), true)
  })
  test('never when switched off', () => {
    assert.equal(shouldRedeem({ ...base, enabled: false }), false)
  })
  test('never without a reset', () => {
    assert.equal(shouldRedeem({ ...base, available: 0 }), false)
  })
  test('not while there is quota left', () => {
    assert.equal(
      shouldRedeem({ ...base, windows: [{ utilization: 0.97, resets_at: full.resets_at }] }),
      false,
    )
  })
  test('counts 98 % as used up', () => {
    assert.equal(shouldRedeem({ ...base, windows: [{ utilization: 0.98, resets_at: full.resets_at }] }), true)
  })
  test('not when the window resets on its own within the hour', () => {
    assert.equal(
      shouldRedeem({ ...base, windows: [{ utilization: 1, resets_at: now + 30 * 60_000 }] }),
      false,
    )
  })
  test('when the window resets in a bit more than an hour', () => {
    assert.equal(
      shouldRedeem({ ...base, windows: [{ utilization: 1, resets_at: now + HOUR + 60_000 }] }),
      true,
    )
  })
  test('when the window has no reset time', () => {
    assert.equal(shouldRedeem({ ...base, windows: [{ utilization: 1, resets_at: null }] }), true)
  })
  test('not without windows', () => {
    assert.equal(shouldRedeem({ ...base, windows: [] }), false)
  })
  test('one used-up window among others is enough', () => {
    assert.equal(shouldRedeem({ ...base, windows: [{ utilization: 0.2, resets_at: null }, full] }), true)
  })
})
