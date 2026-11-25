// Cost forecast for an open issue, read from what similar finished issues of the same project
// used. Complements issueCap.ts: the cap says what an issue may use, the forecast what it likely
// will. Everything runs on an in-memory index per project, so a request never scans the runs table.
import { getAgent, getIssue, getProject, subscribe, tierOf, type ModelTiers, type Tier } from './core.ts'
import { all } from './db.ts'
import { capOf, type IssueCap } from './issueCap.ts'

/** Below this many similar issues a median says more about luck than about the issue. */
export const MIN_SAMPLE = 3
/** The most similar ones only: past that, weaker matches would just dilute the estimate. */
const MAX_SAMPLE = 25
/** Done issues kept per project. Old ones say little about today's prompts and models. */
const INDEX_LIMIT = 500
/** Weight halves every 60 days: recent issues reflect the current agents and prices. */
const HALF_LIFE_MS = 60 * 86_400_000
/** Words of a description beyond this add CPU, hardly any signal. */
const TEXT_LIMIT = 4000
/** Minimum score to count as similar, see similarity(). */
const MIN_SCORE = 0.35

export type Done = {
  id: number
  grp: string
  agentId: number | null
  tier: Tier
  words: Set<string>
  doneAt: number
  usd: number
  tokens: number
  runs: number
}
export type Target = { grp: string; agentId: number | null; tier: Tier; words: Set<string> }
export type Range = { median: number; low: number; high: number }
export type Forecast = { sample: number; usd: Range; tokens: Range; runs: Range }

// Words that are in every issue and would make everything look alike.
const STOPWORDS = new Set(
  (
    'the and for with from that this into when then than not are was were has have but all any can should ' +
    'will would also only use add make issue der die das und mit von für fuer auf aus bei ein eine einen ' +
    'einem einer dem den des ist sind wird werden nicht auch nur noch wie wenn dann als oder dass soll ' +
    'sollen muss kann alle bitte über ueber nach vor zum zur'
  ).split(' '),
)

/** Normalized words of a text: lower case, letters and digits, at least three characters. */
export function wordsOf(text: string): Set<string> {
  const words = new Set<string>()
  for (const word of text
    .slice(0, TEXT_LIMIT)
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)) {
    if (word.length >= 3 && !STOPWORDS.has(word)) words.add(word)
  }
  return words
}

/** Shared words over all words, 0 for two empty sets. */
export function jaccard(a: Set<string>, b: Set<string>) {
  if (!a.size || !b.size) return 0
  const [small, large] = a.size <= b.size ? [a, b] : [b, a]
  let shared = 0
  for (const word of small) if (large.has(word)) shared++
  return shared / (a.size + b.size - shared)
}

/**
 * How alike a finished issue is, 0 when it is not comparable. The model tier must match: a strong
 * model costs many times a light one, so their totals do not mix. Group and agent each add a
 * quarter, so the same agent working on the same milestone counts as similar even with other words.
 */
export function similarity(target: Target, done: Done) {
  if (target.tier !== done.tier) return 0
  let score = jaccard(target.words, done.words)
  if (target.grp && target.grp === done.grp) score += 0.25
  if (target.agentId !== null && target.agentId === done.agentId) score += 0.25
  return score
}

/** Weighted quantile: the value where the cumulated weight reaches q of the total. */
export function weightedQuantile(points: { value: number; weight: number }[], q: number) {
  const sorted = [...points].sort((a, b) => a.value - b.value)
  const total = sorted.reduce((sum, point) => sum + point.weight, 0)
  if (!sorted.length || total <= 0) return 0
  let cumulated = 0
  for (const point of sorted) {
    cumulated += point.weight
    if (cumulated >= q * total - 1e-9) return point.value
  }
  return sorted[sorted.length - 1].value
}

/** The forecast from an index, null with fewer than MIN_SAMPLE similar issues. Pure, for tests. */
export function forecastFrom(target: Target, index: Done[], now = Date.now()): Forecast | null {
  const similar = index
    .map((done) => ({ done, score: similarity(target, done) }))
    .filter((match) => match.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_SAMPLE)
  if (similar.length < MIN_SAMPLE) return null
  const weighted = similar.map(({ done, score }) => ({
    done,
    weight: score * 0.5 ** (Math.max(0, now - done.doneAt) / HALF_LIFE_MS),
  }))
  const range = (pick: (done: Done) => number): Range => {
    const points = weighted.map(({ done, weight }) => ({ value: pick(done), weight }))
    return {
      median: weightedQuantile(points, 0.5),
      low: weightedQuantile(points, 0.25),
      high: weightedQuantile(points, 0.75),
    }
  }
  return {
    sample: similar.length,
    usd: range((done) => done.usd),
    tokens: range((done) => done.tokens),
    runs: range((done) => done.runs),
  }
}

// ---------- the index per project ----------
type ProjectIndex = {
  done: Done[]
  doneIds: Set<number>
  /** Forecasts by issue id, valid while the issue's updated_at is the same. */
  results: Map<number, { updatedAt: number; forecast: Forecast | null }>
}
const indexes = new Map<number, ProjectIndex>()
const watched = new Set<number>()

/**
 * Drops the index when something it depends on changes: an issue gets done or reopened, a run of
 * a done issue ends late, or the project, its agents or tiers change (those send 'reload').
 */
function watch(pid: number) {
  if (watched.has(pid)) return
  watched.add(pid)
  subscribe(pid, (event) => {
    const index = indexes.get(pid)
    if (!index) return
    if (event.t === 'reload') indexes.delete(pid)
    else if (event.t === 'issue' && event.issue?.id !== undefined) {
      if ((event.issue.status === 'done') !== index.doneIds.has(event.issue.id)) indexes.delete(pid)
    } else if (event.t === 'run.end' && index.doneIds.has(event.issueId)) indexes.delete(pid)
  })
}

function buildIndex(pid: number, tiers: ModelTiers): ProjectIndex {
  const agents = new Map(
    all('SELECT id, provider, model FROM agents WHERE project_id=?', pid).map((agent) => [agent.id, agent]),
  )
  // One grouped query per invalidation. Totals are counted the way issueCap.ts counts them.
  // Issues closed without any run (by hand) say nothing about cost and stay out. The tier comes
  // from the model of the last work run; '' there means the agent's default model.
  const rows = all(
    `SELECT i.id, i.grp, COALESCE(i.maker_id, i.assignee_id) AS agent_id, i.title,
       substr(i.description, 1, ${TEXT_LIMIT}) AS description, i.done_at,
       COALESCE(SUM(r.cost_usd), 0) AS usd,
       COALESCE(SUM(r.input_tokens - r.cached_tokens + r.output_tokens), 0) AS tokens,
       COUNT(r.id) AS runs,
       (SELECT w.provider || char(9) || w.model FROM runs w
          WHERE w.issue_id = i.id AND w.kind = 'work' ORDER BY w.id DESC LIMIT 1) AS last_model
     FROM issues i LEFT JOIN runs r ON r.issue_id = i.id AND r.status != 'running'
     WHERE i.project_id = ? AND i.status = 'done' AND i.done_at IS NOT NULL
     GROUP BY i.id HAVING COUNT(r.id) > 0 ORDER BY i.done_at DESC LIMIT ${INDEX_LIMIT}`,
    pid,
  )
  const done = rows.map((row): Done => {
    const agent = agents.get(row.agent_id)
    const [provider, model] = String(row.last_model ?? '').split('\t')
    return {
      id: row.id,
      grp: row.grp,
      agentId: row.agent_id ?? null,
      tier: tierOf(tiers, provider || agent?.provider || '', model || agent?.model || ''),
      words: wordsOf(`${row.title} ${row.description}`),
      doneAt: row.done_at,
      usd: row.usd,
      tokens: row.tokens,
      runs: row.runs,
    }
  })
  return { done, doneIds: new Set(done.map((entry) => entry.id)), results: new Map() }
}

/** Forgets every index. For tests and for writes that bypass the event bus. */
export function forgetForecasts(pid?: number) {
  if (pid === undefined) indexes.clear()
  else indexes.delete(pid)
}

/**
 * The forecast for an issue, null when it is done, unknown or has too few similar issues. The
 * result is cached until the issue changes or the index is dropped.
 */
export function forecastFor(issueId: number): Forecast | null {
  const issue = getIssue(issueId)
  if (!issue || issue.status === 'done') return null
  const pid = issue.project_id
  const tiers = getProject(pid).settings.modelTiers
  watch(pid)
  let index = indexes.get(pid)
  if (!index) indexes.set(pid, (index = buildIndex(pid, tiers)))
  const cached = index.results.get(issue.id)
  if (cached && cached.updatedAt === issue.updated_at) return cached.forecast

  const agentId = issue.maker_id ?? issue.assignee_id ?? null
  const agent = agentId ? getAgent(agentId) : null
  const target: Target = {
    grp: issue.grp,
    agentId,
    tier: tierOf(tiers, agent?.provider ?? '', issue.model || agent?.model || ''),
    words: wordsOf(`${issue.title} ${issue.description}`),
  }
  const forecast = forecastFrom(target, index.done)
  index.results.set(issue.id, { updatedAt: issue.updated_at, forecast })
  return forecast
}

/** Whether the expected (median) total goes past the issue's cap, in either unit. */
export function exceedsCap(forecast: Forecast | null, cap: IssueCap) {
  if (!forecast) return false
  return (!!cap.usd && forecast.usd.median > cap.usd) || (!!cap.tokens && forecast.tokens.median > cap.tokens)
}

/** What the issue page shows: the forecast, the issue's cap and whether the forecast exceeds it. */
export function forecastView(issueId: number) {
  const issue = getIssue(issueId)
  if (!issue) return null
  const forecast = forecastFor(issue.id)
  const cap = capOf(getProject(issue.project_id).settings.issueCap, Math.max(1, issue.cap_factor))
  return { forecast, cap, overCap: exceedsCap(forecast, cap) }
}
