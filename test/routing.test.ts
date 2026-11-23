import './setup.ts'
import assert from 'node:assert/strict'
import { beforeEach, describe, test } from 'node:test'
import { defaultSettings, pickProvider, providerLeft } from '../server/core.ts'
import { classifyFailure } from '../server/recovery.ts'
import { clearQuota, HOUR, setMode, setQuota } from './helpers.ts'

const project = (change: (s: ReturnType<typeof defaultSettings>) => void = () => {}) => {
  const settings = defaultSettings()
  change(settings)
  return { id: 1, settings }
}

beforeEach(() => {
  clearQuota()
  setMode('anthropic', 'subscription')
  setMode('openai', 'subscription')
})

describe('providerLeft', () => {
  test('goes by the normal weekly limit, not by extra usage', () => {
    setQuota('anthropic', 'seven_day', 0.72)
    setQuota('anthropic', 'seven_day_overage_included', 0.93)
    const state = providerLeft(project(), 'anthropic')
    assert.equal(Math.round(state.quotaLeft!), 28)
    assert.equal(state.available, true)
  })

  test('a full Fable limit keeps the provider available', () => {
    setQuota('anthropic', 'seven_day', 0.72)
    setQuota('anthropic', 'seven_day_fable', 1)
    assert.equal(providerLeft(project(), 'anthropic').available, true)
  })

  test('still lists every window for the usage page', () => {
    setQuota('anthropic', 'seven_day', 0.72)
    setQuota('anthropic', 'seven_day_fable', 1)
    const windows = providerLeft(project(), 'anthropic').quotas.map((q: any) => q.window)
    assert.deepEqual(windows.sort(), ['seven_day', 'seven_day_fable'])
  })

  test('an old reading does not stop runs', () => {
    setQuota('anthropic', 'seven_day', 0.99, { age: 24 * HOUR })
    const state = providerLeft(project(), 'anthropic')
    assert.equal(state.quotaLeft, null)
    assert.equal(state.available, true)
  })

  test('stops at the owner threshold and not before', () => {
    const p = project((s) => (s.budgets.anthropic.stopAtPct = 10))
    setQuota('anthropic', 'seven_day', 0.89)
    assert.equal(providerLeft(p, 'anthropic').available, true)
    setQuota('anthropic', 'seven_day', 0.9)
    assert.equal(providerLeft(p, 'anthropic').available, false)
  })

  test('the subscription windows do not count with an API key', () => {
    setMode('anthropic', 'apikey')
    setQuota('anthropic', 'seven_day', 1)
    assert.equal(providerLeft(project(), 'anthropic').quotaLeft, null)
  })
})

describe('pickProvider', () => {
  const fable = { provider: 'anthropic', model: 'claude-fable-5-2' }
  const opus = { provider: 'anthropic', model: 'claude-opus-5-5' }

  test('keeps the agent on its own provider and model', () => {
    setQuota('anthropic', 'seven_day', 0.5)
    assert.deepEqual(pickProvider(project(), fable), {
      provider: 'anthropic',
      model: 'claude-fable-5-2',
      fallback: false,
    })
  })

  test('skips a model whose own limit is used up', () => {
    setQuota('anthropic', 'seven_day', 0.5)
    setQuota('anthropic', 'seven_day_fable', 1)
    assert.equal(
      pickProvider(
        project((s) => (s.fallbackEnabled = false)),
        fable,
      ),
      null,
    )
  })

  test('other models of the provider keep running', () => {
    setQuota('anthropic', 'seven_day_fable', 1)
    assert.equal(pickProvider(project(), opus)?.provider, 'anthropic')
  })

  test('a Fable agent falls back to the next provider', () => {
    setQuota('anthropic', 'seven_day_fable', 1)
    const p = project((s) => {
      s.fallbackEnabled = true
      s.fallback = ['anthropic', 'openai']
      s.fallbackModels = { openai: 'gpt-6' }
    })
    setMode('openai', 'subscription')
    assert.deepEqual(pickProvider(p, fable), { provider: 'openai', model: 'gpt-6', fallback: true })
  })
})

describe('classifyFailure', () => {
  test('a full Fable limit does not rest the provider until its reset', () => {
    setQuota('anthropic', 'seven_day', 0.5)
    setQuota('anthropic', 'seven_day_fable', 1, { resetsIn: 48 * HOUR })
    const failure = classifyFailure(0, 'anthropic', 'You have hit your limit for Fable')
    assert.equal(failure.kind, 'limit')
    assert.equal(failure.until, undefined)
  })

  test('a full weekly limit rests the provider until its reset', () => {
    const now = Date.now()
    setQuota('anthropic', 'seven_day', 1, { resetsIn: 5 * HOUR, now })
    const failure = classifyFailure(0, 'anthropic', 'usage limit reached')
    assert.equal(failure.kind, 'limit')
    assert.equal(failure.until, now + 5 * HOUR)
  })

  test('an old full reading gives no reset time', () => {
    setQuota('anthropic', 'seven_day', 1, { age: 24 * HOUR })
    assert.equal(classifyFailure(0, 'anthropic', 'usage limit reached').until, undefined)
  })
})
