// Numbers for the dashboard: what got done, who used how much, how the quotas moved.
// Everything is grouped by local calendar day, the way a person reads a week.
import { PROVIDERS } from './core.ts'
import { all, get } from './db.ts'

const DAY_MS = 86_400_000
const DAY_SQL = (column: string) => `date(${column}/1000, 'unixepoch', 'localtime')`

/** Start of the local day `daysAgo` days before today, in milliseconds. */
function dayStart(daysAgo: number) {
  const day = new Date()
  day.setHours(0, 0, 0, 0)
  day.setDate(day.getDate() - daysAgo)
  return day.getTime()
}

/** "2026-11-21" for every day of the range, oldest first, so charts have no holes. */
function dayLabels(days: number) {
  return Array.from({ length: days }, (_, index) => {
    const day = new Date(dayStart(days - 1 - index))
    const pad = (value: number) => String(value).padStart(2, '0')
    return `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`
  })
}

export function projectStats(projectId: number, days: number) {
  const labels = dayLabels(days)
  const since = dayStart(days - 1)
  const countByDay = (rows: { day: string; count: number }[]) => {
    const byDay = new Map(rows.map((row) => [row.day, row.count]))
    return labels.map((day) => byDay.get(day) ?? 0)
  }

  const done = countByDay(
    all(
      `SELECT ${DAY_SQL('done_at')} AS day, COUNT(*) AS count FROM issues
       WHERE project_id=? AND done_at>=? GROUP BY day`,
      projectId,
      since,
    ),
  )
  const created = countByDay(
    all(
      `SELECT ${DAY_SQL('created_at')} AS day, COUNT(*) AS count FROM issues
       WHERE project_id=? AND created_at>=? GROUP BY day`,
      projectId,
      since,
    ),
  )

  // Open issues at the end of each day: what was open before the range, plus created, minus done.
  const openBefore = get(
    `SELECT COUNT(*) AS count FROM issues
     WHERE project_id=? AND created_at<? AND (done_at IS NULL OR done_at>=?)`,
    projectId,
    since,
    since,
  )!.count
  let stillOpen = openBefore
  const open = labels.map((_, index) => (stillOpen += created[index] - done[index]))

  const agentDays = all(
    `SELECT ${DAY_SQL('started_at')} AS day, agent_name AS agent, COUNT(*) AS runs,
            SUM(input_tokens - cached_tokens + output_tokens) AS fresh, SUM(cached_tokens) AS cached,
            SUM(status='failed') AS failed, SUM(COALESCE(ended_at, started_at) - started_at) AS ms
     FROM runs WHERE project_id=? AND started_at>=? GROUP BY day, agent`,
    projectId,
    since,
  )
  const agents = [...new Set(agentDays.map((row) => row.agent))].sort()
  const perAgent = (pick: (row: any) => number) =>
    agents.map((agent) => ({
      agent,
      values: labels.map((day) => {
        const row = agentDays.find((candidate) => candidate.agent === agent && candidate.day === day)
        return row ? pick(row) : 0
      }),
    }))

  const agentTotals = all(
    `SELECT agent_name AS agent, COUNT(*) AS runs, SUM(status='failed') AS failed,
            SUM(input_tokens - cached_tokens + output_tokens) AS fresh, SUM(cached_tokens) AS cached,
            SUM(cost_usd) AS cost, AVG(COALESCE(ended_at, started_at) - started_at) AS avgMs
     FROM runs WHERE project_id=? AND started_at>=? AND status!='running' GROUP BY agent ORDER BY runs DESC`,
    projectId,
    since,
  )

  // Quota left at the end of each day, per provider. A day without a reading keeps the last one.
  const readings = all(
    `SELECT provider, ${DAY_SQL('at')} AS day, utilization FROM quota_history
     WHERE at>=? ORDER BY at`,
    since,
  )
  const quota = Object.keys(PROVIDERS)
    .map((provider) => {
      const lastOfDay = new Map<string, number>()
      for (const reading of readings) {
        if (reading.provider === provider) lastOfDay.set(reading.day, reading.utilization)
      }
      let last: number | null = null
      const values = labels.map((day) => {
        if (lastOfDay.has(day)) last = Math.round(100 * (1 - lastOfDay.get(day)!))
        return last
      })
      return { provider, label: PROVIDERS[provider].label, values }
    })
    .filter((series) => series.values.some((value) => value !== null))

  const today = dayStart(0)
  const count = (sql: string, ...params: unknown[]) => get(sql, projectId, ...params)!.count as number
  const runs = get(
    `SELECT COUNT(*) AS runs, COALESCE(SUM(status='failed'), 0) AS failed,
            AVG(COALESCE(ended_at, started_at) - started_at) AS avgMs
     FROM runs WHERE project_id=? AND started_at>=? AND status!='running'`,
    projectId,
    since,
  )!

  return {
    ...outcomes(projectId, since),
    days: labels,
    totals: {
      doneToday: count('SELECT COUNT(*) AS count FROM issues WHERE project_id=? AND done_at>=?', today),
      doneWeek: count(
        'SELECT COUNT(*) AS count FROM issues WHERE project_id=? AND done_at>=?',
        today - 6 * DAY_MS,
      ),
      doneAll: count("SELECT COUNT(*) AS count FROM issues WHERE project_id=? AND status='done'"),
      open: count("SELECT COUNT(*) AS count FROM issues WHERE project_id=? AND status!='done'"),
      runs: runs.runs,
      failedRuns: runs.failed,
      avgRunSeconds: Math.round((runs.avgMs ?? 0) / 1000),
    },
    done,
    created,
    open,
    freshTokens: perAgent((row) => row.fresh),
    runsPerDay: perAgent((row) => row.runs),
    agentTotals,
    quota,
  }
}

/**
 * What the runs achieved, not only what they cost: per agent how much of its work landed and how
 * often reviewers approved it, per model how often a run ended with a usable result.
 */
function outcomes(projectId: number, since: number) {
  const outcomeByAgent = all(
    `SELECT a.name AS agent,
       (SELECT COUNT(*) FROM issues i WHERE i.maker_id = a.id AND i.done_at >= ?) AS landed,
       (SELECT COUNT(*) FROM runs r JOIN issues i ON i.id = r.issue_id
          WHERE i.maker_id = a.id AND r.kind = 'review' AND r.verdict = 'approve' AND r.started_at >= ?) AS approved,
       (SELECT COUNT(*) FROM runs r JOIN issues i ON i.id = r.issue_id
          WHERE i.maker_id = a.id AND r.kind = 'review' AND r.verdict = 'changes' AND r.started_at >= ?) AS changes,
       (SELECT COALESCE(SUM(r.cost_usd), 0) FROM runs r JOIN issues i ON i.id = r.issue_id
          WHERE i.maker_id = a.id AND i.done_at >= ?) AS landedCost
     FROM agents a WHERE a.project_id = ?`,
    since,
    since,
    since,
    since,
    projectId,
  )
    .filter((row) => row.landed || row.approved || row.changes)
    .map((row) => ({
      agent: row.agent,
      landed: row.landed,
      approvalRate: row.approved + row.changes ? row.approved / (row.approved + row.changes) : null,
      costPerLanded: row.landed ? row.landedCost / row.landed : null,
    }))
    .sort((a, b) => b.landed - a.landed)

  // A work run is usable when it handed in a result: done, review or a handoff. Reviews count
  // when they reached a verdict. Failed runs, stops and "blocked" are not usable. Finished runs
  // without a verdict are from before verdicts were recorded; they say nothing either way.
  const outcomeByModel = all(
    `SELECT provider, CASE WHEN model = '' THEN '(Standard)' ELSE model END AS model, COUNT(*) AS runs,
       SUM(status = 'failed') AS failed,
       SUM(status = 'done' AND verdict IN ('done', 'review', 'handoff', 'partial', 'approve', 'changes')) AS usable,
       COALESCE(SUM(cost_usd), 0) AS cost
     FROM runs WHERE project_id = ? AND started_at >= ? AND status != 'running' AND agent_name != 'Watchdog'
       AND NOT (status = 'done' AND verdict = '')
     GROUP BY provider, model ORDER BY runs DESC`,
    projectId,
    since,
  ).map((row) => ({
    provider: row.provider,
    label: PROVIDERS[row.provider]?.label ?? row.provider,
    model: row.model,
    runs: row.runs,
    failed: row.failed,
    usableRate: row.runs ? row.usable / row.runs : 0,
    costPerRun: row.runs ? row.cost / row.runs : 0,
  }))

  return { outcomeByAgent, outcomeByModel }
}
