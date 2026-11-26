import './setup.ts'
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { createIssue, emit, patchIssue } from '../server/core.ts'
import { run } from '../server/db.ts'
import {
  exceedsCap,
  forecastFor,
  forecastFrom,
  forecastView,
  jaccard,
  similarity,
  weightedQuantile,
  wordsOf,
  type Done,
  type Target,
} from '../server/forecast.ts'

const DAY = 86_400_000
const NOW = 1_800_000_000_000

const done = (o: Partial<Done> & { words?: Set<string> }): Done => ({
  id: 1,
  grp: '',
  agentId: 1,
  tier: 'medium',
  words: wordsOf('Login Formular Validierung'),
  doneAt: NOW,
  usd: 1,
  tokens: 1000,
  runs: 2,
  ...o,
})
const target = (o: Partial<Target> = {}): Target => ({
  grp: '',
  agentId: 1,
  tier: 'medium',
  words: wordsOf('Login Formular Validierung reparieren'),
  ...o,
})

describe('similarity', () => {
  test('words are lower case, without punctuation, short words and stopwords', () => {
    assert.deepEqual([...wordsOf('Fix the Login-Button, und die API!')].sort(), [
      'api',
      'button',
      'fix',
      'login',
    ])
    assert.deepEqual([...wordsOf('Größe ändern')].sort(), ['größe', 'ändern'])
  })

  test('jaccard is shared over all words', () => {
    assert.equal(jaccard(new Set(['a', 'b']), new Set(['b', 'c'])), 1 / 3)
    assert.equal(jaccard(new Set(['a']), new Set(['a'])), 1)
    assert.equal(jaccard(new Set(), new Set()), 0)
  })

  test('another model tier is never similar', () => {
    assert.equal(similarity(target(), done({ tier: 'strong' })), 0)
  })

  test('same group and agent add to the word overlap', () => {
    const words = new Set(['other', 'words'])
    assert.equal(similarity(target({ grp: 'M1' }), done({ grp: 'M1', words })), 0.5)
    assert.equal(similarity(target({ agentId: 2 }), done({ words })), 0)
    // An empty group is no shared group.
    assert.equal(similarity(target({ agentId: null }), done({ words, agentId: null })), 0)
  })
})

describe('statistics', () => {
  test('weighted quantiles', () => {
    const points = [1, 2, 3, 4].map((value) => ({ value, weight: 1 }))
    assert.equal(weightedQuantile(points, 0.25), 1)
    assert.equal(weightedQuantile(points, 0.5), 2)
    assert.equal(weightedQuantile(points, 0.75), 3)
    // A heavy point pulls the median to itself.
    assert.equal(weightedQuantile([...points, { value: 10, weight: 10 }], 0.5), 10)
    assert.equal(weightedQuantile([], 0.5), 0)
  })

  test('no forecast below three similar issues', () => {
    const index = [done({ id: 1 }), done({ id: 2 }), done({ id: 3, tier: 'light' })]
    assert.equal(forecastFrom(target(), index, NOW), null)
  })

  test('median, range and sample size', () => {
    const index = [1, 2, 3, 4, 5].map((usd, i) => done({ id: i + 1, usd, tokens: usd * 1000, runs: usd }))
    const forecast = forecastFrom(target(), index, NOW)!
    assert.equal(forecast.sample, 5)
    assert.deepEqual(forecast.usd, { median: 3, low: 2, high: 4 })
    assert.equal(forecast.tokens.median, 3000)
    assert.equal(forecast.runs.median, 3)
  })

  test('recent issues weigh more than old ones', () => {
    const index = [
      done({ id: 1, usd: 1, doneAt: NOW - 365 * DAY }),
      done({ id: 2, usd: 1, doneAt: NOW - 365 * DAY }),
      done({ id: 3, usd: 1, doneAt: NOW - 365 * DAY }),
      done({ id: 4, usd: 5, doneAt: NOW }),
    ]
    assert.equal(forecastFrom(target(), index, NOW)!.usd.median, 5)
  })

  test('the cap warning goes by the median', () => {
    const forecast = forecastFrom(
      target(),
      [1, 2, 3].map((usd, i) => done({ id: i + 1, usd })),
      NOW,
    )
    assert.equal(exceedsCap(forecast, { usd: 1.5, tokens: 0 }), true)
    assert.equal(exceedsCap(forecast, { usd: 2, tokens: 0 }), false)
    assert.equal(exceedsCap(forecast, { usd: 0, tokens: 0 }), false)
    assert.equal(exceedsCap(null, { usd: 1, tokens: 0 }), false)
  })
})

describe('forecastFor', () => {
  const pid = Number(
    run("INSERT INTO projects (key, name, created_at) VALUES ('FC', 'Forecast', ?)", Date.now())
      .lastInsertRowid,
  )
  const agent = Number(
    run(
      "INSERT INTO agents (project_id, name, provider, model) VALUES (?, 'Dev', 'anthropic', 'claude-sonnet-5-5')",
      pid,
    ).lastInsertRowid,
  )
  const finished = (title: string, usd: number) => {
    const issue = createIssue(pid, { title, assignee_id: agent, grp: 'M1' })!
    run(
      `INSERT INTO runs (project_id, issue_id, agent_id, provider, model, status, started_at, ended_at,
         input_tokens, output_tokens, cost_usd) VALUES (?,?,?,'anthropic','','done',?,?,1000,500,?)`,
      pid,
      issue.id,
      agent,
      Date.now(),
      Date.now(),
      usd,
    )
    patchIssue(issue.id, { status: 'done' })
    return issue
  }

  test('reads similar finished issues and follows newly finished ones', () => {
    finished('Login Seite bauen', 0.3)
    finished('Login Formular', 0.5)
    const open = createIssue(pid, { title: 'Login Passwort', assignee_id: agent, grp: 'M1', status: 'todo' })!
    assert.equal(forecastFor(open.id), null, 'two are not enough')

    finished('Login Fehler', 0.7)
    const forecast = forecastFor(open.id)!
    assert.equal(forecast.sample, 3)
    assert.equal(forecast.usd.median, 0.5)
    assert.equal(forecast.tokens.median, 1500)
    assert.equal(forecast.runs.median, 1)

    // Reopening one drops it from the index again.
    const reopened = finished('Login Abmelden', 0.9)
    assert.equal(forecastFor(open.id)!.sample, 4)
    patchIssue(reopened.id, { status: 'todo' })
    assert.equal(forecastFor(open.id)!.sample, 3)
  })

  test('cap and warning in the view; done issues get no forecast', () => {
    run(
      'UPDATE projects SET settings=? WHERE id=?',
      JSON.stringify({ issueCap: { usd: 0.4, tokens: 0 } }),
      pid,
    )
    emit(pid, { t: 'reload' })
    const open = createIssue(pid, { title: 'Login Captcha', assignee_id: agent, grp: 'M1', status: 'todo' })!
    const view = forecastView(open.id)!
    assert.equal(view.cap.usd, 0.4)
    assert.equal(view.overCap, true)
    const closed = finished('Login Captcha zwei', 1)
    assert.equal(forecastFor(closed.id), null)
  })
})
