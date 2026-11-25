import './setup.ts'
import assert from 'node:assert/strict'
import { beforeEach, describe, test } from 'node:test'
import { claudeWindows, readClaudeUsage, saveClaudeWindows, windowName } from '../server/claudeUsage.ts'
import { all } from '../server/db.ts'
import { clearQuota, setMode, setQuota } from './helpers.ts'

// Shortened answer of /api/oauth/usage as it came on 2026-11-22.
const SAMPLE = {
  five_hour: null,
  seven_day: { utilization: 72, resets_at: '2026-11-24T21:00:00.559247+00:00' },
  extra_usage: { is_enabled: false, utilization: 0 },
  limits: [
    {
      kind: 'weekly_all',
      group: 'weekly',
      percent: 72,
      severity: 'normal',
      resets_at: '2026-11-24T21:00:00.559247+00:00',
      scope: null,
      is_active: false,
    },
    {
      kind: 'weekly_scoped',
      group: 'weekly',
      percent: 100,
      severity: 'critical',
      resets_at: '2026-11-24T20:59:59.559463+00:00',
      scope: { model: { id: null, display_name: 'Fable' }, surface: null },
      is_active: true,
    },
  ],
}

const limit = (group: string, model?: string) => ({
  kind: group,
  group,
  percent: 1,
  resets_at: null,
  scope: model ? { model: { display_name: model } } : null,
})

beforeEach(clearQuota)

describe('windowName', () => {
  test('the weekly limit for all models is seven_day', () => {
    assert.equal(windowName(limit('weekly')), 'seven_day')
  })
  test('a model limit carries the model', () => {
    assert.equal(windowName(limit('weekly', 'Fable')), 'seven_day_fable')
  })
  test('the session limit is five_hour', () => {
    assert.equal(windowName(limit('session')), 'five_hour')
  })
  test('unknown groups keep their name', () => {
    assert.equal(windowName(limit('monthly')), 'monthly')
  })
  test('model names with spaces become one word', () => {
    assert.equal(windowName(limit('weekly', 'Opus Max')), 'seven_day_opus_max')
  })
})

describe('claudeWindows', () => {
  test('reads legacy weekly and Fable windows even without a limits array', () => {
    const windows = claudeWindows({
      five_hour: { utilization: 3, resets_at: null },
      seven_day: { utilization: 98, resets_at: '2026-11-24T21:00:00Z' },
      seven_day_fable: { utilization: 100, resets_at: '2026-11-24T21:00:00Z' },
    })
    assert.deepEqual(windows.map((w) => [w.window, w.utilization]), [
      ['five_hour', 0.03], ['seven_day', 0.98], ['seven_day_fable', 1],
    ])
  })

  test('reads the weekly and the Fable limit', () => {
    const windows = claudeWindows(SAMPLE)
    assert.deepEqual(
      windows.map((w) => [w.window, w.utilization]),
      [
        ['seven_day', 0.72],
        ['seven_day_fable', 1],
      ],
    )
    assert.equal(windows[0].resetsAt, Date.parse('2026-11-24T21:00:00.559247+00:00'))
  })

  test('takes five_hour from the top level when limits leave it out', () => {
    const windows = claudeWindows({
      ...SAMPLE,
      five_hour: { utilization: 12, resets_at: '2026-11-22T20:00:00Z' },
    })
    assert.equal(windows.find((w) => w.window === 'five_hour')?.utilization, 0.12)
  })

  test('does not count five_hour twice', () => {
    const usage = {
      five_hour: { utilization: 12, resets_at: null },
      limits: [{ ...limit('session'), percent: 30 }],
    }
    const windows = claudeWindows(usage)
    assert.equal(windows.filter((w) => w.window === 'five_hour').length, 1)
    assert.equal(windows[0].utilization, 0.3)
  })

  test('skips limits without a percentage', () => {
    assert.equal(claudeWindows({ limits: [{ ...limit('weekly'), percent: null }] }).length, 0)
  })

  test('copes with an empty or broken answer', () => {
    assert.deepEqual(claudeWindows({}), [])
    assert.deepEqual(claudeWindows(null), [])
  })

  test('a missing reset time stays null', () => {
    assert.equal(claudeWindows({ limits: [limit('weekly')] })[0].resetsAt, null)
  })
})

describe('saveClaudeWindows', () => {
  const rows = () =>
    all('SELECT window, utilization FROM quota WHERE provider=? ORDER BY window', 'anthropic').map((row) => ({
      ...row,
    }))

  test('stores every window', () => {
    saveClaudeWindows(claudeWindows(SAMPLE))
    assert.deepEqual(rows(), [
      { window: 'seven_day', utilization: 0.72 },
      { window: 'seven_day_fable', utilization: 1 },
    ])
  })

  test('removes windows Anthropic no longer reports', () => {
    setQuota('anthropic', 'seven_day_overage_included', 0.93)
    saveClaudeWindows(claudeWindows(SAMPLE))
    assert.ok(!rows().some((row) => row.window === 'seven_day_overage_included'))
  })

  test('leaves other providers alone', () => {
    setQuota('openai', '10080min', 0.5)
    saveClaudeWindows(claudeWindows(SAMPLE))
    assert.equal(all('SELECT * FROM quota WHERE provider=?', 'openai').length, 1)
  })

  test('an empty answer changes nothing', () => {
    setQuota('anthropic', 'seven_day', 0.5)
    saveClaudeWindows([])
    assert.deepEqual(rows(), [{ window: 'seven_day', utilization: 0.5 }])
  })

  test('a new reading replaces the old one', () => {
    setQuota('anthropic', 'seven_day', 0.93)
    saveClaudeWindows(claudeWindows(SAMPLE))
    assert.equal(rows().find((row) => row.window === 'seven_day')?.utilization, 0.72)
  })

  test('a partial session reading preserves a known weekly window until reset', () => {
    setQuota('anthropic', 'seven_day', 0.98)
    saveClaudeWindows([{ window: 'five_hour', utilization: 0.1, resetsAt: null }])
    assert.deepEqual(rows(), [
      { window: 'five_hour', utilization: 0.1 },
      { window: 'seven_day', utilization: 0.98 },
    ])
  })
})

test('a delayed old-account response does not replace quota after a login change', async (t) => {
  setMode('anthropic', 'subscription')
  const previous = process.env.CLAUDE_CODE_OAUTH_TOKEN
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'fixture-old'
  t.after(() => {
    if (previous === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN
    else process.env.CLAUDE_CODE_OAUTH_TOKEN = previous
  })
  t.mock.method(globalThis, 'fetch', async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'fixture-new'
    return Response.json(SAMPLE)
  })
  await readClaudeUsage()
  assert.equal(all('SELECT * FROM quota').length, 0)
  await readClaudeUsage()
  assert.equal(all('SELECT * FROM quota').length, 2)
})
