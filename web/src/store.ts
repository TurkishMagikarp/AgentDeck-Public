import { createSignal } from 'solid-js'
import { createStore, produce, reconcile, unwrap } from 'solid-js/store'
import { api } from './api'
import type {
  Agent,
  Comment,
  Issue,
  IssueDetail,
  Project,
  ProjectSummary,
  Provider,
  Run,
  Settings,
  Skill,
} from './types'

type Board = { project: Project | null; agents: Agent[]; skills: Skill[]; issues: Issue[]; runs: Run[] }

const emptyBoard: Board = { project: null, agents: [], skills: [], issues: [], runs: [] }

export const [projects, setProjects] = createSignal<ProjectSummary[]>([])
export const [providers, setProviders] = createSignal<Provider[]>([])
export const [board, setBoard] = createStore<Board>(structuredClone(emptyBoard))
export const [detail, setDetail] = createStore<{ current: IssueDetail | null }>({ current: null })
export const [liveLine, setLiveLine] = createStore<Record<number, string>>({})
export const [notice, setNotice] = createSignal('')
/** Models each provider offers, by provider id. */
export const [models, setModels] = createSignal<Record<string, string[]>>({})

type OutputListener = (line: { at: number; text: string }) => void
const outputListeners = new Map<number, Set<OutputListener>>()

/** Calls `listener` for every new line of a running agent. Returns the function that stops it. */
export function onRunOutput(runId: number, listener: OutputListener) {
  const listeners = outputListeners.get(runId) ?? new Set()
  outputListeners.set(runId, listeners.add(listener))
  return () => listeners.delete(listener)
}
/** Board filter: '' shows every group. */
export const [groupFilter, setGroupFilter] = createSignal('')
export const [error, setError] = createSignal('')

let events: EventSource | null = null

export function fail(e: unknown) {
  setError(e instanceof Error ? e.message : String(e))
  setTimeout(() => setError(''), 6000)
}

export async function loadProjects() {
  setProjects(await api.get<ProjectSummary[]>('/projects'))
}

export async function loadMeta() {
  const meta = await api.get<{ providers: Provider[] }>('/meta')
  setProviders(meta.providers)
  // The lists take a moment (they ask the CLIs), so the page does not wait for them.
  api
    .get<Record<string, string[]>>('/models')
    .then(setModels)
    .catch(() => {})
}

async function loadBoard(projectId: number) {
  const data = await api.get<Board>(`/projects/${projectId}/board`)
  setBoard(reconcile(data, { key: 'id' }))
}

export async function openProject(projectId: number) {
  events?.close()
  closeIssue()
  setGroupFilter('')
  setLiveLine(reconcile({}))
  setNotice('')
  await loadBoard(projectId)
  localStorage.setItem('agentdeck.project', String(projectId))

  events = new EventSource(`/api/events?project=${projectId}`)
  events.onmessage = (msg) => handleEvent(projectId, JSON.parse(msg.data))
  // EventSource reconnects on its own; after a gap we may have missed events.
  events.onopen = () => loadBoard(projectId).catch(() => {})
}

export function closeProject() {
  events?.close()
  events = null
  setBoard(reconcile(structuredClone(emptyBoard)))
  localStorage.removeItem('agentdeck.project')
}

function handleEvent(projectId: number, e: any) {
  switch (e.t) {
    case 'reload':
      loadBoard(projectId).catch(fail)
      loadProjects().catch(() => {})
      break
    case 'issue':
      upsertIssue(e.issue)
      break
    case 'run.start':
      setBoard('runs', (runs) => [...runs.filter((r) => r.id !== e.run.id), e.run])
      refreshDetail(e.run.issue_id)
      break
    case 'run.end':
      setBoard('runs', (runs) => runs.filter((r) => r.id !== e.id))
      setLiveLine(e.issueId, undefined!)
      refreshDetail(e.issueId)
      break
    case 'activity':
      setLiveLine(e.issueId, e.text)
      for (const listener of outputListeners.get(e.runId) ?? [])
        listener({ at: e.at ?? Date.now(), text: e.text })
      break
    case 'comment':
      appendComment(e.comment)
      break
    case 'notice':
      setNotice(e.text)
      break
  }
}

function upsertIssue(issue: Issue) {
  const index = board.issues.findIndex((i) => i.id === issue.id)
  if (index === -1) setBoard('issues', board.issues.length, issue)
  else setBoard('issues', index, issue)

  // Board events carry no description or handoff, so merge instead of replacing.
  if (detail.current?.issue.id === issue.id)
    setDetail('current', 'issue', (current) => ({ ...current, ...issue }))
}

function appendComment(comment: Comment) {
  if (detail.current?.issue.id !== comment.issue_id) return
  if (detail.current.comments.some((c) => c.id === comment.id)) return
  setDetail('current', 'comments', (list) => [...list, comment])
}

export async function openIssue(issueId: number) {
  setDetail('current', await api.get<IssueDetail>(`/issues/${issueId}`))
}

export function closeIssue() {
  setDetail('current', null)
}

function refreshDetail(issueId: number) {
  if (detail.current?.issue.id === issueId) openIssue(issueId).catch(() => {})
}

/** Optimistic update: the card moves immediately, the server confirms via SSE. */
export function updateIssue(issueId: number, patch: Partial<Issue>) {
  setBoard(
    'issues',
    (i) => i.id === issueId,
    produce((issue) => Object.assign(issue, patch)),
  )
  return api.patch(`/issues/${issueId}`, patch).catch(fail)
}

export function saveSettings(change: (settings: Settings) => void) {
  const project = board.project
  if (!project) return
  const settings = structuredClone(unwrap(project.settings))
  change(settings)
  setBoard('project', 'settings', reconcile(settings))
  return api.patch(`/projects/${project.id}`, { settings }).catch(fail)
}

export const agentById = (id: number | null) => board.agents.find((a) => a.id === id)
export const providerLabel = (id: string) => providers().find((p) => p.id === id)?.label ?? id
export const runForIssue = (issueId: number) => board.runs.find((r) => r.issue_id === issueId)
