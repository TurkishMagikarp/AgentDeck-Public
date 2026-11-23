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

export type WaitReason = {
  kind: 'blocked' | 'retry' | 'agent' | 'full' | 'provider' | 'saving'
  text: string
}

export type Settings = {
  maxConcurrent: number
  adhd: boolean
  caveman: boolean
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
  }
  notifyOwner: boolean
  escalationAgentId: number
  openGroupsInOrder: boolean
  autonomous: boolean
  quotaPacing: boolean
  blockerBoost: boolean
  issueCap: { usd: number; tokens: number }
  showcase: { enabled: boolean; slug: string; titles: boolean }
  preview: { command: string; path: string }
  budgets: Record<string, Budget>
  fallbackEnabled: boolean
  fallback: string[]
  fallbackModels: Record<string, string>
  fallbackReviews: boolean
  fallbackReservePct: number
  watchdog: {
    enabled: boolean
    rules: WatchdogRule[]
    llm: { enabled: boolean; provider: string; prompt: string; onFail: 'todo' | 'blocked' }
  }
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
  /** 'waiting' while a pull request is open and its checks run. */
  landing: string
  model?: string
  description?: string
  handoff?: string
  /** What "done" means for this issue, one checkable item each. */
  checklist?: string[]
  /** The maker's last report on the checklist, as it wrote it. */
  checklist_report?: string
  maker_id?: number | null
  created_by?: string
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

export type IssueDetail = {
  issue: Issue
  comments: Comment[]
  runs: Run[]
  events: IssueEvent[]
  links: { blockers: IssueLink[]; dependents: IssueLink[] }
}

export type Provider = { id: string; label: string }
