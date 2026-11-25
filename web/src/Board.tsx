import { createMemo, createSignal, For, Show } from 'solid-js'
import { api } from './api'
import { byBlockerWeight } from '../../server/blockers.ts'
import {
  agentById,
  board,
  fail,
  groupFilter,
  issueLink,
  liveLine,
  openIssue,
  runForIssue,
  setGroupFilter,
  updateIssue,
  waitReasons,
  weights,
} from './store'
import type { Issue, Status } from './types'
import { Icon } from './icons'
import { initials } from './ui'

const COLUMNS: { status: Status; label: string; canAdd?: boolean }[] = [
  { status: 'backlog', label: 'Backlog', canAdd: true },
  { status: 'todo', label: 'To Do', canAdd: true },
  { status: 'in_progress', label: 'In progress' },
  { status: 'review', label: 'Review' },
  { status: 'blocked', label: 'Waits for a human' },
  { status: 'done', label: 'Fertig' },
]

export const PRIORITIES = ['Low', 'Normal', 'High', 'Urgent']

type SortKey = 'priority' | 'newest' | 'oldest' | 'updated' | 'title' | 'assignee'

const SORTS: [SortKey, string][] = [
  ['priority', 'Priority'],
  ['newest', 'Newest first'],
  ['oldest', 'Oldest first'],
  ['updated', 'Last changed'],
  ['title', 'Title A–Z'],
  ['assignee', 'Agent'],
]

/** Each column remembers its own order, per project and browser. */
const sortStorageKey = (status: Status) => `agentdeck.sort.${board.project?.id}.${status}`

function storedSort(status: Status): SortKey {
  const stored = localStorage.getItem(sortStorageKey(status))
  return SORTS.some(([key]) => key === stored) ? (stored as SortKey) : 'priority'
}

function compareBy(key: SortKey): (a: Issue, b: Issue) => number {
  switch (key) {
    case 'newest':
      return (a, b) => b.number - a.number
    case 'oldest':
      return (a, b) => a.number - b.number
    case 'updated':
      return (a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0) || b.number - a.number
    case 'title':
      return (a, b) => a.title.localeCompare(b.title, 'en') || a.number - b.number
    case 'assignee': {
      // Unassigned issues go last.
      const name = (issue: Issue) => agentById(issue.assignee_id)?.name ?? '￿'
      return (a, b) => name(a).localeCompare(name(b), 'en') || b.priority - a.priority || a.number - b.number
    }
    default:
      return (a, b) => {
        const byWeight = board.project?.settings.blockerBoost ? byBlockerWeight(weights())(a, b) : 0
        return byWeight || b.priority - a.priority || a.number - b.number
      }
  }
}

export function Board() {
  // In an autonomous project nothing waits for a person, so that column only shows up while
  // something is still in it (the server clears it within seconds).
  const visibleColumns = createMemo(() =>
    COLUMNS.filter(
      (column) =>
        column.status !== 'blocked' ||
        !board.project?.settings.autonomous ||
        board.issues.some((issue) => issue.status === 'blocked'),
    ),
  )
  const countByStatus = createMemo(() => {
    const counts: Partial<Record<Status, number>> = {}
    for (const issue of board.issues) {
      if (groupFilter() && issue.grp !== groupFilter()) continue
      counts[issue.status] = (counts[issue.status] ?? 0) + 1
    }
    return counts
  })

  function showColumn(status: Status) {
    document
      .getElementById(`column-${status}`)
      ?.scrollIntoView({ behavior: 'smooth', inline: 'start', block: 'nearest' })
  }

  const groups = createMemo(() => [...new Set(board.issues.map((issue) => issue.grp).filter(Boolean))].sort())

  return (
    <>
      <Show when={groups().length}>
        <div class="board-filter">
          <button classList={{ active: groupFilter() === '' }} onClick={() => setGroupFilter('')}>
            All
          </button>
          <For each={groups()}>
            {(group) => (
              <button classList={{ active: groupFilter() === group }} onClick={() => setGroupFilter(group)}>
                {group}
              </button>
            )}
          </For>
        </div>
      </Show>
      <QueueSummary />
      {/* Phones show one column at a time; this bar says how much is where and jumps there. */}
      <nav class="board-jump" aria-label="Jump to column">
        <For each={visibleColumns()}>
          {(column) => (
            <button onClick={() => showColumn(column.status)}>
              <span class={`status-dot ${column.status}`} />
              {column.label}
              <strong>{countByStatus()[column.status] ?? 0}</strong>
            </button>
          )}
        </For>
      </nav>
      <div class="board">
        <For each={visibleColumns()}>{(column) => <Column {...column} />}</For>
      </div>
    </>
  )
}

function Column(props: { status: Status; label: string; canAdd?: boolean }) {
  const [dropTarget, setDropTarget] = createSignal(false)
  const [draft, setDraft] = createSignal('')
  // Re-read when the project changes, so every project keeps its own order.
  const [sortOverride, setSortOverride] = createSignal<{ project: number; key: SortKey } | null>(null)
  const sort = () => {
    const override = sortOverride()
    return override && override.project === board.project?.id ? override.key : storedSort(props.status)
  }
  function changeSort(key: SortKey) {
    localStorage.setItem(sortStorageKey(props.status), key)
    setSortOverride({ project: board.project!.id, key })
  }

  const issues = createMemo(() =>
    board.issues
      .filter((issue) => issue.status === props.status)
      .filter((issue) => !groupFilter() || issue.grp === groupFilter())
      .sort(compareBy(sort())),
  )

  function onDrop(e: DragEvent) {
    e.preventDefault()
    setDropTarget(false)
    const issueId = Number(e.dataTransfer?.getData('text/plain'))
    const issue = board.issues.find((i) => i.id === issueId)
    if (issue && issue.status !== props.status) updateIssue(issueId, { status: props.status })
  }

  async function addIssue(e: SubmitEvent) {
    e.preventDefault()
    const title = draft().trim()
    if (!title || !board.project) return
    setDraft('')
    await api
      .post(`/projects/${board.project.id}/issues`, { title, status: props.status, grp: groupFilter() })
      .catch(fail)
  }

  return (
    <section
      id={`column-${props.status}`}
      class="column"
      data-status={props.status}
      classList={{ 'drop-target': dropTarget() }}
      onDragOver={(e) => {
        e.preventDefault()
        setDropTarget(true)
      }}
      onDragLeave={() => setDropTarget(false)}
      onDrop={onDrop}
    >
      <header>
        <span class={`status-dot ${props.status}`} />
        <h3>{props.label}</h3>
        <span class="count">{issues().length}</span>
        <select
          class="column-sort"
          classList={{ changed: sort() !== 'priority' }}
          aria-label={`Sort ${props.label}`}
          title="Order of this column"
          onChange={(e) => changeSort(e.currentTarget.value as SortKey)}
        >
          <For each={SORTS}>
            {([key, label]) => (
              <option value={key} selected={sort() === key}>
                {label}
              </option>
            )}
          </For>
        </select>
      </header>

      <div class="cards">
        <For each={issues()}>{(issue) => <Card issue={issue} />}</For>
      </div>

      <Show when={props.canAdd}>
        <form class="quick-add" onSubmit={addIssue}>
          <input
            placeholder="+ New issue"
            aria-label="Create a new issue"
            value={draft()}
            onInput={(e) => setDraft(e.currentTarget.value)}
          />
        </form>
      </Show>
    </section>
  )
}

function Card(props: { issue: Issue }) {
  const assignee = () => agentById(props.issue.assignee_id)
  const run = () => runForIssue(props.issue.id)
  const weight = () => weights().get(props.issue.number)
  const boosted = () => !!board.project?.settings.blockerBoost && props.issue.status !== 'done'
  const shownPriority = () =>
    boosted() ? (weight()?.effective ?? props.issue.priority) : props.issue.priority
  const raised = () => shownPriority() > props.issue.priority
  const waitingOn = () =>
    props.issue.blocked_by.filter((number) =>
      board.issues.some((i) => i.number === number && i.status !== 'done'),
    )

  return (
    <article
      class="card"
      classList={{ running: !!run() }}
      draggable={true}
      onDragStart={(e) => e.dataTransfer?.setData('text/plain', String(props.issue.id))}
      onClick={() => openIssue(props.issue.id).catch(fail)}
    >
      <div class="card-top">
        {/* A real link: Ctrl- or middle-click opens the issue page in a new tab. */}
        <a
          class="issue-key"
          href={issueLink(board.project?.key ?? '', props.issue.number)}
          onClick={(e) => e.stopPropagation()}
        >
          {board.project?.key}-{props.issue.number}
        </a>
        <Show when={shownPriority() >= 2}>
          <span
            class={`priority p${shownPriority()}`}
            title={raised() ? `Raised because ${weight()!.blocks} issues wait on it` : undefined}
          >
            <Show when={raised()}>
              <Icon name="arrowUp" size={11} />
            </Show>
            {PRIORITIES[shownPriority()]}
          </span>
        </Show>
        <Show when={weight()?.blocks}>
          <span class="holds" title={`Holds up ${weight()!.blocks} issues`}>
            holds up {weight()!.blocks}
          </span>
        </Show>
        <Show when={waitingOn().length}>
          <span class="waiting" title="Waiting on these issues">
            <Icon name="clock" size={11} />
            {waitingOn()
              .map((n) => `${board.project?.key}-${n}`)
              .join(', ')}
          </span>
        </Show>
      </div>

      <p class="card-title">{props.issue.title}</p>

      <Show when={props.issue.landing === 'waiting'}>
        <p class="review-badge">Pull request waits for checks</p>
      </Show>
      <Show when={props.issue.landing === 'approval'}>
        <p class="review-badge">Landing waits for your approval</p>
      </Show>
      <Show when={props.issue.landing === 'arena'}>
        <p class="review-badge">Arena: waits for the jury</p>
      </Show>
      <Show when={props.issue.review_index >= 0}>
        <p class="review-badge">Review by {assignee()?.name ?? 'reviewer'}</p>
      </Show>

      {/* Blockers already show as the marker in the top line. */}
      <Show when={!run() && waitReasons[props.issue.id]?.kind !== 'blocked' && waitReasons[props.issue.id]}>
        {(reason) => (
          <p class={`wait-reason ${reason().kind}`} title={reason().text}>
            <Icon name="clock" size={12} />
            {reason().text}
          </p>
        )}
      </Show>

      <Show when={run()}>
        <p class="live-line">
          <span class="pulse" />
          {liveLine[props.issue.id] ?? 'starting…'}
        </p>
      </Show>

      <Show when={assignee()}>
        {(agent) => (
          <div class="card-foot">
            <span class={`avatar ${run()?.provider ?? agent().provider}`}>{initials(agent().name)}</span>
            <span class="muted">{agent().name}</span>
          </div>
        )}
      </Show>
    </article>
  )
}

const REASON_LABEL: Record<string, string> = {
  blocked: 'waiting on blockers',
  merge: 'waiting for the merge of their blockers',
  landing: 'approved, waiting for landing',
  retry: 'waiting for a retry',
  agent: 'waiting for their agent',
  full: 'waiting for a free slot',
  provider: 'waiting for a provider',
  saving: 'waiting to save quota',
}

/**
 * One line above the board that says what holds the queue up, so "only one agent works" never
 * needs a guess. A click on a reason shows its first issue.
 */
function QueueSummary() {
  const groups = createMemo(() => {
    const byKind = new Map<string, number[]>()
    for (const [id, reason] of Object.entries(waitReasons)) {
      byKind.set(reason.kind, [...(byKind.get(reason.kind) ?? []), Number(id)])
    }
    return [...byKind.entries()].sort((a, b) => b[1].length - a[1].length)
  })

  return (
    <Show when={board.project?.paused || groups().length}>
      <div class="queue-summary">
        <Show
          when={!board.project?.paused}
          fallback={<span>Project paused: nothing starts until you press "Resume".</span>}
        >
          <span class="muted">Queue:</span>
          <For each={groups()}>
            {([kind, ids]) => (
              <button
                class={`queue-reason ${kind}`}
                title={waitReasons[ids[0]]?.text}
                onClick={() => openIssue(ids[0]).catch(fail)}
              >
                <strong>{ids.length}</strong> {REASON_LABEL[kind] ?? kind}
              </button>
            )}
          </For>
        </Show>
      </div>
    </Show>
  )
}
