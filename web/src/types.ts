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

export type Settings = {
  maxConcurrent: number
  adhd: boolean
  workspace: 'issue' | 'agent'
  maxReviewRounds: number
  landing: { mode: 'off' | 'merge' | 'pr'; baseBranch: string; push: boolean; protectedPaths: string[] }
  notifyOwner: boolean
  escalationAgentId: number
  openGroupsInOrder: boolean
  autonomous: boolean
  budgets: Record<string, Budget>
  fallbackEnabled: boolean
  fallback: string[]
  fallbackModels: Record<string, string>
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

export type IssueDetail = { issue: Issue; comments: Comment[]; runs: Run[] }

export type Provider = { id: string; label: string }
