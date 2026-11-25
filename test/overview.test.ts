import './setup.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { all, get, run } from '../server/db.ts'
import { spendForecast, sinceSummary, agentScores, buildOverview, checkSpendGuard, dailyTrend, healthOf, guardSettings, killSwitch, saveGuardSettings } from '../server/overview.ts'

const now = Date.now()

function project(key: string, paused: boolean) {
  return Number(
    run(
      'INSERT INTO projects (key, name, repo_path, settings, paused, created_at) VALUES (?,?,?,?,?,?)',
      key,
      `Project ${key}`,
      '',
      '{}',
      paused ? 1 : 0,
      now,
    ).lastInsertRowid,
  )
}

function issue(projectId: number, number: number, status: string, title = `Issue ${number}`) {
  return Number(
    run(
      'INSERT INTO issues (project_id, number, title, status, priority, created_at, updated_at) VALUES (?,?,?,?,?,?,?)',
      projectId,
      number,
      title,
      status,
      2,
      now,
      now,
    ).lastInsertRowid,
  )
}

const alpha = project('ALP', false)
const beta = project('BET', true)
const stuck = issue(alpha, 1, 'blocked', 'Needs an owner')
issue(alpha, 2, 'done')
issue(alpha, 3, 'todo')
issue(beta, 1, 'backlog')
run("INSERT INTO comments (issue_id, author, kind, body, created_at) VALUES (?,?,?,?,?)", stuck, 'Lead', 'system', 'I am stuck.', now)
run(
  "INSERT INTO runs (project_id, issue_id, agent_name, provider, status, started_at, cost_usd) VALUES (?,?,?,?,'running',?,0)",
  alpha,
  issue(alpha, 4, 'in_progress'),
  'Dev',
  'anthropic',
  now - 5000,
)
run(
  "INSERT INTO runs (project_id, issue_id, agent_name, provider, status, started_at, ended_at, cost_usd, verdict) VALUES (?,?,?,?,'finished',?,?,?,'done')",
  alpha,
  issue(alpha, 5, 'done'),
  'QA',
  'openai',
  now - 60_000,
  now - 30_000,
  1.5,
)

test('overview counts issues per status and project', () => {
  const overview = buildOverview(now)
  const a = overview.projects.find((p) => p.key === 'ALP')!
  assert.equal(a.counts.blocked, 1)
  assert.equal(a.counts.done, 2)
  assert.equal(a.running, 1)
  assert.equal(overview.projects.find((p) => p.key === 'BET')!.paused, true)
  assert.equal(overview.totals.projects, 2)
  assert.equal(overview.totals.paused, 1)
})

test('overview lists what runs now, what waits for a human and what just finished', () => {
  const overview = buildOverview(now)
  assert.equal(overview.running.length, 1)
  assert.equal(overview.running[0].agent, 'Dev')
  assert.deepEqual(
    overview.inbox.map((i) => [i.projectKey, i.number, i.reason]),
    [['ALP', 1, 'I am stuck.']],
  )
  assert.equal(overview.feed[0].agent, 'QA')
  assert.equal(overview.feed[0].outcome, 'done')
  assert.equal(overview.feed[0].seconds, 30)
  assert.equal(overview.totals.runs24h, 2)
  assert.equal(overview.totals.cost24h, 1.5)
})

test('kill switch pauses active projects only and resume wakes exactly those', () => {
  const stopped = killSwitch('stop')
  assert.equal(stopped.paused, 1)
  assert.equal(get('SELECT paused FROM projects WHERE id=?', alpha).paused, 1)
  assert.equal(buildOverview().killSwitch, true)

  // Resume must not wake BET: the owner had paused it on purpose.
  const resumed = killSwitch('resume')
  assert.equal(resumed.resumed, 1)
  assert.equal(get('SELECT paused FROM projects WHERE id=?', alpha).paused, 0)
  assert.equal(get('SELECT paused FROM projects WHERE id=?', beta).paused, 1)
  assert.equal(buildOverview().killSwitch, false)
  assert.deepEqual(all('SELECT * FROM kill_switch'), [])
})

test('a second stop does not forget what the first one paused', () => {
  killSwitch('stop')
  killSwitch('stop')
  assert.equal(killSwitch('resume').resumed, 1)
  assert.equal(get('SELECT paused FROM projects WHERE id=?', alpha).paused, 0)
})

test('spend guard stays quiet below the cap and stops the fleet at it', () => {
  assert.equal(checkSpendGuard(now), false, 'off by default')
  saveGuardSettings({ capUsd: 100 })
  assert.equal(checkSpendGuard(now), false, '1.50 $ is below 100 $')

  saveGuardSettings({ capUsd: 1 })
  assert.equal(checkSpendGuard(now), true)
  assert.equal(get('SELECT paused FROM projects WHERE id=?', alpha).paused, 1)
  assert.ok(guardSettings().trippedAt > 0)
  assert.equal(checkSpendGuard(now), false, 'does not fire again while the switch is on')

  assert.throws(() => killSwitch('resume'), /spend limit/, 'resume while still over the cap is refused')
  saveGuardSettings({ capUsd: 0 })
  killSwitch('resume')
  assert.equal(get('SELECT paused FROM projects WHERE id=?', alpha).paused, 0)
})

test('spend guard refuses nonsense limits', () => {
  assert.throws(() => saveGuardSettings({ capUsd: -5 }))
  assert.throws(() => saveGuardSettings({ capUsd: 'abc' }))
  assert.throws(() => saveGuardSettings({ capUsd: 1e9 }))
  assert.equal(saveGuardSettings({ capUsd: 0 }).capUsd, 0)
})

test('daily trend has one entry per day, oldest first, with today holding the runs', () => {
  const days = dailyTrend(now, 7)
  assert.equal(days.length, 7)
  assert.ok(days[0].day < days[6].day)
  // The runs were seconds ago: today, or yesterday if the test runs right after UTC midnight.
  assert.equal(days[5].runs + days[6].runs, 2)
  assert.equal(days[5].cost + days[6].cost, 1.5)
  assert.equal(days[0].runs, 0)
})

test('health reports the data folder without throwing', () => {
  const health = healthOf()
  assert.ok(health.uptimeSec >= 0)
  assert.ok(health.dbMb >= 0)
  assert.ok(health.diskTotalGb >= health.diskFreeGb)
})

test('agent scores count done and failed runs, and leave stopped ones out of the rate', () => {
  const p = project('SCR', false)
  const i = issue(p, 1, 'done')
  const add = (status: string, seconds: number, cost: number) =>
    run(
      "INSERT INTO runs (project_id, issue_id, agent_name, provider, status, started_at, ended_at, cost_usd) VALUES (?,?,?,?,?,?,?,?)",
      p,
      i,
      'Scorer',
      'openai',
      status,
      now - seconds * 1000,
      now,
      cost,
    )
  add('done', 60, 1)
  add('done', 120, 1)
  add('failed', 30, 0.5)
  add('stopped', 10, 0)
  const row = agentScores(now).find((s) => s.agent === 'Scorer')!
  assert.equal(row.runs, 4)
  assert.equal(row.done, 2)
  assert.equal(row.failed, 1)
  assert.ok(Math.abs(row.successRate! - 2 / 3) < 1e-9)
  assert.equal(row.costUsd, 2.5)
  assert.equal(row.avgSeconds, 55)
})

test('since summary counts what happened after a time and clamps nonsense', () => {
  const recent = sinceSummary(now - 3_600_000, now + 1000)
  assert.ok(recent.runs >= 2)
  assert.ok(recent.costUsd >= 1.5)
  assert.equal(recent.hours, 1)

  const ancient = sinceSummary(0, now)
  assert.equal(ancient.hours, 30 * 24, 'never reaches back further than 30 days')
  assert.equal(sinceSummary(Number.NaN, now).hours, 0, 'garbage means nothing happened since')
  assert.equal(sinceSummary(now + 10 * 3_600_000, now).hours, 0, 'the future is clamped to now')
})

test('spend forecast projects the burn rate of the last three hours against the cap', () => {
  saveGuardSettings({ capUsd: 0 })
  assert.equal(spendForecast(now).hoursLeft, null, 'no cap, no forecast')
  assert.ok(spendForecast(now).perHour > 0, 'the runs of this file were seconds ago')

  const perHour = spendForecast(now).perHour
  saveGuardSettings({ capUsd: 1000 })
  const forecast = spendForecast(now)
  assert.ok(forecast.hoursLeft! > 0)
  assert.ok(Math.abs(forecast.hoursLeft! - (1000 - 4) / perHour) / forecast.hoursLeft! < 0.5, 'roughly (cap - spent) / rate')

  saveGuardSettings({ capUsd: 1 })
  assert.equal(spendForecast(now).hoursLeft, null, 'already over the cap')
  saveGuardSettings({ capUsd: 0 })
})
