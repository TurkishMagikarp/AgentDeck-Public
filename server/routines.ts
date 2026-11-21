// Routines: work that comes back on a schedule, like a daily report. When a routine is due it
// files an issue for its agent. The agent then handles it like any other issue.
import { createIssue, touch } from './core.ts'
import { all, get, run, tx } from './db.ts'

type Routine = {
  id: number
  project_id: number
  name: string
  agent_id: number | null
  prompt: string
  schedule: 'daily' | 'interval'
  at: string
  every_minutes: number
  enabled: number
  last_fired_at: number
}

/** Daily routines fire once the clock passes their time; the server's time zone applies (TZ). */
function isDue(routine: Routine, now: Date) {
  if (routine.schedule === 'interval') {
    return now.getTime() - routine.last_fired_at >= routine.every_minutes * 60_000
  }
  const [hours, minutes] = routine.at.split(':').map(Number)
  const todayAt = new Date(now)
  todayAt.setHours(hours || 0, minutes || 0, 0, 0)
  return now >= todayAt && routine.last_fired_at < todayAt.getTime()
}

function fire(routine: Routine, now: Date) {
  run('UPDATE routines SET last_fired_at=? WHERE id=?', now.getTime(), routine.id)

  // If the last issue of this routine is still open, a second one would only pile up.
  const stillOpen = get("SELECT 1 FROM issues WHERE routine_id=? AND status NOT IN ('done')", routine.id)
  if (stillOpen) return false

  const date = now.toLocaleDateString('en-US')
  tx(() =>
    createIssue(routine.project_id, {
      title: `${routine.name} (${date})`,
      description: routine.prompt,
      status: 'todo',
      assignee_id: routine.agent_id,
      grp: 'Routines',
      routine_id: routine.id,
    }),
  )
  return true
}

/** Returns true when at least one issue was filed, so the caller can wake the scheduler. */
export function runDueRoutines(now = new Date()) {
  const routines = all<Routine>(
    `SELECT r.* FROM routines r JOIN projects p ON p.id = r.project_id WHERE r.enabled=1 AND p.paused=0`,
  )
  let filed = false
  for (const routine of routines) {
    if (isDue(routine, now) && fire(routine, now)) filed = true
  }
  return filed
}

export function startRoutines(onFiled: () => void) {
  setInterval(() => {
    try {
      if (runDueRoutines()) onFiled()
    } catch (e) {
      console.error('routines', e)
    }
  }, 30_000).unref()
}

// ---------- editing ----------

const text = (value: unknown, max: number) => String(value ?? '').slice(0, max)

function fields(body: any, current: Partial<Routine> = {}) {
  const name = text(body.name ?? current.name, 120).trim()
  if (!name) throw new Error('Name is missing')
  const at = text(body.at ?? current.at ?? '07:00', 5)
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(at)) throw new Error('Give the time as HH:MM')

  return [
    name,
    Number(body.agent_id ?? current.agent_id) || null,
    text(body.prompt ?? current.prompt, 20_000),
    (body.schedule ?? current.schedule) === 'interval' ? 'interval' : 'daily',
    at,
    Math.max(5, Number(body.every_minutes ?? current.every_minutes ?? 60) || 60),
    (body.enabled ?? current.enabled ?? true) ? 1 : 0,
  ]
}

export const listRoutines = (projectId: number) =>
  all<Routine>('SELECT * FROM routines WHERE project_id=? ORDER BY name', projectId)

export function createRoutine(projectId: number, body: any) {
  // A new routine waits for its next slot instead of firing at once for a time already past today.
  const inserted = run(
    `INSERT INTO routines (name, agent_id, prompt, schedule, at, every_minutes, enabled, project_id, last_fired_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    ...fields(body),
    projectId,
    Date.now(),
  )
  touch(projectId)
  return get<Routine>('SELECT * FROM routines WHERE id=?', inserted.lastInsertRowid)
}

export function updateRoutine(id: number, body: any) {
  const current = get<Routine>('SELECT * FROM routines WHERE id=?', id)
  if (!current) return null
  run(
    'UPDATE routines SET name=?, agent_id=?, prompt=?, schedule=?, at=?, every_minutes=?, enabled=? WHERE id=?',
    ...fields(body, current),
    id,
  )
  touch(current.project_id)
  return get<Routine>('SELECT * FROM routines WHERE id=?', id)
}

export function deleteRoutine(id: number) {
  const current = get<Routine>('SELECT project_id FROM routines WHERE id=?', id)
  if (!current) return false
  run('DELETE FROM routines WHERE id=?', id)
  touch(current.project_id)
  return true
}
