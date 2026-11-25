export type Status = 'backlog' | 'todo' | 'in_progress' | 'review' | 'blocked' | 'done'

export type Budget = {
  limit: number
  unit: 'usd' | 'tokens' | 'runs'
  window: '5h' | 'day' | 'week' | 'month'
  stopAtPct: number
  scope: 'project' | 'global'
}

export type WatchdogRule = {
  type: 'stall' | 'runtime' | 'attempts'
  value: number
  action: 'comment' | 'stop' | 'block'
}

export type JournalKind =
  | 'landed'
  | 'landingRed'
  | 'precheckRed'
  | 'approved'
  | 'changes'
  | 'partial'
  | 'waits'
  | 'escalated'
  | 'watchdog'
  | 'runFailed'

/** One line of the project journal, see server/journal.ts. */
export type JournalEntry = { at: number; issue: number; title: string; kind: JournalKind; text: string }

export type WaitReason = {
  kind: 'blocked' | 'merge' | 'landing' | 'retry' | 'agent' | 'full' | 'provider' | 'saving'
  text: string
}

export type WebhookEvent = 'review' | 'blocked' | 'done' | 'failed' | 'owner'
/** The URL and secret stay on the server; the board only knows the host. */
export type Webhook = { id: string; kind: 'slack' | 'generic'; host: string; events: WebhookEvent[] }

export type Settings = {
  maxConcurrent: number
  adhd: boolean
  caveman: boolean
  replay: boolean
  workspace: 'issue' | 'agent'
  maxReviewRounds: number
  checklists: { enabled: boolean; templates: string }
  precheck: { enabled: boolean; command: string; timeoutMin: number; commandAt: 'review' | 'landing' }
  resumeReview: boolean
  landing: {
    mode: 'off' | 'merge' | 'pr'
    baseBranch: string
    push: boolean
    protectedPaths: string[]
    githubTokenFile: string
    mergeMethod: 'merge' | 'squash' | 'rebase'
    evidence: { paths: string[]; markers: string[] }
    approval: { merge: boolean; dependencies: boolean; infra: boolean; infraGlobs: string[] }
  }
  notifyOwner: boolean
  webhooks: Webhook[]
  escalationAgentId: number
  openGroupsInOrder: boolean
  autonomous: boolean
  quotaPacing: boolean
  blockerBoost: boolean
  issueCap: { usd: number; tokens: number }
  showcase: { enabled: boolean; slug: string; titles: boolean }
  intake: { enabled: boolean; repo: string; label: string; status: 'backlog' | 'todo' }
  preview: { command: string; path: string }
  budgets: Record<string, Budget>
  fallbackEnabled: boolean
  fallback: string[]
  modelTiers: Record<Tier, Record<string, string>>
  fallbackReviews: boolean
  fallbackReservePct: number
  watchdog: {
    enabled: boolean
    rules: WatchdogRule[]
    llm: { enabled: boolean; provider: string; prompt: string; onFail: 'todo' | 'blocked' }
  }
  egress: { mode: 'open' | 'allowlist'; allow: string[] }
}

export type Project = {
  id: number
  key: string
  name: string
  description: string
  repo_path: string
  paused: boolean
  settings: Settings
}

export type ProjectSummary = {
  id: number
  key: string
  name: string
  paused: number
  open: number
  running: number
}

export type Agent = {
  provider_override: boolean
  id: number
  name: string
  role: string
  provider: string
  model: string
  instructions: string
  skill_ids: number[]
  max_instances: number
  mcp_ids: string[]
  effort: string
  enabled: boolean
}

export type Skill = { id: number; name: string; description: string; content: string }

export type Issue = {
  id: number
  number: number
  title: string
  status: Status
  priority: number
  assignee_id: number | null
  blocked_by: number[]
  /** Agent ids that have to approve, in order. */
  reviewers: number[]
  /** -1 while the maker works, otherwise the position of the reviewer whose turn it is. */
  review_index: number
  grp: string
  /** 'waiting' while a pull request is open and its checks run, 'approval' while held at a gate. */
  landing: string
  /** The commit held at an approval gate; only on the issue page. */
  gate_sha?: string
  model?: string
  description?: string
  handoff?: string
  /** What "done" means for this issue, one checkable item each. */
  checklist?: string[]
  /** The maker's last report on the checklist, as it wrote it. */
  checklist_report?: string
  maker_id?: number | null
  created_by?: string
  /** URL of the GitHub issue this one was taken from. */
  source?: string
  /** The issue this one is an arena entry for, 0 for every other issue. */
  arena_of?: number
  created_at?: number
  updated_at?: number
  done_at?: number | null
}

export type Run = {
  id: number
  issue_id: number
  agent_id: number | null
  agent_name: string
  provider: string
  model: string
  status?: string
  started_at: number
  ended_at?: number
  input_tokens?: number
  cached_tokens?: number
  output_tokens?: number
  cost_usd?: number
  note?: string
}

export type Comment = {
  id: number
  issue_id: number
  author: string
  kind: string
  body: string
  created_at: number
}

/** One change of a field, as the history tab shows it. old/new are stored as text. */
export type IssueEvent = {
  id: number
  at: number
  actor: string
  field: string
  old: string | null
  new: string | null
}

/** An issue on the other end of a dependency. */
export type IssueLink = {
  id: number
  number: number
  title: string
  status: Status
  assignee_id: number | null
}

export type ArenaEntry = {
  id: number
  number: number
  agent: string
  status: Status
  state: 'working' | 'handed-in' | 'out' | 'winner' | 'lost'
  costUsd: number
  minutes: number
}

/** Several agents on one issue, a jury picks (server/arena.ts). winnerId -1: ended without a winner. */
export type ArenaView = {
  parent: { id: number; number: number; title: string; status: Status }
  entries: ArenaEntry[]
  winnerId: number
  phase: 'waiting' | 'judge' | 'empty' | 'closed'
}

export type IssueDetail = {
  issue: Issue
  comments: Comment[]
  runs: Run[]
  events: IssueEvent[]
  links: { blockers: IssueLink[]; dependents: IssueLink[] }
}

export type Provider = { id: string; label: string }

export const TIERS = ['strong', 'medium', 'light'] as const
export type Tier = (typeof TIERS)[number]
export const TIER_LABEL: Record<Tier, string> = { strong: 'Strong', medium: 'Medium', light: 'Light' }
