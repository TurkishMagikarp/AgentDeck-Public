// The cost cap per issue: an issue that has used more than the project allows for one issue is
// parked instead of eating the budget of everything else. Checked after every run and before
// every start, so an issue goes over its cap by at most one run. The owner can grant another
// round of the same size; then the issue goes on where it stopped.
import { get } from './db.ts'
import { currentLang, t } from './i18n.ts'

export type IssueCap = { usd: number; tokens: number }

/** What all runs of the issue used: dollars as the providers report them, and fresh tokens. */
export function spentOn(issueId: number) {
  const row = get(
    `SELECT COALESCE(SUM(cost_usd),0) AS usd, COALESCE(SUM(input_tokens - cached_tokens + output_tokens),0) AS tokens
     FROM runs WHERE issue_id=? AND status!='running'`,
    issueId,
  )!
  return { usd: row.usd as number, tokens: row.tokens as number }
}

/** The limit for this issue: the project's cap times the rounds the owner granted. 0 means no limit. */
export function capOf(cap: IssueCap, factor: number): IssueCap {
  return { usd: cap.usd * factor, tokens: cap.tokens * factor }
}

/** Why the issue is over its cap, or '' while it is within. */
export function overCap(projectCap: IssueCap, issue: { id: number; cap_factor: number }) {
  if (!projectCap.usd && !projectCap.tokens) return ''
  const limit = capOf(projectCap, Math.max(1, issue.cap_factor))
  const spent = spentOn(issue.id)
  if (limit.usd && spent.usd >= limit.usd)
    return t('${spent} von ${limit} verbraucht', { spent: spent.usd.toFixed(2), limit: limit.usd.toFixed(2) })
  if (limit.tokens && spent.tokens >= limit.tokens) {
    const locale = currentLang() === 'en' ? 'en-US' : 'de-DE'
    const k = (value: number) => `${Math.round(value / 1000).toLocaleString(locale)}k`
    return t('{spent} von {limit} Tokens verbraucht', { spent: k(spent.tokens), limit: k(limit.tokens) })
  }
  return ''
}
