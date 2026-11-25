import './setup.ts'
import assert from 'node:assert/strict'
import { beforeEach, describe, test } from 'node:test'
import { defaultSettings, mergeSettings, pickProvider, providerLeft, routeProvider, tierOf } from '../server/core.ts'
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

  test('an old reading without a reset does not stop runs or imply known quota', () => {
    setQuota('anthropic', 'seven_day', 0.99, { age: 24 * HOUR, resetsIn: null })
    const state = providerLeft(project(), 'anthropic')
    assert.equal(state.quotaLeft, null)
    assert.equal(state.available, true)
    assert.equal(state.quotas[0]?.active, false)
  })

  test('a 98% week stays at 2% left and stops at 2%, even after six hours and without a dollar budget', () => {
    setQuota('anthropic', 'seven_day', 0.98, { age: 24 * HOUR })
    setQuota('anthropic', 'seven_day_fable', 1)
    const p = project((s) => {
      Object.assign(s.budgets.anthropic, { limit: 0, unit: 'usd', stopAtPct: 2 })
      s.fallback = ['anthropic', 'openai']
    })
    const state = providerLeft(p, 'anthropic')
    assert.equal(state.budgetLeft, null)
    assert.equal(Math.round(state.left), 2)
    assert.equal(state.available, false)
    assert.equal(pickProvider(p, { provider: 'anthropic', model: 'claude-sonnet-5-5' })?.provider, 'openai')
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

  test('an exact two percent stop is not missed by floating-point rounding', () => {
    setQuota('anthropic', 'seven_day', 0.98)
    assert.equal(providerLeft(project((s) => (s.budgets.anthropic.stopAtPct = 2)), 'anthropic').available, false)
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
        { ...fable, provider_override: true },
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
      s.modelTiers.strong.openai = 'gpt-6'
    })
    setMode('openai', 'subscription')
    assert.deepEqual(pickProvider(p, fable), { provider: 'openai', model: 'gpt-6', fallback: true })
  })

  test('without an override the fallback keeps the agent tier', () => {
    setQuota('anthropic', 'seven_day', 1)
    const p = project((s) => {
      s.fallback = ['anthropic', 'openai']
      s.modelTiers.strong.openai = 'gpt-strong'
      s.modelTiers.light.openai = 'gpt-light'
    })
    const haiku = { provider: 'anthropic', model: 'claude-haiku-5-5' }
    assert.equal(pickProvider(p, haiku)?.model, 'gpt-light')
    assert.equal(pickProvider(p, { provider: 'anthropic', model: 'claude-opus-5-5' })?.model, 'gpt-strong')
  })

  test('stored agent defaults do not jump ahead of the project order, including in reviews', () => {
    const p = project((s) => {
      s.fallback = ['openai', 'anthropic']
      s.modelTiers.strong.openai = 'gpt-strong'
      s.fallbackEnabled = false
      s.fallbackReviews = false
    })
    assert.equal(pickProvider(p, opus)?.provider, 'openai')
    assert.equal(pickProvider(p, opus, undefined, 'review')?.model, 'gpt-strong')
    assert.equal(pickProvider(p, { ...opus, provider_override: true }, 'anthropic')?.provider, 'anthropic')
  })

  test('Codex at 40% beats a lower provider in project order; the 50% reserve only affects overrides', () => {
    setQuota('anthropic', 'seven_day', 0.98)
    setQuota('openai', 'seven_day', 0.6)
    const p = project((s) => {
      s.fallback = ['anthropic', 'openai']
      s.budgets.anthropic.stopAtPct = 2
    })
    assert.equal(pickProvider(p, opus)?.provider, 'openai')
    assert.match(routeProvider(p, opus).skipped[0], /Anthropic.*2% left, stop at 2%/)
    assert.equal(pickProvider(p, { ...opus, provider_override: true }), null)
    assert.match(routeProvider(p, { ...opus, provider_override: true }).skipped[1], /Codex.*40% left, stop at 50%/)
  })

  test('model limits are checked against the model actually requested for the issue', () => {
    setQuota('anthropic', 'seven_day_fable', 1)
    const p = project((s) => (s.fallback = ['anthropic', 'openai']))
    assert.equal(pickProvider(p, opus, undefined, 'work', fable.model)?.provider, 'openai')
  })

  test('project order removes duplicate and invalid entries without moving valid priorities', () => {
    const s = mergeSettings({ fallback: ['openai', 'openai', 'deepseek', 'constructor', 'anthropic'] })
    assert.deepEqual(s.fallback.slice(0, 3), ['openai', 'deepseek', 'anthropic'])
    assert.equal(s.fallback.includes('constructor'), false)
  })
})

describe('old fallbackModels', () => {
  test('fill only the tiers the project never set', () => {
    const s = mergeSettings({ fallbackModels: { openai: 'gpt-6' }, modelTiers: { light: { openai: 'gpt-light' } } })
    assert.equal(s.modelTiers.strong.openai, 'gpt-6')
    assert.equal(s.modelTiers.medium.openai, 'gpt-6')
    assert.equal(s.modelTiers.light.openai, 'gpt-light')
    assert.equal('fallbackModels' in s, false)
  })
})

describe('tierOf', () => {
  const tiers = defaultSettings().modelTiers
  test('reads the tier from the table, then from the name', () => {
    assert.equal(tierOf(tiers, 'anthropic', 'claude-sonnet-5-5'), 'medium')
    assert.equal(tierOf(tiers, 'anthropic', 'claude-fable-5-2'), 'strong')
    assert.equal(tierOf(tiers, 'deepseek', 'deepseek-flash'), 'light')
    assert.equal(tierOf(tiers, 'openai', ''), 'medium')
  })
})

describe('classifyFailure', () => {
  test('an expired Claude OAuth session is a provider login error', () => {
    assert.equal(classifyFailure(1, 'anthropic', 'Failed to authenticate: OAuth session expired and could not be refreshed').kind, 'access')
  })

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

  test('an old full reading without a known reset gives no reset time', () => {
    setQuota('anthropic', 'seven_day', 1, { age: 24 * HOUR, resetsIn: null })
    assert.equal(classifyFailure(0, 'anthropic', 'usage limit reached').until, undefined)
  })
})
