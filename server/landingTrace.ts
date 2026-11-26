// The trace of a landing: every step the server takes between "the issue is done" and "it is in the
// base branch", written down as it happens. Landing is the one place where the server, not an
// agent, changes the repository, so it must not be a black box: what was looked at, which gate
// held it, what was merged where, what the check printed, whether the push worked.
// Text is redacted and short; the check's full output stays in the issue comment on failure.
import { all, run } from './db.ts'
import { redact } from './runEvents.ts'

export type TraceLevel = 'info' | 'ok' | 'warn' | 'bad'
export type TraceLine = { id: number; at: number; step: string; level: TraceLevel; text: string }

const CAP = 600

/** Never throws: a trace problem must not stop a landing. */
export function trace(issueId: number, step: string, text: string, level: TraceLevel = 'info') {
  try {
    run(
      'INSERT INTO landing_trace (issue_id, at, step, level, text) VALUES (?,?,?,?,?)',
      issueId,
      Date.now(),
      step,
      level,
      redact(text.length > CAP ? `${text.slice(0, CAP - 1)}…` : text),
    )
  } catch (error) {
    console.error('landing trace:', (error as Error).message)
  }
}

export const traceOf = (issueId: number): TraceLine[] =>
  all('SELECT id, at, step, level, text FROM landing_trace WHERE issue_id=? ORDER BY id', issueId)

export const pruneTrace = (cutoff: number) => Number(run('DELETE FROM landing_trace WHERE at < ?', cutoff).changes)
