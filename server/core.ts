import { getAccess } from './auth.ts'
import type { LandingSettings } from './landing.ts'
import { DEFAULT_INFRA_GLOBS } from './gates.ts'
import { gzipSync } from 'node:zlib'
import { DEFAULT_ALLOW, normalizeEgress, type EgressSettings } from './egress.ts'
import { all, get, run } from './db.ts'
import { restOf } from './recovery.ts'
import { resetsOf } from './resets.ts'
import { modelLimitReached, quotaWindows } from './pacing.ts'
import { SANDBOX } from './sandbox.ts'

export const PROVIDERS: Record<
  string,
  {
    label: string
    cli: 'claude' | 'codex' | 'opencode' | 'api' | 'managed' | 'mock'
    defaultModel: string
    baseUrl?: string
  }
> = {
  anthropic: { label: 'Anthropic (Claude Code)', cli: 'claude', defaultModel: '' },
  'claude-managed': { label: 'Claude Managed Agents (API)', cli: 'managed', defaultModel: 'claude-opus-5-5' },
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
/** A GitHub repository as "owner/name". */
export const GITHUB_REPO_RE = /^[\w.-]{1,39}\/[\w.-]{1,100}$/
export const MODEL_RE = /^[\w./:#@-]{0,80}$/
export const EFFORTS = ['', 'low', 'medium', 'high', 'xhigh', 'max']
/** What a webhook can be told about, see webhooks.ts. Here so the settings can check against it. */
export const WEBHOOK_EVENTS = ['review', 'blocked', 'done', 'failed', 'owner'] as const
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number]

/**
 * Model tiers make agents portable: an agent on the strong Claude model moves to the strong model
 * of whichever provider takes over, whether by fallback or by switching the whole project.
 */
export const TIERS = ['strong', 'medium', 'light'] as const
export type Tier = (typeof TIERS)[number]
export type ModelTiers = Record<Tier, Record<string, string>>

const CLAUDE_TIERS = { strong: 'claude-opus-5-5', medium: 'claude-sonnet-5-5', light: 'claude-haiku-5-5' }

function defaultTiers(): ModelTiers {
  const tiers: ModelTiers = { strong: {}, medium: {}, light: {} }
  for (const tier of TIERS) {
    tiers[tier].anthropic = CLAUDE_TIERS[tier]
    tiers[tier]['claude-managed'] = CLAUDE_TIERS[tier]
  }
  return tiers
}

/** The tier an agent's model belongs to: from the project's table first, then from its name. */
export function tierOf(tiers: ModelTiers, provider: string, model: string): Tier {
  for (const tier of TIERS) if (model && tiers[tier][provider] === model) return tier
  if (/fable|opus|\bpro\b|-pro|sol\b|max/i.test(model)) return 'strong'
  if (/haiku|flash|mini|nano|lite|luna|small/i.test(model)) return 'light'
  return 'medium'
}

export const modelFor = (tiers: ModelTiers, tier: Tier, provider: string) => tiers[tier][provider] ?? ''

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
  /** Caveman mode: agents write all prose terse to save output tokens; code and blocks stay exact. */
  caveman: boolean
  /** Record each run's steps for its replay timeline (runEvents.ts). */
  replay: boolean
  /** 'issue': a fresh worktree per issue. 'agent': each agent keeps one checkout and switches branches. */
  workspace: 'issue' | 'agent'
  /** After this many change requests between maker and reviewers a human has to decide. */
  maxReviewRounds: number
  /** Acceptance checklist on every issue, see checklist.ts. `templates` uses the format described there. */
  checklists: { enabled: boolean; templates: string }
  /**
   * Server check of finished work before any reviewer sees it, see precheck.ts. `commandAt`
   * "landing" runs the check command only after the last approval, right before the merge.
   * `quickCommand` then runs before the review instead: a fast part of the check, so that a
   * broken test shows up before a reviewer spends a round, not only at the landing.
   */
  precheck: {
    enabled: boolean
    command: string
    quickCommand: string
    timeoutMin: number
    commandAt: 'review' | 'landing'
  }
  /** After a change request the next review starts at the reviewer who asked for it, not at the first one. */
  resumeReview: boolean
  landing: LandingSettings
  /** Mail the owner when an issue waits for a human. */
  notifyOwner: boolean
  /**
   * Slack or generic webhooks for status changes, see webhooks.ts. Only the host is kept here:
   * the full URL and signing secret are encrypted in the secrets table, out of the UI's reach.
   */
  webhooks: { id: string; kind: 'slack' | 'generic'; host: string; events: WebhookEvent[] }[]
  /** Agent that gets a stuck issue first, before a human is asked. 0: nobody. */
  escalationAgentId: number
  /** When nothing is open any more, move the backlog of the next group (by name) to "todo". */
  openGroupsInOrder: boolean
  /** No issue ever waits for a human: the deputy agent decides, and what it cannot settle is parked. */
  autonomous: boolean
  /** Plan runs around the subscription windows: save when little is left, spend before a reset. */
  quotaPacing: boolean
  /** Issues that hold up others start first, by how many they hold up. See blockers.ts. */
  blockerBoost: boolean
  /** What one issue may use before it is parked. 0: no limit in that unit. */
  issueCap: { usd: number; tokens: number }
  /** Read-only public page at /show/<slug>. Issue titles only with `titles`. */
  showcase: { enabled: boolean; slug: string; titles: boolean }
  /**
   * GitHub issues become issues here once they get the label, see intake.ts. `repo` is
   * "owner/name"; `status` is where they land: the backlog for a look first, or straight to work.
   */
  intake: { enabled: boolean; repo: string; label: string; status: 'backlog' | 'todo' }
  /** Starts the app of a branch for screenshots when work goes to review. Empty command: off. */
  preview: { command: string; path: string }
  budgets: Record<string, Budget>
  fallbackEnabled: boolean
  fallback: string[]
  /** The model an agent gets on another provider: the one of its tier. */
  modelTiers: ModelTiers
  /** Reviews may move to another provider too. Off: a review waits for its reviewer's provider. */
  fallbackReviews: boolean
  /** A provider takes other agents' runs only while it has more than this percentage left. */
  fallbackReservePct: number
  watchdog: {
    enabled: boolean
    rules: Rule[]
    llm: { enabled: boolean; provider: string; prompt: string; onFail: 'todo' | 'blocked' }
  }
  /** Outbound network of the agents in the sandbox: open, or only the hosts on the list (egress.ts). */
  egress: EgressSettings
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
  // Managed Agents spend prepaid API credits, so they get a cap from the start.
  budgets['claude-managed'] = { limit: 200, unit: 'usd', window: 'month', stopAtPct: 5, scope: 'global' }
  return {
    maxConcurrent: 3,
    adhd: false,
    caveman: false,
    replay: true,
    workspace: 'issue',
    maxReviewRounds: 3,
    checklists: { enabled: false, templates: '' },
    precheck: { enabled: false, command: '', quickCommand: '', timeoutMin: 20, commandAt: 'review' },
    resumeReview: true,
    landing: {
      mode: 'off',
      baseBranch: '',
      push: false,
      protectedPaths: [],
      githubTokenFile: '',
      mergeMethod: 'merge',
      evidence: { paths: [], markers: [] },
      approval: { merge: false, dependencies: false, infra: false, infraGlobs: [...DEFAULT_INFRA_GLOBS] },
    },
    notifyOwner: true,
    webhooks: [],
    escalationAgentId: 0,
    openGroupsInOrder: false,
    autonomous: false,
    quotaPacing: true,
    blockerBoost: true,
    issueCap: { usd: 0, tokens: 0 },
    showcase: { enabled: false, slug: '', titles: false },
    intake: { enabled: false, repo: '', label: 'agentdeck', status: 'backlog' },
    preview: { command: '', path: '/' },
    budgets,
    fallbackEnabled: true,
    fallback: Object.keys(PROVIDERS),
    modelTiers: defaultTiers(),
    fallbackReviews: false,
    fallbackReservePct: 50,
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
    egress: { mode: 'open', allow: [...DEFAULT_ALLOW] },
  }
}

const lines = (value: unknown) =>
  (Array.isArray(value) ? value : []).map((line) => String(line).trim()).filter(Boolean)

function mergeWebhooks(raw: unknown): Settings['webhooks'] {
  const seen = new Set<string>()
  const hooks: Settings['webhooks'] = []
  for (const hook of Array.isArray(raw) ? raw : []) {
    if (!/^[0-9a-f]{16}$/.test(hook?.id) || seen.has(hook.id) || hooks.length >= 10) continue
    seen.add(hook.id)
    hooks.push({
      id: hook.id,
      kind: hook.kind === 'slack' ? 'slack' : 'generic',
      host: String(hook.host ?? '').slice(0, 260),
      events: WEBHOOK_EVENTS.filter((event) => Array.isArray(hook.events) && hook.events.includes(event)),
    })
  }
  return hooks
}

function mergeTiers(defaults: ModelTiers, raw: any): ModelTiers {
  const tiers = structuredClone(defaults)
  for (const tier of TIERS)
    for (const [provider, model] of Object.entries(raw?.[tier] ?? {}))
      if (PROVIDERS[provider] && typeof model === 'string' && MODEL_RE.test(model))
        tiers[tier][provider] = model
  return tiers
}

/**
 * Older settings had one model per provider for every fallback ("fallbackModels"), which beat
 * the tiers. It now fills the tiers the project never set for that provider, so a fallback
 * keeps the model it got before.
 */
function withOldFallbackModels(tiers: ModelTiers, raw: any): ModelTiers {
  for (const [provider, model] of Object.entries(raw?.fallbackModels ?? {}))
    if (PROVIDERS[provider] && typeof model === 'string' && model && MODEL_RE.test(model))
      for (const tier of TIERS) if (!raw?.modelTiers?.[tier]?.[provider]) tiers[tier][provider] = model
  return tiers
}

export function mergeSettings(raw: any): Settings {
  const d = defaultSettings()
  const s = raw ?? {}
  const budgets = { ...d.budgets }
  for (const p of Object.keys(budgets)) budgets[p] = { ...budgets[p], ...(s.budgets?.[p] ?? {}) }
  const fallback = [...new Set<string>((Array.isArray(s.fallback) ? s.fallback : []).filter(
    (p: unknown) => typeof p === 'string' && Object.hasOwn(PROVIDERS, p),
  ))]
  for (const p of d.fallback) if (!fallback.includes(p)) fallback.push(p)
  return {
    maxConcurrent: Math.max(1, Number(s.maxConcurrent ?? d.maxConcurrent) || 1),
    adhd: !!s.adhd,
    caveman: !!s.caveman,
    replay: s.replay !== false,
    workspace: s.workspace === 'agent' ? 'agent' : 'issue',
    maxReviewRounds: Math.max(1, Number(s.maxReviewRounds ?? d.maxReviewRounds) || 3),
    checklists: {
      enabled: !!s.checklists?.enabled,
      templates: String(s.checklists?.templates ?? '').slice(0, 20_000),
    },
    precheck: {
      enabled: !!s.precheck?.enabled,
      command: String(s.precheck?.command ?? '').slice(0, 500),
      quickCommand: String(s.precheck?.quickCommand ?? '').slice(0, 500),
      timeoutMin: Math.max(1, Math.min(60, Number(s.precheck?.timeoutMin) || d.precheck.timeoutMin)),
      commandAt: s.precheck?.commandAt === 'landing' ? 'landing' : 'review',
    },
    resumeReview: s.resumeReview ?? d.resumeReview,
    landing: {
      mode: ['merge', 'pr'].includes(s.landing?.mode) ? s.landing.mode : 'off',
      baseBranch: String(s.landing?.baseBranch ?? '').slice(0, 120),
      push: !!s.landing?.push,
      protectedPaths: (Array.isArray(s.landing?.protectedPaths) ? s.landing.protectedPaths : [])
        .map((path: unknown) => String(path).trim())
        .filter(Boolean),
      mergeMethod: ['squash', 'rebase'].includes(s.landing?.mergeMethod) ? s.landing.mergeMethod : 'merge',
      evidence: {
        paths: lines(s.landing?.evidence?.paths),
        markers: lines(s.landing?.evidence?.markers),
      },
      githubTokenFile: String(s.landing?.githubTokenFile ?? '')
        .trim()
        .slice(0, 300),
      approval: {
        merge: !!s.landing?.approval?.merge,
        dependencies: !!s.landing?.approval?.dependencies,
        infra: !!s.landing?.approval?.infra,
        // Missing means the defaults; an emptied list stays empty.
        infraGlobs: Array.isArray(s.landing?.approval?.infraGlobs)
          ? lines(s.landing.approval.infraGlobs)
              .map((glob) => glob.slice(0, 200))
              .slice(0, 100)
          : [...DEFAULT_INFRA_GLOBS],
      },
    },
    notifyOwner: s.notifyOwner ?? d.notifyOwner,
    webhooks: mergeWebhooks(s.webhooks),
    escalationAgentId: Number(s.escalationAgentId) || 0,
    openGroupsInOrder: !!s.openGroupsInOrder,
    autonomous: !!s.autonomous,
    quotaPacing: s.quotaPacing ?? d.quotaPacing,
    blockerBoost: s.blockerBoost ?? d.blockerBoost,
    issueCap: {
      usd: Math.max(0, Number(s.issueCap?.usd) || 0),
      tokens: Math.max(0, Math.round(Number(s.issueCap?.tokens) || 0)),
    },
    showcase: {
      enabled: !!s.showcase?.enabled && /^[\w-]{8,40}$/.test(s.showcase?.slug ?? ''),
      slug: /^[\w-]{8,40}$/.test(s.showcase?.slug ?? '') ? s.showcase.slug : '',
      titles: !!s.showcase?.titles,
    },
    intake: {
      enabled: !!s.intake?.enabled && GITHUB_REPO_RE.test(s.intake?.repo ?? ''),
      repo: GITHUB_REPO_RE.test(s.intake?.repo ?? '') ? s.intake.repo : '',
      label: String(s.intake?.label ?? d.intake.label).trim().slice(0, 50) || d.intake.label,
      status: s.intake?.status === 'todo' ? 'todo' : 'backlog',
    },
    preview: {
      command: String(s.preview?.command ?? '').slice(0, 500),
      path: String(s.preview?.path ?? '/').slice(0, 200) || '/',
    },
    budgets,
    fallbackEnabled: s.fallbackEnabled ?? d.fallbackEnabled,
    fallback,
    modelTiers: withOldFallbackModels(mergeTiers(d.modelTiers, s.modelTiers), s),
    fallbackReviews: !!s.fallbackReviews,
    fallbackReservePct: Math.max(0, Math.min(95, Number(s.fallbackReservePct ?? d.fallbackReservePct) || 0)),
    watchdog: {
      enabled: s.watchdog?.enabled ?? d.watchdog.enabled,
      rules: Array.isArray(s.watchdog?.rules) ? s.watchdog.rules : d.watchdog.rules,
      llm: { ...d.watchdog.llm, ...(s.watchdog?.llm ?? {}) },
    },
    egress: normalizeEgress(s.egress),
  }
}

// ---------- row mappers ----------
export const mapProject = (r: any) =>
  r && { ...r, paused: !!r.paused, settings: mergeSettings(JSON.parse(r.settings || '{}')) }
export const mapAgent = (r: any) =>
  r && {
    ...r,
    enabled: !!r.enabled,
    provider_override: !!r.provider_override,
    skill_ids: JSON.parse(r.skill_ids || '[]') as number[],
    mcp_ids: JSON.parse(r.mcp_ids || '[]') as string[],
  }
export const mapIssue = (r: any) =>
  r && {
    ...r,
    blocked_by: JSON.parse(r.blocked_by || '[]') as number[],
    reviewers: JSON.parse(r.reviewers || '[]') as number[],
    ...('checklist' in r ? { checklist: JSON.parse(r.checklist || '[]') as string[] } : {}),
  }

const ISSUE_LIGHT =
  'id, project_id, number, title, status, priority, assignee_id, rank, blocked_by, reviewers, review_index, grp, landing, arena_of, updated_at'

export const getProject = (id: number) => mapProject(get('SELECT * FROM projects WHERE id=?', id))
export const getAgent = (id: number) => mapAgent(get('SELECT * FROM agents WHERE id=?', id))
export const getIssue = (id: number) => mapIssue(get('SELECT * FROM issues WHERE id=?', id))
const lightIssue = (id: number) => mapIssue(get(`SELECT ${ISSUE_LIGHT} FROM issues WHERE id=?`, id))

// ---------- event bus (SSE) ----------
/** Gets the event and its JSON, which is made once for all listeners, not once per browser. */
type Listener = (e: any, json: string) => void
const listeners = new Map<number, Set<Listener>>()
export function subscribe(pid: number, fn: Listener) {
  let s = listeners.get(pid)
  if (!s) listeners.set(pid, (s = new Set()))
  s.add(fn)
  return () => s!.delete(fn)
}
// Counts every event of a project, so a reader can tell cheaply whether anything changed.
const versions = new Map<number, number>()
export const versionOf = (pid: number) => versions.get(pid) ?? 0
export function emit(pid: number, e: any) {
  versions.set(pid, versionOf(pid) + 1)
  if (!QUIET_EVENTS.has(e.t)) changedProjects.add(pid)
  const s = listeners.get(pid)
  if (!s?.size) return
  const json = JSON.stringify(e)
  for (const fn of s) fn(e, json)
}

/** Events that say nothing about the board's state: a live output line, the scheduler's own reasons. */
const QUIET_EVENTS = new Set(['activity', 'waiting', 'notice'])

type StatusListener = (issue: any, oldStatus: string, newStatus: string) => void
const statusListeners = new Set<StatusListener>()
/** Called after every real status change of an issue (webhooks). Core does not import them. */
export function onStatusChange(fn: StatusListener) {
  statusListeners.add(fn)
  return () => statusListeners.delete(fn)
}

const changedProjects = new Set<number>()

/** Projects whose issues, agents or settings changed since the last call. Clears the list. */
export function takeChangedProjects() {
  const changed = [...changedProjects]
  changedProjects.clear()
  return changed
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
  'gate_sha',
  'approved_sha',
  'cap_factor',
  'capped',
  'blocker_returns',
  'parked_until',
  'checklist',
  'checklist_report',
  'review_from',
  'review_interim',
  'precheck_fails',
  'arena_winner',
]
const JSON_ISSUE_FIELDS = ['blocked_by', 'reviewers', 'checklist']
/** Fields whose changes the issue page lists in its history. Internal bookkeeping stays out. */
const HISTORY_FIELDS = [
  'title',
  'status',
  'assignee_id',
  'priority',
  'blocked_by',
  'reviewers',
  'grp',
  'model',
]

/** `actor` is who made the change: "Owner", an agent's name, or "System" for the scheduler. */
export function patchIssue(id: number, patch: Record<string, any>, actor = 'System') {
  const sets: string[] = []
  const vals: any[] = []
  for (const k of ISSUE_FIELDS) {
    if (!(k in patch)) continue
    sets.push(`${k}=?`)
    vals.push(JSON_ISSUE_FIELDS.includes(k) ? JSON.stringify(patch[k] ?? []) : patch[k])
  }
  if (!sets.length) return getIssue(id)
  const now = Date.now()
  // Only the tracked fields are read before the write, and only when the patch touches one.
  const tracked = HISTORY_FIELDS.filter((k) => k in patch)
  const before = tracked.length ? get(`SELECT ${tracked.join(', ')} FROM issues WHERE id=?`, id) : null
  // The first time an issue is done counts; reopening it clears the date.
  if (patch.status === 'done') sets.push(`done_at=COALESCE(done_at, ${now})`)
  else if ('status' in patch) sets.push('done_at=NULL')
  run(`UPDATE issues SET ${sets.join(', ')}, updated_at=? WHERE id=?`, ...vals, now, id)
  // As text: a number bound into a TEXT column would come back as "2.0".
  let statusChange: [string, string] | null = null
  const asText = (value: unknown) => (value === null || value === undefined ? null : String(value))
  for (const k of before ? tracked : []) {
    const next = asText(JSON_ISSUE_FIELDS.includes(k) ? JSON.stringify(patch[k] ?? []) : patch[k])
    const old = asText(before![k])
    if ((old ?? '') === (next ?? '')) continue
    if (k === 'status') statusChange = [old ?? '', next ?? '']
    run(
      'INSERT INTO issue_events (issue_id, at, actor, field, old, new) VALUES (?,?,?,?,?,?)',
      id,
      now,
      actor,
      k,
      old,
      next,
    )
  }
  const issue = lightIssue(id)
  if (issue) {
    rememberIssue(issue)
    emit(issue.project_id, { t: 'issue', issue })
    // A listener's error must not undo or break the write that already happened.
    if (statusChange)
      for (const fn of statusListeners)
        try {
          fn(issue, statusChange[0], statusChange[1])
        } catch (error: any) {
          console.error('status listener', error.message)
        }
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
    created_by?: string
    checklist?: string[]
    /** The issue this one is an arena entry for (arena.ts). */
    arena_of?: number
  },
) {
  const p = get('SELECT next_number FROM projects WHERE id=?', pid)
  if (!p) throw new Error('Project not found')
  const now = Date.now()
  run('UPDATE projects SET next_number=next_number+1 WHERE id=?', pid)
  const r = run(
    `INSERT INTO issues (project_id, number, title, description, status, priority, assignee_id, rank,
       blocked_by, reviewers, grp, model, routine_id, created_by, checklist, arena_of, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
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
    f.created_by ?? '',
    JSON.stringify(f.checklist ?? []),
    f.arena_of ?? 0,
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

// 98% used can be represented as 2.0000000000000018% left, not a reason to miss a 2% stop.
const aboveStop = (left: number, stop: number) => left - stop > 1e-9

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
  const quotas = access.mode === 'subscription' ? quotaWindows(provider, now) : []
  const limiting = quotas.filter((q) => q.limiting)
  const quotaLeft = limiting.length
    ? Math.max(0, 100 * (1 - Math.max(...limiting.map((q) => q.utilization))))
    : null
  const left = Math.min(budgetLeft ?? 100, quotaLeft ?? 100)
  const rest = restOf(provider)
  const unsupported = provider === 'claude-managed' && (SANDBOX || process.platform === 'win32')
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
    unsupported,
    /** Set while the provider rests after a limit or a broken login, see recovery.ts. */
    resting: rest ?? null,
    /** Limit resets the provider grants, null when it never reported any. */
    resets: resetsOf(provider),
    available: !unsupported && access.ready && aboveStop(left, b.stopAtPct) && !rest,
  }
}

export type RoutingAgent = { provider: string; model: string; provider_override?: boolean }
type RunKind = 'work' | 'review'

export function providerOrder(s: Settings, agent: RoutingAgent, kind: RunKind = 'work') {
  if (!agent.provider_override) return s.fallback
  const mayFall = s.fallbackEnabled && (kind === 'work' || s.fallbackReviews)
  return [agent.provider, ...(mayFall ? s.fallback.filter((p) => p !== agent.provider) : [])]
}

/** Evaluate candidates in order, keeping the reasons used by the board and the run log. */
export function routeProvider(
  project: { id: number; settings: Settings },
  agent: RoutingAgent,
  avoid?: string,
  kind: RunKind = 'work',
  issueModel = '',
) {
  const s = project.settings
  const order = providerOrder(s, agent, kind)
  const tier = tierOf(s.modelTiers, agent.provider, agent.model)
  const skipped: string[] = []
  let retry: { pick: { provider: string; model: string; fallback: boolean }; skipped: string[] } | undefined
  for (const p of order) {
    if (!PROVIDERS[p]) continue
    const state = providerLeft(project, p)
    const differentProvider = p !== agent.provider
    const model = differentProvider
      ? modelFor(s.modelTiers, tier, p) || PROVIDERS[p].defaultModel
      : issueModel || agent.model || modelFor(s.modelTiers, tier, p) || PROVIDERS[p].defaultModel
    // The reserve protects a provider from agents explicitly assigned elsewhere, not from the
    // project's ordinary priority queue. Its own stop threshold still applies to every run.
    const stop = agent.provider_override && differentProvider
      ? Math.max(state.budget.stopAtPct, s.fallbackReservePct)
      : state.budget.stopAtPct
    const result = { provider: p, model, fallback: differentProvider }
    const reason = state.unsupported ? 'disabled in this environment'
      : !state.ready ? 'not set up'
      : state.resting ? `${state.resting.reason} until ${new Date(state.resting.until).toLocaleString('en-US')}`
      : !aboveStop(state.left, stop) ? `${Math.round(state.left)}% left, stop at ${stop}%`
      : modelLimitReached(p, model) ? `model limit reached (${model})`
      : ''
    if (reason) skipped.push(`${PROVIDERS[p].label}: ${reason}`)
    else if (p === avoid && !agent.provider_override) {
      retry = { pick: result, skipped: [...skipped] }
      skipped.push(`${PROVIDERS[p].label}: held back for a rerun after a repeated error`)
    } else return { pick: result, skipped }
  }
  return retry ?? { pick: null, skipped }
}

export const pickProvider = (...args: Parameters<typeof routeProvider>) => routeProvider(...args).pick
