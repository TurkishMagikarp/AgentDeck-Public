// The morning report: one look at what happened in the last 24 hours across all projects.
// One line per project, at most two bullets below it, nothing else. Sent by mail and push.
import { PROVIDERS } from './core.ts'
import { all, get, run } from './db.ts'
import { mailSettings, sendMail } from './notify.ts'
import { sendPush } from './push.ts'
import { clock, restOf } from './recovery.ts'

const DAY_MS = 86_400_000
const setting = (key: string): string => get('SELECT value FROM settings WHERE key=?', key)?.value ?? ''
const saveSetting = (key: string, value: string) =>
  run('INSERT OR REPLACE INTO settings (key, value) VALUES (?,?)', key, value)

/** "07:30", or empty when the report is off. */
export const reportSettings = () => ({ at: setting('report.at') })

export function saveReportSettings(input: { at?: string }) {
  const at = String(input.at ?? '').trim()
  if (at && !/^([01]\d|2[0-3]):[0-5]\d$/.test(at)) throw new Error('Time in the format HH:MM')
  saveSetting('report.at', at)
  return reportSettings()
}

function projectLines(project: any, since: number) {
  const count = (sql: string) => get(sql, project.id, since)!.count as number
  const done = count('SELECT COUNT(*) AS count FROM issues WHERE project_id=? AND done_at>=?')
  const failed = count(
    "SELECT COUNT(*) AS count FROM runs WHERE project_id=? AND started_at>=? AND status='failed'",
  )
  const cost = get(
    'SELECT COALESCE(SUM(cost_usd),0) AS cost FROM runs WHERE project_id=? AND started_at>=?',
    project.id,
    since,
  )!.cost as number
  const open = get(
    "SELECT COUNT(*) AS count FROM issues WHERE project_id=? AND status IN ('todo','in_progress','review','blocked')",
    project.id,
  )!.count as number
  const parked = all(
    `SELECT DISTINCT i.number, i.title FROM comments c JOIN issues i ON i.id = c.issue_id
     WHERE i.project_id=? AND c.created_at>=? AND c.kind='watchdog' AND c.body LIKE 'Parked:%'
       AND i.status='backlog'`,
    project.id,
    since,
  )
  const finished = all(
    'SELECT number, title FROM issues WHERE project_id=? AND done_at>=? ORDER BY done_at DESC LIMIT 2',
    project.id,
    since,
  )

  const facts = [`${done} done`, `${open} open`]
  if (parked.length) facts.push(`${parked.length} parked`)
  if (failed) facts.push(`${failed} ${failed === 1 ? 'failed run' : 'failed runs'}`)
  if (cost >= 0.01) facts.push(`$${cost.toFixed(2)}`)
  const head = `${project.key}${project.paused ? ' (paused)' : ''}: ${facts.join(', ')}`

  // Parked work needs the owner's eye more than finished work, so it comes first.
  const bullets = [
    ...parked.map((issue) => `Parked: ${project.key}-${issue.number} ${issue.title}`),
    ...finished.map((issue) => `Done: ${project.key}-${issue.number} ${issue.title}`),
  ]
    .slice(0, 2)
    .map((text) => `  - ${text.slice(0, 90)}`)
  return { head, bullets, done, parked: parked.length, active: done + open + failed > 0 }
}

export function buildReport(now = Date.now()) {
  const since = now - DAY_MS
  const projects = all('SELECT id, key, name, paused FROM projects ORDER BY key')
  const sections = projects.map((project) => projectLines(project, since))
  const done = sections.reduce((sum, section) => sum + section.done, 0)
  const parked = sections.reduce((sum, section) => sum + section.parked, 0)

  const resting = Object.keys(PROVIDERS)
    .map((provider) => ({ provider, rest: restOf(provider) }))
    .filter((entry) => entry.rest)
    .map((entry) => `${PROVIDERS[entry.provider].label} paused until ${clock(entry.rest!.until)}`)

  const summary = `Last 24 h: ${done} done${parked ? `, ${parked} parked` : ''}.`
  const lines = [
    summary,
    '',
    // Quiet projects take one line each at the end, so the busy ones are read first.
    ...sections.filter((section) => section.active).flatMap((section) => [section.head, ...section.bullets]),
    ...sections.filter((section) => !section.active).map((section) => section.head),
    ...(resting.length ? ['', ...resting] : []),
  ]
  return { summary, text: lines.join('\n') }
}

export async function sendReport() {
  const report = buildReport()
  const { inbox, to, hasKey } = mailSettings()
  const jobs: Promise<unknown>[] = [sendPush('AgentDeck: Morning report', report.summary, '/')]
  if (inbox && to && hasKey) jobs.push(sendMail(`[AgentDeck] Morning report: ${report.summary}`, report.text))
  await Promise.all(jobs)
  return report
}

/** Sends once a day when the clock passes the set time. The server's time zone applies (TZ). */
function sendIfDue(now = new Date()) {
  const { at } = reportSettings()
  if (!at) return
  const [hours, minutes] = at.split(':').map(Number)
  const due = new Date(now)
  due.setHours(hours, minutes, 0, 0)
  if (now < due || Number(setting('report.last')) >= due.getTime()) return
  saveSetting('report.last', String(now.getTime()))
  sendReport().catch((error) => console.error('report', error.message))
}

export function startReports() {
  setInterval(() => {
    try {
      sendIfDue()
    } catch (error) {
      console.error('report', error)
    }
  }, 60_000).unref()
}
