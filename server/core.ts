import { getAccess } from './auth.ts'
import type { LandingSettings } from './landing.ts'
import { gzipSync } from 'node:zlib'
import { all, get, run } from './db.ts'

export const PROVIDERS: Record<
  string,
  {
    label: string
    cli: 'claude' | 'codex' | 'opencode' | 'api' | 'mock'
    defaultModel: string
    baseUrl?: string
  }
> = {
  anthropic: { label: 'Anthropic (Claude Code)', cli: 'claude', defaultModel: '' },
  openai: { label: 'OpenAI (Codex)', cli: 'codex', defaultModel: '' },
  opencode: { label: 'Opencode Go', cli: 'opencode', defaultModel: '' },
  deepseek: {
    label: 'Deepseek',
    cli: 'api',
    defaultModel: 'deepseek-chat',
    baseUrl: process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com',
  },
}
if (process.env.AGENTDECK_MOCK) PROVIDERS.mock = { label: 'Mock (Test)', cli: 'mock', defaultModel: '' }

export const STATUSES = ['backlog', 'todo', 'in_progress', 'review', 'blocked', 'done']
export const MODEL_RE = /^[\w./:#@-]{0,80}$/
export const EFFORTS = ['', 'low', 'medium', 'high', 'xhigh', 'max']

export type Budget = {
  limit: number
  unit: 'usd' | 'tokens' | 'runs'
  window: '5h' | 'day' | 'week' | 'month'
  stopAtPct: number
  scope: 'project' | 'global'
}
export type Rule = {
  type: 'stall' | 'runtime' | 'attempts'
  value: number
  action: 'comment' | 'stop' | 'block'
}
export type Settings = {
  maxConcurrent: number
  /** ADHD mode: agents answer with one result line plus at most three bullets. */
  adhd: boolean
  /** 'issue': a fresh worktree per issue. 'agent': each agent keeps one checkout and switches branches. */
  workspace: 'issue' | 'agent'
  /** After this many change requests between maker and reviewers a human has to decide. */
  maxReviewRounds: number
  landing: LandingSettings
  /** Mail the owner when an issue waits for a human. */
  notifyOwner: boolean
  /** Agent that gets a stuck issue first, before a human is asked. 0: nobody. */
  escalationAgentId: number
  /** When nothing is open any more, move the backlog of the next group (by name) to "todo". */
  openGroupsInOrder: boolean
  /** No issue ever waits for a human: the deputy agent decides, and what it cannot settle is parked. */
  autonomous: boolean
  budgets: Record<string, Budget>
  fallbackEnabled: boolean
  fallback: string[]
  fallbackModels: Record<string, string>
  watchdog: {
    enabled: boolean
    rules: Rule[]
    llm: { enabled: boolean; provider: string; prompt: string; onFail: 'todo' | 'blocked' }
  }
}

export function defaultSettings(): Settings {
  const budgets: Record<string, Budget> = {}
  for (const p of Object.keys(PROVIDERS))
    budgets[p] = {
      limit: 0,
      unit: p === 'anthropic' ? 'usd' : 'tokens',
      window: 'week',
      stopAtPct: 10,
      scope: 'global',
    }
  return {
    maxConcurrent: 3,
    adhd: false,
    workspace: 'issue',
    maxReviewRounds: 3,
    landing: { mode: 'off', baseBranch: '', push: false, protectedPaths: [] },
    notifyOwner: true,
    escalationAgentId: 0,
    openGroupsInOrder: false,
    autonomous: false,
    budgets,
    fallbackEnabled: true,
    fallback: Object.keys(PROVIDERS),
    fallbackModels: {},
    watchdog: {
      enabled: true,
      rules: [
        { type: 'stall', value: 10, action: 'stop' },
        { type: 'runtime', value: 60, action: 'stop' },
        { type: 'attempts', value: 3, action: 'block' },
      ],
      llm: {
        enabled: false,
        provider: 'anthropic',
        prompt:
          'Check that the task is fully done, that tests were run and that nothing outside the task was changed.',
        onFail: 'todo',
      },
    },
  }
}

export function mergeSettings(raw: any): Settings {
  const d = defaultSettings()
  const s = raw ?? {}
  const budgets = { ...d.budgets }
  for (const p of Object.keys(budgets)) budgets[p] = { ...budgets[p], ...(s.budgets?.[p] ?? {}) }
  const fallback = (Array.isArray(s.fallback) ? s.fallback : []).filter((p: string) => PROVIDERS[p])
  for (const p of d.fallback) if (!fallback.includes(p)) fallback.push(p)
  return {
    maxConcurrent: Math.max(1, Number(s.maxConcurrent ?? d.maxConcurrent) || 1),
    adhd: !!s.adhd,
    workspace: s.workspace === 'agent' ? 'agent' : 'issue',
    maxReviewRounds: Math.max(1, Number(s.maxReviewRounds ?? d.maxReviewRounds) || 3),
    landing: {
      mode: ['merge', 'pr'].includes(s.landing?.mode) ? s.landing.mode : 'off',
      baseBranch: String(s.landing?.baseBranch ?? '').slice(0, 120),
      push: !!s.landing?.push,
      protectedPaths: (Array.isArray(s.landing?.protectedPaths) ? s.landing.protectedPaths : [])
        .map((path: unknown) => String(path).trim())
        .filter(Boolean),
    },
    notifyOwner: s.notifyOwner ?? d.notifyOwner,
    escalationAgentId: Number(s.escalationAgentId) || 0,
    openGroupsInOrder: !!s.openGroupsInOrder,
    autonomous: !!s.autonomous,
    budgets,
    fallbackEnabled: s.fallbackEnabled ?? d.fallbackEnabled,
    fallback,
    fallbackModels: { ...(s.fallbackModels ?? {}) },
    watchdog: {
      enabled: s.watchdog?.enabled ?? d.watchdog.enabled,
      rules: Array.isArray(s.watchdog?.rules) ? s.watchdog.rules : d.watchdog.rules,
      llm: { ...d.watchdog.llm, ...(s.watchdog?.llm ?? {}) },
    },
  }
}

// ---------- row mappers ----------
export const mapProject = (r: any) =>
  r && { ...r, paused: !!r.paused, settings: mergeSettings(JSON.parse(r.settings || '{}')) }
export const mapAgent = (r: any) =>
  r && {
    ...r,
    enabled: !!r.enabled,
    skill_ids: JSON.parse(r.skill_ids || '[]') as number[],
    mcp_ids: JSON.parse(r.mcp_ids || '[]') as string[],
  }
export const mapIssue = (r: any) =>
  r && {
    ...r,
    blocked_by: JSON.parse(r.blocked_by || '[]') as number[],
    reviewers: JSON.parse(r.reviewers || '[]') as number[],
  }

const ISSUE_LIGHT =
  'id, project_id, number, title, status, priority, assignee_id, rank, blocked_by, reviewers, review_index, grp, landing, updated_at'

export const getProject = (id: number) => mapProject(get('SELECT * FROM projects WHERE id=?', id))
export const getAgent = (id: number) => mapAgent(get('SELECT * FROM agents WHERE id=?', id))
export const getIssue = (id: number) => mapIssue(get('SELECT * FROM issues WHERE id=?', id))
const lightIssue = (id: number) => mapIssue(get(`SELECT ${ISSUE_LIGHT} FROM issues WHERE id=?`, id))

// ---------- event bus (SSE) ----------
type Listener = (e: any) => void
const listeners = new Map<number, Set<Listener>>()
export function subscribe(pid: number, fn: Listener) {
  let s = listeners.get(pid)
  if (!s) listeners.set(pid, (s = new Set()))
  s.add(fn)
  return () => s!.delete(fn)
}
export function emit(pid: number, e: any) {
  const s = listeners.get(pid)
  if (s) for (const fn of s) fn(e)
}

// ---------- board cache: the serialized board lives in RAM, DB is only hit after a write ----------
// The board lives in RAM in serialized form: one JSON string per issue plus one for everything
// else. A changed issue costs one small stringify instead of re-reading thousands of rows.
type CachedBoard = {
  issues: Map<number, string>
  head: string | null
  body: { json: string; gzip: Buffer } | null
}
const boards = new Map<number, CachedBoard>()
export const activity = new Map<number, { issueId: number; text: string; at: number }>() // runId -> live line

/** Project, agents, skills or runs changed. */
export function invalidate(pid: number) {
  const cached = boards.get(pid)
  if (!cached) return
  cached.head = null
  cached.body = null
}

function rememberIssue(issue: { id: number; project_id: number }) {
  const cached = boards.get(issue.project_id)
  if (!cached) return
  cached.issues.set(issue.id, JSON.stringify(issue))
  cached.body = null
}

export function forgetIssue(pid: number, issueId: number) {
  const cached = boards.get(pid)
  if (!cached) return
  cached.issues.delete(issueId)
  cached.body = null
}

/** Drops cached boards, e.g. after a rolled-back transaction left them ahead of the database. */
export function forgetBoards(pid?: number) {
  if (pid === undefined) boards.clear()
  else boards.delete(pid)
}
export function touch(pid: number) {
  invalidate(pid)
  emit(pid, { t: 'reload' })
}
export function board(pid: number) {
  let cached = boards.get(pid)
  if (cached?.body) return cached.body

  const project = getProject(pid)
  if (!project) return null

  if (!cached) {
    const rows = all(`SELECT ${ISSUE_LIGHT} FROM issues WHERE project_id=?`, pid).map(mapIssue)
    cached = {
      issues: new Map(rows.map((issue) => [issue.id, JSON.stringify(issue)])),
      head: null,
      body: null,
    }
    boards.set(pid, cached)
  }

  cached.head ??= JSON.stringify({
    project,
    agents: all('SELECT * FROM agents WHERE project_id=? ORDER BY id', pid).map(mapAgent),
    skills: all('SELECT * FROM skills WHERE project_id=? ORDER BY name', pid),
    runs: all(
      "SELECT id, issue_id, agent_id, agent_name, provider, model, started_at FROM runs WHERE project_id=? AND status='running'",
      pid,
    ),
  })

  // Splice the issue strings into the head object: {"project":…,"runs":[…],"issues":[…]}
  const json = `${cached.head.slice(0, -1)},"issues":[${[...cached.issues.values()].join(',')}]}`
  // Level 1 is several times faster than the default and still shrinks the board to about a tenth.
  cached.body = { json, gzip: gzipSync(json, { level: 1 }) }
  return cached.body
}

// ---------- shared mutations ----------
const ISSUE_FIELDS = [
  'title',
  'description',
  'status',
  'priority',
  'assignee_id',
  'rank',
  'blocked_by',
  'handoff',
  'reviewers',
  'review_index',
  'review_rounds',
  'maker_id',
  'grp',
  'model',
  'landing',
  'escalated',
  'pr_number',
]
const JSON_ISSUE_FIELDS = ['blocked_by', 'reviewers']
export function patchIssue(id: number, patch: Record<string, any>) {
  const sets: string[] = []
  const vals: any[] = []
  for (const k of ISSUE_FIELDS) {
    if (!(k in patch)) continue
    sets.push(`${k}=?`)
    vals.push(JSON_ISSUE_FIELDS.includes(k) ? JSON.stringify(patch[k] ?? []) : patch[k])
  }
  if (!sets.length) return getIssue(id)
  const now = Date.now()
  // The first time an issue is done counts; reopening it clears the date.
  if (patch.status === 'done') sets.push(`done_at=COALESCE(done_at, ${now})`)
  else if ('status' in patch) sets.push('done_at=NULL')
  run(`UPDATE issues SET ${sets.join(', ')}, updated_at=? WHERE id=?`, ...vals, now, id)
  const issue = lightIssue(id)
  if (issue) {
    rememberIssue(issue)
    emit(issue.project_id, { t: 'issue', issue })
  }
  return issue
}

export function addComment(issueId: number, author: string, kind: string, body: string) {
  const issue = get('SELECT project_id FROM issues WHERE id=?', issueId)
  if (!issue) return
  const created_at = Date.now()
  const r = run(
    'INSERT INTO comments (issue_id, author, kind, body, created_at) VALUES (?,?,?,?,?)',
    issueId,
    author,
    kind,
    body,
    created_at,
  )
  const comment = { id: r.lastInsertRowid, issue_id: issueId, author, kind, body, created_at }
  emit(issue.project_id, { t: 'comment', comment })
  return comment
}

export function createIssue(
  pid: number,
  f: {
    title: string
    description?: string
    status?: string
    priority?: number
    assignee_id?: number | null
    blocked_by?: number[]
    reviewers?: number[]
    grp?: string
    model?: string
    routine_id?: number
  },
) {
  const p = get('SELECT next_number FROM projects WHERE id=?', pid)
  if (!p) throw new Error('Project not found')
  const now = Date.now()
  run('UPDATE projects SET next_number=next_number+1 WHERE id=?', pid)
  const r = run(
    `INSERT INTO issues (project_id, number, title, description, status, priority, assignee_id, rank,
       blocked_by, reviewers, grp, model, routine_id, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    pid,
    p.next_number,
    f.title,
    f.description ?? '',
    STATUSES.includes(f.status ?? '') ? f.status : 'backlog',
    f.priority ?? 1,
    f.assignee_id ?? null,
    now,
    JSON.stringify(f.blocked_by ?? []),
    JSON.stringify(f.reviewers ?? []),
    f.grp ?? '',
    f.model ?? '',
    f.routine_id ?? null,
    now,
    now,
  )
  const issue = lightIssue(Number(r.lastInsertRowid))
  rememberIssue(issue)
  emit(pid, { t: 'issue', issue })
  return issue
}

// ---------- usage / quota ----------
export function windowStart(w: Budget['window'], now = Date.now()): number {
  if (w === '5h') return now - 5 * 3600_000
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  if (w === 'week') d.setDate(d.getDate() - ((d.getDay() + 6) % 7))
  if (w === 'month') d.setDate(1)
  return d.getTime()
}

/** Remaining percentage for a provider: the minimum of the configured budget and the CLI-reported subscription quota. */
export function providerLeft(project: { id: number; settings: Settings }, provider: string) {
  const b = project.settings.budgets[provider]
  const since = windowStart(b.window)
  const row = get(
    `SELECT COALESCE(SUM(cost_usd),0) AS cost, COALESCE(SUM(input_tokens+output_tokens),0) AS tokens,
       COUNT(*) AS runs FROM runs
     WHERE provider=? AND started_at>=? AND (?=0 OR project_id=?)`,
    provider,
    since,
    b.scope === 'project' ? 1 : 0,
    project.id,
  )!
  const used = b.unit === 'usd' ? row.cost : b.unit === 'runs' ? row.runs : row.tokens
  const budgetLeft = b.limit > 0 ? Math.max(0, 100 * (1 - used / b.limit)) : null
  const now = Date.now()
  const access = getAccess(provider)
  // The subscription quota says nothing about an API key, so it only counts in subscription mode.
  const quotas =
    access.mode === 'subscription'
      ? all('SELECT window, utilization, resets_at, updated_at FROM quota WHERE provider=?', provider).filter(
          (q) => !q.resets_at || q.resets_at > now,
        )
      : []
  const quotaLeft = quotas.length
    ? Math.max(0, 100 * (1 - Math.max(...quotas.map((q) => q.utilization))))
    : null
  const left = Math.min(budgetLeft ?? 100, quotaLeft ?? 100)
  return {
    provider,
    used,
    cost: row.cost,
    tokens: row.tokens,
    budget: b,
    budgetLeft,
    quotaLeft,
    quotas,
    left,
    mode: access.mode,
    ready: access.ready,
    available: access.ready && left > b.stopAtPct,
  }
}

/** Preferred provider first, then the project's fallback chain. Returns null when everything is below its threshold. */
export function pickProvider(
  project: { id: number; settings: Settings },
  agent: { provider: string; model: string },
) {
  const s = project.settings
  const order = [agent.provider, ...(s.fallbackEnabled ? s.fallback.filter((p) => p !== agent.provider) : [])]
  for (const p of order) {
    if (!PROVIDERS[p]) continue
    if (providerLeft(project, p).available)
      return {
        provider: p,
        model: p === agent.provider ? agent.model : s.fallbackModels[p] || PROVIDERS[p].defaultModel,
        fallback: p !== agent.provider,
      }
  }
  return null
}
