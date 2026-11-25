import './setup.ts'
import assert from 'node:assert/strict'
import { beforeEach, describe, test } from 'node:test'
import { limitingWindows, modelLimitReached, paceOf } from '../server/pacing.ts'
import { clearQuota, HOUR, setMode, setQuota } from './helpers.ts'

beforeEach(() => {
  clearQuota()
  setMode('anthropic', 'subscription')
  setMode('openai', 'subscription')
})

describe('limitingWindows', () => {
  test('keeps the plan-wide windows', () => {
    setQuota('anthropic', 'seven_day', 0.72)
    setQuota('anthropic', 'five_hour', 0.1)
    assert.deepEqual(
      limitingWindows('anthropic')
        .map((w) => w.window)
        .sort(),
      ['five_hour', 'seven_day'],
    )
  })

  test('ignores extra usage and the limits of a single model', () => {
    setQuota('anthropic', 'seven_day', 0.72)
    setQuota('anthropic', 'seven_day_overage_included', 0.93)
    setQuota('anthropic', 'seven_day_fable', 1)
    setQuota('anthropic', 'seven_day_opus', 1)
    setQuota('anthropic', 'seven_day_sonnet', 1)
    setQuota('anthropic', 'seven_day_haiku', 1)
    assert.deepEqual(
      limitingWindows('anthropic').map((w) => w.window),
      ['seven_day'],
    )
  })

  test('ignores old readings only when no reset is known', () => {
    setQuota('anthropic', 'seven_day', 0.93, { age: 7 * HOUR, resetsIn: null })
    assert.equal(limitingWindows('anthropic').length, 0)
  })

  test('retains an old reading until its reported reset', () => {
    setQuota('anthropic', 'seven_day', 0.98, { age: 7 * HOUR })
    assert.equal(limitingWindows('anthropic')[0]?.stale, true)
  })

  test('keeps a reading younger than six hours', () => {
    setQuota('anthropic', 'seven_day', 0.93, { age: 5 * HOUR })
    assert.equal(limitingWindows('anthropic').length, 1)
  })

  test('ignores windows that already reset', () => {
    setQuota('anthropic', 'seven_day', 0.99, { resetsIn: -HOUR })
    assert.equal(limitingWindows('anthropic').length, 0)
  })

  test('keeps windows without a reset time', () => {
    setQuota('openai', '10080min', 0.5, { resetsIn: null })
    assert.equal(limitingWindows('openai').length, 1)
  })

  test('only returns the asked provider', () => {
    setQuota('openai', '10080min', 0.5)
    assert.equal(limitingWindows('anthropic').length, 0)
  })
})

describe('paceOf', () => {
  test('never saves, however little is left', () => {
    setQuota('anthropic', 'seven_day', 0.95, { resetsIn: 72 * HOUR })
    assert.equal(paceOf('anthropic').pace, 'normal')
    assert.ok(Math.abs(paceOf('anthropic').left - 0.05) < 1e-9)
  })

  test('spends when the window resets within the hour with plenty left', () => {
    setQuota('anthropic', 'seven_day', 0.4, { resetsIn: 30 * 60_000 })
    assert.equal(paceOf('anthropic').pace, 'spend')
  })

  test('does not spend with little left before the reset', () => {
    setQuota('anthropic', 'seven_day', 0.8, { resetsIn: 30 * 60_000 })
    assert.equal(paceOf('anthropic').pace, 'normal')
  })

  test('is normal without readings', () => {
    assert.deepEqual(paceOf('anthropic'), { pace: 'normal', left: 1 })
  })

  test('is normal with an API key, whatever the windows say', () => {
    setMode('anthropic', 'apikey')
    setQuota('anthropic', 'seven_day', 0.4, { resetsIn: 30 * 60_000 })
    assert.deepEqual(paceOf('anthropic'), { pace: 'normal', left: 1 })
  })

  test('a full Fable limit does not change the pace', () => {
    setQuota('anthropic', 'seven_day', 0.72)
    setQuota('anthropic', 'seven_day_fable', 1)
    assert.ok(Math.abs(paceOf('anthropic').left - 0.28) < 1e-9)
  })

  test('the fullest limiting window decides', () => {
    setQuota('anthropic', 'seven_day', 0.5)
    setQuota('anthropic', 'five_hour', 0.9)
    assert.ok(Math.abs(paceOf('anthropic').left - 0.1) < 1e-9)
  })
})

describe('modelLimitReached', () => {
  test('a subscription model limit does not affect API-key runs', () => {
    setMode('anthropic', 'apikey')
    setQuota('anthropic', 'seven_day_fable', 1)
    assert.equal(modelLimitReached('anthropic', 'claude-fable-5-2'), false)
  })

  test('is true for a model whose own limit is used up', () => {
    setQuota('anthropic', 'seven_day_fable', 1)
    assert.equal(modelLimitReached('anthropic', 'claude-fable-5-2'), true)
  })

  test('counts 98 % as used up', () => {
    setQuota('anthropic', 'seven_day_fable', 0.98)
    assert.equal(modelLimitReached('anthropic', 'claude-fable-5-2'), true)
  })

  test('is false below 98 %', () => {
    setQuota('anthropic', 'seven_day_fable', 0.97)
    assert.equal(modelLimitReached('anthropic', 'claude-fable-5-2'), false)
  })

  test('does not touch other models', () => {
    setQuota('anthropic', 'seven_day_fable', 1)
    assert.equal(modelLimitReached('anthropic', 'claude-opus-5-5'), false)
    assert.equal(modelLimitReached('anthropic', 'claude-sonnet-5-5'), false)
  })

  test('is false once the limit reset', () => {
    setQuota('anthropic', 'seven_day_fable', 1, { resetsIn: -60_000 })
    assert.equal(modelLimitReached('anthropic', 'claude-fable-5-2'), false)
  })

  test('is false for models without a family name', () => {
    setQuota('anthropic', 'seven_day', 1)
    assert.equal(modelLimitReached('anthropic', ''), false)
    assert.equal(modelLimitReached('openai', 'gpt-6'), false)
  })
})
