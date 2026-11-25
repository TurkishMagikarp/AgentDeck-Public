import { statSync, statfsSync } from 'node:fs'
import { join } from 'node:path'
import { all, DATA_DIR, db, get, run, tx } from './db.ts'
import { activity, touch } from './core.ts'
import { kick, stopRun } from './engine.ts'
import { sendPush } from './push.ts'

/**
 * Mission Control: one answer to "what is my fleet doing and what needs me?", across projects.
 * Read-only except for the kill switch at the bottom.
 */

db.exec(`
-- Projects the kill switch paused, so "resume" does not wake projects the owner had paused on purpose.
CREATE TABLE IF NOT EXISTS kill_switch (
  project_id INTEGER PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  at INTEGER NOT NULL
);
`)

const DAY = 24 * 60 * 60 * 1000

const setting = (key: string): string => get('SELECT value FROM settings WHERE key=?', key)?.value ?? ''
const saveSetting = (key: string, value: string) =>
  run('INSERT OR REPLACE INTO settings (key, value) VALUES (?,?)', key, value)

/** The spend guard: when the fleet spends more than `capUsd` in 24 hours, the kill switch fires. 0 = off. */
export function guardSettings() {
  return { capUsd: Number(setting('guard.capUsd')) || 0, trippedAt: Number(setting('guard.trippedAt')) || 0 }
}

export function saveGuardSettings(input: { capUsd?: unknown }) {
  const capUsd = Number(input.capUsd)
  if (!Number.isFinite(capUsd) || capUsd < 0 || capUsd > 100_000) throw new Error('Limit: a number between 0 and 100000')
  saveSetting('guard.capUsd', String(Math.round(capUsd * 100) / 100))
  saveSetting('guard.trippedAt', '0')
  return guardSettings()
}

const spentSince = (since: number): number =>
  // A run counts when it ended inside the window, even if it started before it; running ones count from their start.
  get('SELECT COALESCE(SUM(cost_usd),0) AS cost FROM runs WHERE COALESCE(ended_at, started_at) > ?', since)?.cost ?? 0

/** Checks the cap once. Returns true when it stopped the fleet. Exported for tests. */
export function checkSpendGuard(now = Date.now()) {
  const { capUsd } = guardSettings()
  if (!capUsd || get('SELECT 1 FROM kill_switch')) return false
  const spent = spentSince(now - DAY)
  if (spent < capUsd) return false
  saveSetting('guard.trippedAt', String(now))
  const result = killSwitch('stop', 'Spend limit')
  sendPush(
    'AgentDeck: spend limit reached',
    `$${spent.toFixed(2)} in 24 h (limit $${capUsd}). ${result.paused} projects paused.`,
  ).catch(() => {})
  return true
}

export function startSpendGuard() {
  setInterval(() => {
    try {
      checkSpendGuard()
    } catch (error: any) {
      console.error('spend guard', error.message)
    }
  }, 30_000).unref()
}

export type OverviewProject = {
  id: number
  key: string
  name: string
  paused: boolean
  counts: Record<string, number>
  running: number
  costToday: number
  lastActivity: number
}

export type OverviewRun = {
  id: number
  projectKey: string
  projectId: number
  issueId: number
  issueNumber: number
  issueTitle: string
  agent: string
  provider: string
  model: string
  startedAt: number
  /** The last thing the agent said or did, as the board's live line shows it. */
  line: string
}

export type InboxItem = {
  projectKey: string
  projectId: number
  issueId: number
  number: number
  title: string
  status: string
  priority: number
  since: number
  reason: string
}

export type FeedItem = {
  at: number
  projectKey: string
  issueNumber: number
  issueTitle: string
  agent: string
  outcome: string
  costUsd: number
  seconds: number
}

/** What an unattended server dies of first: a full disk. Plus uptime and memory, for a glance. */
export function healthOf() {
  let diskFreeGb = 0
  let diskTotalGb = 0
  let dbMb = 0
  try {
    const fs = statfsSync(DATA_DIR)
    diskFreeGb = (fs.bavail * fs.bsize) / 1e9
    diskTotalGb = (fs.blocks * fs.bsize) / 1e9
  } catch {
    // Not every platform reports it; the page then shows no disk line.
  }
  try {
    dbMb = statSync(join(DATA_DIR, 'agentdeck.db')).size / 1e6
  } catch {
    // The file is created on first write.
  }
  return {
    uptimeSec: Math.round(process.uptime()),
    memoryMb: Math.round(process.memoryUsage().rss / 1e6),
    dbMb: Math.round(dbMb * 10) / 10,
    diskFreeGb: Math.round(diskFreeGb * 10) / 10,
    diskTotalGb: Math.round(diskTotalGb * 10) / 10,
  }
}

/** Cost, runs and failures per day for the last two weeks, oldest first, empty days included. */
export function dailyTrend(now = Date.now(), days = 14) {
  const start = new Date(now)
  start.setUTCHours(0, 0, 0, 0)
  const first = start.getTime() - (days - 1) * DAY
  const rows = all(
    `SELECT CAST((started_at - ?) / ? AS INTEGER) AS d, COUNT(*) AS runs,
       COALESCE(SUM(cost_usd),0) AS cost, COALESCE(SUM(status='failed'),0) AS failed
     FROM runs WHERE started_at >= ? GROUP BY d`,
    first,
    DAY,
    first,
  )
  return Array.from({ length: days }, (_, index) => {
    const row = rows.find((r) => r.d === index)
    return {
      day: new Date(first + index * DAY).toISOString().slice(0, 10),
      runs: row?.runs ?? 0,
      cost: row?.cost ?? 0,
      failed: row?.failed ?? 0,
    }
  })
}

/** How each agent did in the last week: the numbers to look at before changing a model or a prompt. */
export function agentScores(now = Date.now(), days = 7) {
  return all(
    `SELECT p.key AS pkey, r.agent_name AS agent, r.provider, COUNT(*) AS runs,
       COALESCE(SUM(r.status='done'),0) AS done, COALESCE(SUM(r.status='failed'),0) AS failed,
       COALESCE(SUM(r.status='stopped'),0) AS stopped,
       AVG(CASE WHEN r.ended_at IS NOT NULL THEN r.ended_at - r.started_at END) AS avg_ms,
       COALESCE(SUM(r.cost_usd),0) AS cost
     FROM runs r JOIN projects p ON p.id=r.project_id
     WHERE r.started_at > ? AND r.agent_name != '' AND r.status != 'running'
     GROUP BY r.project_id, r.agent_name, r.provider
     ORDER BY runs DESC LIMIT 40`,
    now - days * DAY,
  ).map((row) => ({
    projectKey: row.pkey,
    agent: row.agent,
    provider: row.provider,
    runs: row.runs,
    done: row.done,
    failed: row.failed,
    stopped: row.stopped,
    // Stopped runs were the owner's or the watchdog's call, so they count for neither side.
    successRate: row.done + row.failed ? row.done / (row.done + row.failed) : null,
    avgSeconds: row.avg_ms ? Math.round(row.avg_ms / 1000) : 0,
    costUsd: row.cost,
  }))
}

/** What happened while the owner was away: the one line a returning person wants first. */
export function sinceSummary(since: number, now = Date.now()) {
  // Clamped to the last 30 days: the page asks with a stored time, which may be ancient or garbage.
  const from = Math.min(now, Math.max(now - 30 * DAY, Number.isFinite(since) ? since : now))
  const runs = get(
    `SELECT COUNT(*) AS runs, COALESCE(SUM(status='failed'),0) AS failed, COALESCE(SUM(cost_usd),0) AS cost
     FROM runs WHERE started_at > ?`,
    from,
  )
  const closed = get(`SELECT COUNT(*) AS n FROM issue_events WHERE field='status' AND new='done' AND at > ?`, from)
  const blocked = get(`SELECT COUNT(*) AS n FROM issue_events WHERE field='status' AND new='blocked' AND at > ?`, from)
  return {
    from,
    hours: Math.round(((now - from) / 3_600_000) * 10) / 10,
    closed: closed?.n ?? 0,
    blocked: blocked?.n ?? 0,
    runs: runs?.runs ?? 0,
    failed: runs?.failed ?? 0,
    costUsd: runs?.cost ?? 0,
  }
}

/**
 * How long until the spend cap is reached if the last three hours are anything to go by.
 * Null when no cap is set, nothing was spent lately, or the cap is reached already.
 */
export function spendForecast(now = Date.now()) {
  const { capUsd } = guardSettings()
  const recent = spentSince(now - 3 * 3_600_000)
  const rollingDay = spentSince(now - DAY)
  const perHour = recent / 3
  if (!capUsd || perHour <= 0 || rollingDay >= capUsd) return { perHour, hoursLeft: null }
  return { perHour, hoursLeft: Math.round(((capUsd - rollingDay) / perHour) * 10) / 10 }
}

export function buildOverview(now = Date.now()) {
  const projects: OverviewProject[] = all(
    `SELECT id, key, name, paused FROM projects ORDER BY name`,
  ).map((p) => ({
    id: p.id,
    key: p.key,
    name: p.name,
    paused: !!p.paused,
    counts: {},
    running: 0,
    costToday: 0,
    lastActivity: 0,
  }))
  const byId = new Map(projects.map((p) => [p.id, p]))

  for (const row of all(`SELECT project_id, status, COUNT(*) AS n, MAX(updated_at) AS last FROM issues GROUP BY project_id, status`)) {
    const project = byId.get(row.project_id)
    if (!project) continue
    project.counts[row.status] = row.n
    project.lastActivity = Math.max(project.lastActivity, row.last ?? 0)
  }
  for (const row of all(
    `SELECT project_id, SUM(cost_usd) AS cost FROM runs WHERE started_at > ? GROUP BY project_id`,
    now - DAY,
  )) {
    const project = byId.get(row.project_id)
    if (project) project.costToday = row.cost ?? 0
  }

  const running: OverviewRun[] = all(
    `SELECT r.id, r.project_id, p.key AS pkey, r.issue_id, i.number, i.title, r.agent_name, r.provider, r.model, r.started_at
     FROM runs r JOIN issues i ON i.id=r.issue_id JOIN projects p ON p.id=r.project_id
     WHERE r.status='running' ORDER BY r.started_at`,
  ).map((r) => ({
    id: r.id,
    projectId: r.project_id,
    projectKey: r.pkey,
    issueId: r.issue_id,
    issueNumber: r.number,
    issueTitle: r.title,
    agent: r.agent_name,
    provider: r.provider,
    model: r.model,
    startedAt: r.started_at,
    line: (activity.get(r.id)?.text ?? '').slice(0, 200),
  }))
  for (const r of running) {
    const project = byId.get(r.projectId)
    if (project) project.running += 1
  }

  // Issues a person has to look at: the "waits for a human" column, oldest first.
  const inbox: InboxItem[] = all(
    `SELECT i.id, i.project_id, p.key AS pkey, i.number, i.title, i.status, i.priority, i.updated_at,
       (SELECT body FROM comments c WHERE c.issue_id=i.id AND c.kind IN ('system','watchdog','comment') ORDER BY c.id DESC LIMIT 1) AS reason
     FROM issues i JOIN projects p ON p.id=i.project_id
     WHERE i.status='blocked' ORDER BY i.priority DESC, i.updated_at LIMIT 50`,
  ).map((i) => ({
    projectId: i.project_id,
    projectKey: i.pkey,
    issueId: i.id,
    number: i.number,
    title: i.title,
    status: i.status,
    priority: i.priority,
    since: i.updated_at,
    reason: String(i.reason ?? '').slice(0, 300),
  }))

  const feed: FeedItem[] = all(
    `SELECT r.ended_at, p.key AS pkey, i.number, i.title, r.agent_name, r.status, r.verdict, r.cost_usd, r.started_at
     FROM runs r JOIN issues i ON i.id=r.issue_id JOIN projects p ON p.id=r.project_id
     WHERE r.status!='running' AND r.ended_at IS NOT NULL ORDER BY r.ended_at DESC LIMIT 25`,
  ).map((r) => ({
    at: r.ended_at,
    projectKey: r.pkey,
    issueNumber: r.number,
    issueTitle: r.title,
    agent: r.agent_name,
    outcome: r.status === 'failed' ? 'failed' : r.verdict || r.status,
    costUsd: r.cost_usd,
    seconds: Math.max(0, Math.round((r.ended_at - r.started_at) / 1000)),
  }))

  const day = get(
    `SELECT COUNT(*) AS runs, COALESCE(SUM(cost_usd),0) AS cost,
       COALESCE(SUM(input_tokens+output_tokens),0) AS tokens,
       COALESCE(SUM(status='failed'),0) AS failed
     FROM runs WHERE started_at > ?`,
    now - DAY,
  )
  const closedToday = get(
    `SELECT COUNT(*) AS n FROM issue_events WHERE field='status' AND new='done' AND at > ?`,
    now - DAY,
  )

  return {
    at: now,
    projects,
    running,
    inbox,
    feed,
    totals: {
      runs24h: day?.runs ?? 0,
      failed24h: day?.failed ?? 0,
      cost24h: day?.cost ?? 0,
      tokens24h: day?.tokens ?? 0,
      closed24h: closedToday?.n ?? 0,
      paused: projects.filter((p) => p.paused).length,
      projects: projects.length,
    },
    killSwitch: all(`SELECT project_id FROM kill_switch`).length > 0,
    guard: { ...guardSettings(), spentUsd: day?.cost ?? 0, ...spendForecast(now) },
    daily: dailyTrend(now),
    agents: agentScores(now),
    health: healthOf(),
  }
}

/**
 * The red button: pauses every project that is running and stops what is running right now.
 * Stopped issues go back to "todo" with a comment, nothing is lost. `resume` wakes exactly the
 * projects this switch paused.
 */
export function killSwitch(action: 'stop' | 'resume', actor = 'Owner') {
  if (action === 'stop') {
    const at = Date.now()
    const live = all(`SELECT id, project_id FROM runs WHERE status='running'`)
    const projects = all(`SELECT id FROM projects WHERE paused=0`)
    // All or nothing: a crash halfway must not leave projects paused that "resume" does not know about.
    tx(() => {
      for (const { id } of projects) {
        run('INSERT OR IGNORE INTO kill_switch (project_id, at) VALUES (?, ?)', id, at)
        run('UPDATE projects SET paused=1 WHERE id=?', id)
      }
    })
    let stopped = 0
    for (const r of live)
      if (stopRun(r.id, `Kill switch: ${actor === 'Owner' ? 'The owner' : actor} paused all projects.`, 'todo', actor)) stopped++
    for (const { id } of projects) touch(id)
    return { paused: projects.length, stopped }
  }

  // Waking up while the cap is still reached would stop everything again within 30 seconds.
  const { capUsd } = guardSettings()
  if (capUsd && spentSince(Date.now() - DAY) >= capUsd)
    throw new Error('The spend limit is still reached. Raise it first or wait until the costs of the last 24 hours fall below it.')

  const projects = all(`SELECT project_id FROM kill_switch`)
  for (const { project_id } of projects) {
    run('UPDATE projects SET paused=0 WHERE id=?', project_id)
    touch(project_id)
  }
  run('DELETE FROM kill_switch')
  kick()
  return { resumed: projects.length }
}
