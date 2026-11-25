// Spends a subscription quota with foresight. The CLIs report how full their windows are and when
// they reset (table quota). From that each provider gets a pace:
//   spend:  the window resets soon with plenty left. Big issues go first, the rest would expire.
//   normal: everything else.
// There is no saving: a provider runs at full speed until it reaches the owner's stop threshold.
// Whether an issue is big is guessed from what its earlier runs used, compared to the project.
import { getAccess } from './auth.ts'
import { all, get } from './db.ts'

export type Pace = 'spend' | 'normal'

const HOUR = 3_600_000
/** With more than this share left and the reset closer than SPEND_IF_RESET_WITHIN, the provider spends. */
const SPEND_ABOVE = 0.3
const SPEND_IF_RESET_WITHIN = HOUR

/** Without a reported reset, a reading cannot constrain routing indefinitely. */
const STALE_AFTER = 6 * HOUR
/**
 * Windows that do not stop every run. Extra usage on top of the plan, and the weekly limits of a
 * single model (Claude reports Fable apart from the normal weekly limit): a run that hits one of
 * those fails with a limit error, and recovery.ts rests the provider until it resets.
 */
const NOT_LIMITING = /overage|opus|sonnet|fable|haiku/i

const MODEL_FAMILY = /opus|sonnet|fable|haiku/i

/** Display and routing share the same interpretation of the provider's subscription windows. */
export function quotaWindows(provider: string, now = Date.now()) {
  return all<{ window: string; utilization: number; resets_at: number | null; updated_at: number }>(
    'SELECT window, utilization, resets_at, updated_at FROM quota WHERE provider=? ORDER BY window',
    provider,
  ).filter((row) => row.resets_at == null || row.resets_at > now)
    .map((row) => {
      const stale = now - row.updated_at >= STALE_AFTER
      const active = !stale || row.resets_at != null
      return { ...row, stale, active, limiting: active && !NOT_LIMITING.test(row.window) }
    })
}

/** True while the weekly limit of this model alone (e.g. Fable) is used up. */
export function modelLimitReached(provider: string, model: string, now = Date.now()) {
  const family = model.toLowerCase().match(MODEL_FAMILY)?.[0]
  if (!family || getAccess(provider).mode !== 'subscription') return false
  return quotaWindows(provider, now).some(
    (row) =>
      row.window.toLowerCase().includes(family) &&
      !/overage/i.test(row.window) && row.active && row.utilization >= 0.98,
  )
}

/** Known future resets keep their window in effect even if the last read is old. */
export function limitingWindows(provider: string, now = Date.now()) {
  return quotaWindows(provider, now).filter((row) => row.limiting)
}

export function paceOf(provider: string, now = Date.now()): { pace: Pace; left: number; resetsAt?: number } {
  // Like the availability in core.ts: the subscription windows say nothing about an API key.
  if (getAccess(provider).mode !== 'subscription') return { pace: 'normal', left: 1 }
  const rows = limitingWindows(provider, now)
  if (!rows.length) return { pace: 'normal', left: 1 }
  // The fullest window decides, as it is the one that will stop the runs first.
  const fullest = rows.reduce((a, b) => (b.utilization > a.utilization ? b : a))
  const left = Math.max(0, 1 - fullest.utilization)
  const resetsAt = fullest.resets_at ?? undefined
  const resetIn = resetsAt ? resetsAt - now : Infinity

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
