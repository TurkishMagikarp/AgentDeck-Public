// The morning report: one look at what happened in the last 24 hours across all projects.
// One line per project, at most two bullets below it, nothing else. Sent by mail and push.
// It covers every project, so it is written in the language of the instance.
import { PROVIDERS } from './core.ts'
import { all, get, run } from './db.ts'
import { instanceLang, t, variants, withLang } from './i18n.ts'
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
  if (at && !/^([01]\d|2[0-3]):[0-5]\d$/.test(at)) throw new Error(t('Uhrzeit im Format HH:MM'))
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
  // The note may have been written while the project spoke the other language, so both forms count.
  const parkedNotes = variants('Geparkt:')
  const parked = all(
    `SELECT DISTINCT i.number, i.title FROM comments c JOIN issues i ON i.id = c.issue_id
     WHERE i.project_id=? AND c.created_at>=? AND c.kind='watchdog'
       AND (${parkedNotes.map(() => 'c.body LIKE ?').join(' OR ')})
       AND i.status='backlog'`,
    project.id,
    since,
    ...parkedNotes.map((start) => `${start}%`),
  )
  const finished = all(
    'SELECT number, title FROM issues WHERE project_id=? AND done_at>=? ORDER BY done_at DESC LIMIT 2',
    project.id,
    since,
  )

  const facts = [t('{n} erledigt', { n: done }), t('{n} offen', { n: open })]
  if (parked.length) facts.push(t('{n} geparkt', { n: parked.length }))
  if (failed) facts.push(failed === 1 ? t('1 Fehllauf') : t('{n} Fehlläufe', { n: failed }))
  if (cost >= 0.01) facts.push(`$${cost.toFixed(2)}`)
  const name = project.paused ? t('{key} (pausiert)', { key: project.key }) : project.key
  const head = `${name}: ${facts.join(', ')}`

  // Parked work needs the owner's eye more than finished work, so it comes first.
  const titleOf = (issue: any) => `${project.key}-${issue.number} ${issue.title}`
  const bullets = [
    ...parked.map((issue) => t('Geparkt: {issue}', { issue: titleOf(issue) })),
    ...finished.map((issue) => t('Fertig: {issue}', { issue: titleOf(issue) })),
  ]
    .slice(0, 2)
    .map((text) => `  - ${text.slice(0, 90)}`)
  return { head, bullets, done, parked: parked.length, active: done + open + failed > 0 }
}

export const buildReport = (now = Date.now()) => withLang(instanceLang(), () => compose(now))

function compose(now: number) {
  const since = now - DAY_MS
  const projects = all('SELECT id, key, name, paused FROM projects ORDER BY key')
  const sections = projects.map((project) => projectLines(project, since))
  const done = sections.reduce((sum, section) => sum + section.done, 0)
  const parked = sections.reduce((sum, section) => sum + section.parked, 0)

  const resting = Object.keys(PROVIDERS)
    .map((provider) => ({ provider, rest: restOf(provider) }))
    .filter((entry) => entry.rest)
    .map((entry) =>
      t('{provider} pausiert bis {time}', {
        provider: PROVIDERS[entry.provider].label,
        time: clock(entry.rest!.until),
      }),
    )

  const summary = parked
    ? t('Letzte 24 h: {done} erledigt, {parked} geparkt.', { done, parked })
    : t('Letzte 24 h: {done} erledigt.', { done })
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

export const sendReport = () =>
  withLang(instanceLang(), async () => {
    const report = buildReport()
    const { inbox, to, hasKey } = mailSettings()
    const jobs: Promise<unknown>[] = [sendPush(t('AgentDeck: Morgenbericht'), report.summary, '/')]
    if (inbox && to && hasKey) {
      const subject = t('[AgentDeck] Morgenbericht: {summary}', { summary: report.summary })
      jobs.push(sendMail(subject, report.text))
    }
    await Promise.all(jobs)
    return report
  })

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
