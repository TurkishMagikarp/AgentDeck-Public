// Spends a subscription quota with foresight. The CLIs report how full their windows are and when
// they reset (table quota). From that each provider gets a pace:
//   save:   little left and the reset is far away. Big issues wait, one run at a time.
//   spend:  the window resets soon with plenty left. Big issues go first, the rest would expire.
//   normal: everything else.
// Whether an issue is big is guessed from what its earlier runs used, compared to the project.
import { getAccess } from './auth.ts'
import { all, get } from './db.ts'

export type Pace = 'save' | 'spend' | 'normal'

const HOUR = 3_600_000
/** Below this share left, and with the reset further away than SAVE_IF_RESET_AFTER, the provider saves. */
const SAVE_BELOW = 0.3
const SAVE_IF_RESET_AFTER = 3 * HOUR
/** With more than this share left and the reset closer than SPEND_IF_RESET_WITHIN, the provider spends. */
const SPEND_ABOVE = 0.3
const SPEND_IF_RESET_WITHIN = HOUR

/** Rows of the provider's windows that have not reset yet. */
function windows(provider: string, now: number) {
  return all('SELECT utilization, resets_at FROM quota WHERE provider=?', provider).filter(
    (row) => !row.resets_at || row.resets_at > now,
  )
}

export function paceOf(provider: string, now = Date.now()): { pace: Pace; left: number; resetsAt?: number } {
  // Like the availability in core.ts: the subscription windows say nothing about an API key.
  if (getAccess(provider).mode !== 'subscription') return { pace: 'normal', left: 1 }
  const rows = windows(provider, now)
  if (!rows.length) return { pace: 'normal', left: 1 }
  // The fullest window decides, as it is the one that will stop the runs first.
  const fullest = rows.reduce((a, b) => (b.utilization > a.utilization ? b : a))
  const left = Math.max(0, 1 - fullest.utilization)
  const resetsAt = fullest.resets_at ?? undefined
  const resetIn = resetsAt ? resetsAt - now : Infinity

  if (left < SAVE_BELOW && resetIn > SAVE_IF_RESET_AFTER) return { pace: 'save', left, resetsAt }
  if (left > SPEND_ABOVE && resetIn < SPEND_IF_RESET_WITHIN) return { pace: 'spend', left, resetsAt }
  return { pace: 'normal', left, resetsAt }
}

const FRESH = 'input_tokens - cached_tokens + output_tokens'

/** Twice what a typical work run of the project used in the last two weeks. Below that an issue is small. */
function bigThreshold(projectId: number) {
  const since = Date.now() - 14 * 24 * HOUR
  const row = get(
    `SELECT AVG(${FRESH}) AS typical FROM runs
     WHERE project_id=? AND kind='work' AND status='done' AND started_at>=?`,
    projectId,
    since,
  )
  return row?.typical ? row.typical * 2 : Infinity
}

/**
 * The issues of the queue that are likely big: their earlier runs used more than twice the
 * project's typical run. An issue that never ran counts as small, there is nothing to go by.
 */
export function bigIssues(projectId: number, issueIds: number[]): Set<number> {
  if (!issueIds.length) return new Set()
  const threshold = bigThreshold(projectId)
  if (threshold === Infinity) return new Set()
  const rows = all(
    `SELECT issue_id, AVG(${FRESH}) AS used FROM runs
     WHERE issue_id IN (${issueIds.map(() => '?').join(',')}) AND status!='running'
     GROUP BY issue_id`,
    ...issueIds,
  )
  return new Set(rows.filter((row) => row.used > threshold).map((row) => row.issue_id as number))
}
