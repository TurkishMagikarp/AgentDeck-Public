import { createMemo, createSignal, For, Show } from 'solid-js'
import { api } from './api'
import {
  agentById,
  board,
  fail,
  groupFilter,
  liveLine,
  openIssue,
  runForIssue,
  setGroupFilter,
  updateIssue,
} from './store'
import type { Issue, Status } from './types'
import { initials } from './ui'

const COLUMNS: { status: Status; label: string; canAdd?: boolean }[] = [
  { status: 'backlog', label: 'Backlog', canAdd: true },
  { status: 'todo', label: 'To Do', canAdd: true },
  { status: 'in_progress', label: 'In progress' },
  { status: 'review', label: 'Review' },
  { status: 'blocked', label: 'Waits for a human' },
  { status: 'done', label: 'Done' },
]

export const PRIORITIES = ['Low', 'Normal', 'High', 'Urgent']

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

  const issues = createMemo(() =>
    board.issues
      .filter((issue) => issue.status === props.status)
      .filter((issue) => !groupFilter() || issue.grp === groupFilter())
      .sort((a, b) => b.priority - a.priority || a.number - b.number),
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
      </header>

      <div class="cards">
        <For each={issues()}>{(issue) => <Card issue={issue} />}</For>
      </div>

      <Show when={props.canAdd}>
        <form class="quick-add" onSubmit={addIssue}>
          <input placeholder="+ New issue" value={draft()} onInput={(e) => setDraft(e.currentTarget.value)} />
        </form>
      </Show>
    </section>
  )
}

function Card(props: { issue: Issue }) {
  const assignee = () => agentById(props.issue.assignee_id)
  const run = () => runForIssue(props.issue.id)
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
        <span class="issue-key">
          {board.project?.key}-{props.issue.number}
        </span>
        <Show when={props.issue.priority >= 2}>
          <span class={`priority p${props.issue.priority}`}>{PRIORITIES[props.issue.priority]}</span>
        </Show>
        <Show when={waitingOn().length}>
          <span class="waiting" title="Waiting on these issues">
            ⏳{' '}
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
      <Show when={props.issue.review_index >= 0}>
        <p class="review-badge">Review by {assignee()?.name ?? 'reviewer'}</p>
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
