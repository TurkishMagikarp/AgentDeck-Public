import { createMemo, createRoot, createSignal } from 'solid-js'
import { createStore, produce, reconcile, unwrap } from 'solid-js/store'
import { api } from './api'
import { blockerWeights } from '../../server/blockers.ts'
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
  WaitReason,
} from './types'

type Board = { project: Project | null; agents: Agent[]; skills: Skill[]; issues: Issue[]; runs: Run[] }

const emptyBoard: Board = { project: null, agents: [], skills: [], issues: [], runs: [] }

export const [projects, setProjects] = createSignal<ProjectSummary[]>([])
export const [providers, setProviders] = createSignal<Provider[]>([])
export const [board, setBoard] = createStore<Board>(structuredClone(emptyBoard))
export const [detail, setDetail] = createStore<{ current: IssueDetail | null }>({ current: null })
export const [liveLine, setLiveLine] = createStore<Record<number, string>>({})
export const [notice, setNotice] = createSignal('')
/** Why each waiting issue does not start, by issue id, as the scheduler last saw it. */
export const [waitReasons, setWaitReasons] = createStore<Record<number, WaitReason>>({})
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

/** The project the user picked last. Its board may still be on the way. */
export const [openingProject, setOpeningProject] = createSignal<number | null>(null)

/** The last board seen of each project, so switching back shows it at once while the fresh one loads. */
const lastBoards = new Map<number, Board>()

async function loadBoard(projectId: number) {
  const data = await api.get<Board>(`/projects/${projectId}/board`)
  // A later click may have picked another project while this one was loading.
  if (openingProject() !== projectId) return
  setBoard(reconcile(data, { key: 'id' }))
}

/** Resolves once the event stream is connected, or after a second if the proxy holds it back. */
function connected(source: EventSource) {
  return new Promise<void>((resolve) => {
    source.addEventListener('open', () => resolve(), { once: true })
    setTimeout(resolve, 1000)
  })
}

export async function openProject(projectId: number) {
  if (board.project) lastBoards.set(board.project.id, structuredClone(unwrap(board)))
  setOpeningProject(projectId)
  events?.close()
  closeIssue()
  setGroupFilter('')
  setLiveLine(reconcile({}))
  setNotice('')
  setWaitReasons(reconcile({}))
  const lastBoard = lastBoards.get(projectId)
  if (lastBoard) setBoard(reconcile(lastBoard, { key: 'id' }))

  // Listen first and load after, so no change can slip between the board and the first event.
  // Events that arrive before the board wait for it.
  const source = new EventSource(`/api/events?project=${projectId}`)
  events = source
  let waiting: any[] | null = []
  source.onmessage = (msg) => {
    const event = JSON.parse(msg.data)
    if (waiting) waiting.push(event)
    else handleEvent(projectId, event)
  }
  await connected(source)
  if (events !== source) return

  await loadBoard(projectId)
  if (events !== source) return
  for (const event of waiting) handleEvent(projectId, event)
  waiting = null
  localStorage.setItem('agentdeck.project', String(projectId))

  // EventSource reconnects on its own; after a gap we may have missed events.
  source.addEventListener('open', () => loadBoard(projectId).catch(() => {}))
}

export function closeProject() {
  if (board.project) lastBoards.delete(board.project.id)
  events?.close()
  events = null
  setOpeningProject(null)
  setBoard(reconcile(structuredClone(emptyBoard)))
  localStorage.removeItem('agentdeck.project')
}

/** True while the board on screen is not yet the one of the project the user picked. */
export const switchingProject = () => openingProject() !== null && openingProject() !== board.project?.id

function handleEvent(projectId: number, e: any) {
  switch (e.t) {
    case 'reload':
      loadBoard(projectId).catch(fail)
      loadProjects().catch(() => {})
      break
    case 'issue':
      upsertIssue(e.issue)
      refreshDetail(e.issue.id)
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
    case 'waiting':
      setWaitReasons(reconcile(e.reasons))
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

/** Fetches an issue for its page. Opening goes through the address, see openIssue. */
export async function loadIssue(issueId: number) {
  setDetail('current', await api.get<IssueDetail>(`/issues/${issueId}`))
}

/** Opens the page of an issue of the current project, as a click on its card does. */
export async function openIssue(issueId: number) {
  const issue = board.issues.find((candidate) => candidate.id === issueId)
  if (issue && board.project) showIssuePage(board.project.key, issue.number)
  else await loadIssue(issueId)
}

export function closeIssue() {
  setDetail('current', null)
}

/** The address of an issue page. Search results and shared links use it. */
export const issueLink = (key: string, number: number) => `#${key}-${number}`

/** Opens an issue page and gives it its own history entry, so "back" returns to the board. */
export function showIssuePage(key: string, number: number) {
  const link = issueLink(key, number)
  if (location.hash === link) window.dispatchEvent(new HashChangeEvent('hashchange'))
  else location.hash = link
}

/** Takes the issue address out of the bar without a "hashchange", which would reopen the page. */
function forgetIssueAddress() {
  if (/^#[A-Z][A-Z0-9]+-\d+$/.test(location.hash)) {
    history.pushState(null, '', location.pathname + location.search)
  }
}

/** Leaves the issue page back to the board. */
export function leaveIssuePage() {
  forgetIssueAddress()
  closeIssue()
}

function refreshDetail(issueId: number) {
  if (detail.current?.issue.id === issueId) loadIssue(issueId).catch(() => {})
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

/** The blocker weights the scheduler uses (blockers.ts), kept current with the board. */
export const weights = createRoot(() => createMemo(() => blockerWeights(board.issues)))

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
