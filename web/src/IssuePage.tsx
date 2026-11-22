import { createMemo, createSignal, For, onCleanup, onMount, Show, type JSX } from 'solid-js'
import { api } from './api'
import { PRIORITIES } from './Board'
import { Changes } from './Changes'
import { Icon } from './icons'
import { CommentItem, RunItem, Screenshots, Spending } from './IssueParts'
import { ModelSelect } from './ModelSelect'
import { RunLog } from './RunLog'
import {
  agentById,
  board,
  detail,
  fail,
  issueLink,
  leaveIssuePage,
  liveLine,
  openIssue,
  providerLabel,
  runForIssue,
  updateIssue,
  waitReasons,
  weights,
} from './store'
import type { Comment, IssueEvent, IssueLink, Run, Status } from './types'
import { Select, timeAgo } from './ui'

const STATUS_OPTIONS: [Status, string][] = [
  ['backlog', 'Backlog'],
  ['todo', 'To Do'],
  ['in_progress', 'In progress'],
  ['review', 'Review'],
  ['blocked', 'Waits for a human'],
  ['done', 'Done'],
]
const STATUS_LABEL = Object.fromEntries(STATUS_OPTIONS) as Record<string, string>

const FIELD_LABEL: Record<string, string> = {
  title: 'Title',
  status: 'Status',
  assignee_id: 'Agent',
  priority: 'Priority',
  blocked_by: 'Waiting on',
  reviewers: 'Reviewers',
  grp: 'Group',
  model: 'Model',
}

type Tab = 'all' | 'comments' | 'history' | 'runs'
const TABS: [Tab, string][] = [
  ['all', 'All'],
  ['comments', 'Comments'],
  ['history', 'History'],
  ['runs', 'Runs'],
]

type Entry = { at: number; comment?: Comment; event?: IssueEvent; run?: Run }

const when = (at: number) => new Date(at).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })

/**
 * The page of one issue, laid out like Jira: what the issue is about on the left (description,
 * dependencies, preview, code, activity with the comment box at the bottom), its fields on the
 * right. Every card on the board, every search hit and every "#KEY-123" link opens it.
 */
export function IssuePage() {
  const issue = () => detail.current!.issue
  const key = (number = issue().number) => `${board.project?.key}-${number}`
  const activeRun = () => runForIssue(issue().id)
  const version = () => detail.current!.runs.length + detail.current!.comments.length

  const closeOnEscape = (e: KeyboardEvent) =>
    e.key === 'Escape' && !document.querySelector('.palette, .overlay') && leaveIssuePage()
  onMount(() => document.addEventListener('keydown', closeOnEscape))
  onCleanup(() => document.removeEventListener('keydown', closeOnEscape))

  const [copied, setCopied] = createSignal(false)
  function copyLink() {
    navigator.clipboard
      .writeText(location.origin + location.pathname + issueLink(board.project!.key, issue().number))
      .then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      })
      .catch(fail)
  }

  async function remove() {
    if (!confirm(`Really delete ${key()}?`)) return
    await api.del(`/issues/${issue().id}`).catch(fail)
    leaveIssuePage()
  }

  return (
    <div class="issue-page" role="main" aria-label={`Issue ${key()}`}>
      <header class="issue-page-bar">
        <nav class="breadcrumb" aria-label="Breadcrumb">
          <button class="ghost" onClick={leaveIssuePage}>
            {board.project?.name}
          </button>
          <span class="muted">/</span>
          <span class="issue-key">{key()}</span>
        </nav>
        <span class="spacer" />
        <Show when={copied()}>
          <span class="muted copied">Link copied</span>
        </Show>
        <button class="ghost icon-button" title="Copy link" aria-label="Copy link" onClick={copyLink}>
          <Icon name="link" />
        </button>
        <button class="ghost danger" onClick={remove}>
          Delete
        </button>
        <button
          class="ghost icon-button"
          onClick={leaveIssuePage}
          aria-label="Back to the board"
          title="Back to the board (Esc)"
        >
          <Icon name="close" />
        </button>
      </header>

      <div class="issue-layout">
        <input
          class="title-input issue-title"
          aria-label="Title"
          value={issue().title}
          onChange={(e) => updateIssue(issue().id, { title: e.currentTarget.value })}
        />

        <div class="issue-main">
          <Show when={!activeRun() && waitReasons[issue().id]}>
            {(reason) => (
              <p class="wait-reason large">
                <Icon name="clock" size={14} />
                <span>
                  <strong>Waiting:</strong> {reason().text}
                </span>
              </p>
            )}
          </Show>

          <Show when={activeRun()}>
            {(run) => (
              <section class="run-banner-block">
                <div class="run-banner">
                  <span class="pulse" />
                  <div>
                    <strong>{run().agent_name}</strong> is working ({providerLabel(run().provider)})
                    <p class="muted">{liveLine[issue().id] ?? 'starting…'}</p>
                  </div>
                  <button onClick={() => api.post(`/issues/${issue().id}/stop`).catch(fail)}>Stop</button>
                </div>
                <RunLog runId={run().id} live />
              </section>
            )}
          </Show>

          <Description />
          <Dependencies />

          <Show when={issue().handoff}>
            <section class="issue-section">
              <h3>Handoff note</h3>
              <p class="prose">{issue().handoff}</p>
            </section>
          </Show>

          <Screenshots issueId={issue().id} comments={detail.current!.comments.length} />
          <Changes issueId={issue().id} version={version()} />
          <Activity />
        </div>

        <aside class="issue-side" aria-label="Details">
          <Details />
        </aside>
      </div>
    </div>
  )

  function Description() {
    const [editing, setEditing] = createSignal(false)
    const [draft, setDraft] = createSignal('')
    const start = () => {
      setDraft(issue().description ?? '')
      setEditing(true)
    }
    const save = () => {
      updateIssue(issue().id, { description: draft() })
      setEditing(false)
    }

    return (
      <section class="issue-section">
        <div class="issue-section-head">
          <h3>Description</h3>
          <Show when={!editing()}>
            <button class="ghost" onClick={start}>
              Edit
            </button>
          </Show>
        </div>
        <Show
          when={editing()}
          fallback={
            <div class="prose description-view" onDblClick={start} title="Double-click to edit">
              <Show when={issue().description} fallback={<span class="muted">No description.</span>}>
                {issue().description}
              </Show>
            </div>
          }
        >
          <textarea
            class="description"
            aria-label="Description"
            value={draft()}
            onInput={(e) => setDraft(e.currentTarget.value)}
            onKeyDown={(e) => e.key === 'Enter' && (e.ctrlKey || e.metaKey) && save()}
            ref={(element) => queueMicrotask(() => element.focus())}
          />
          <div class="inline-row end">
            <button class="ghost" onClick={() => setEditing(false)}>
              Cancel
            </button>
            <button class="primary" onClick={save}>
              Save
            </button>
          </div>
        </Show>
      </section>
    )
  }

  /** "Waiting on" and "Holding up" as lists, each editable. */
  function Dependencies() {
    const links = () => detail.current!.links
    const holdsInTotal = () => weights().get(issue().number)?.blocks ?? 0

    const numberFrom = (text: string) => Number(text.trim().replace(/^[A-Za-z]+-/, '')) || 0

    function addBlocker(text: string) {
      const number = numberFrom(text)
      if (!number || number === issue().number || issue().blocked_by.includes(number)) return
      updateIssue(issue().id, { blocked_by: [...issue().blocked_by, number] })
    }
    function removeBlocker(number: number) {
      updateIssue(issue().id, { blocked_by: issue().blocked_by.filter((other) => other !== number) })
    }
    // "Holding up" is stored on the other issue: it lists this one among its blockers.
    function addDependent(text: string) {
      const other = board.issues.find((candidate) => candidate.number === numberFrom(text))
      if (!other || other.id === issue().id || other.blocked_by.includes(issue().number)) return
      updateIssue(other.id, { blocked_by: [...other.blocked_by, issue().number] })
    }
    function removeDependent(link: IssueLink) {
      const other = board.issues.find((candidate) => candidate.id === link.id)
      if (other)
        updateIssue(other.id, { blocked_by: other.blocked_by.filter((number) => number !== issue().number) })
    }

    return (
      <section class="issue-section">
        <div class="issue-section-head">
          <h3>Dependencies</h3>
          <Show when={holdsInTotal() > links().dependents.length}>
            <span class="muted">holds up {holdsInTotal()} issues through the chain</span>
          </Show>
        </div>
        <LinkList
          title="Waiting on"
          empty="Not waiting on anything."
          links={links().blockers}
          onRemove={(link) => removeBlocker(link.number)}
          onAdd={addBlocker}
        />
        <LinkList
          title="Holding up"
          empty="Nothing is waiting on this issue."
          links={links().dependents}
          onRemove={removeDependent}
          onAdd={addDependent}
        />
      </section>
    )
  }

  function LinkList(props: {
    title: string
    empty: string
    links: IssueLink[]
    onRemove: (link: IssueLink) => void
    onAdd: (text: string) => void
  }) {
    const [draft, setDraft] = createSignal('')
    return (
      <div class="link-list">
        <h4>{props.title}</h4>
        <ul>
          <For each={props.links} fallback={<li class="muted empty">{props.empty}</li>}>
            {(link) => (
              <li classList={{ done: link.status === 'done' }}>
                <span class={`status-dot ${link.status}`} />
                <button class="link-open" onClick={() => openIssue(link.id).catch(fail)}>
                  <span class="mono">{key(link.number)}</span>
                  <span class="link-title">{link.title}</span>
                </button>
                <span class="muted link-status">{STATUS_LABEL[link.status] ?? link.status}</span>
                <span class="muted link-agent">{agentById(link.assignee_id)?.name ?? ''}</span>
                <button
                  class="ghost icon-button"
                  title="Remove link"
                  aria-label={`Remove ${key(link.number)}`}
                  onClick={() => props.onRemove(link)}
                >
                  <Icon name="close" size={14} />
                </button>
              </li>
            )}
          </For>
        </ul>
        <form
          class="link-add"
          onSubmit={(e) => {
            e.preventDefault()
            props.onAdd(draft())
            setDraft('')
          }}
        >
          <input
            aria-label={`${props.title}: add issue`}
            placeholder={`Add issue, e.g. ${board.project?.key}-12`}
            value={draft()}
            onInput={(e) => setDraft(e.currentTarget.value)}
          />
        </form>
      </div>
    )
  }

  /** Comments, field changes and runs: one stream with tabs, the comment box at the bottom. */
  function Activity() {
    const [tab, setTab] = createSignal<Tab>('all')
    const [comment, setComment] = createSignal('')

    const entries = createMemo<Entry[]>(() => {
      const current = detail.current!
      const chosen = tab()
      const list: Entry[] = []
      if (chosen === 'all' || chosen === 'comments') {
        for (const item of current.comments) {
          // System notes are history, not conversation.
          if (chosen === 'comments' && item.kind === 'system') continue
          list.push({ at: item.created_at, comment: item })
        }
      }
      if (chosen === 'all' || chosen === 'history') {
        for (const item of current.events) list.push({ at: item.at, event: item })
      }
      if (chosen === 'all' || chosen === 'runs') {
        for (const item of current.runs) list.push({ at: item.ended_at ?? item.started_at, run: item })
      }
      return list.sort((a, b) => a.at - b.at)
    })

    async function send(e: SubmitEvent) {
      e.preventDefault()
      const body = comment().trim()
      if (!body) return
      setComment('')
      await api.post(`/issues/${issue().id}/comments`, { body }).catch(fail)
    }

    return (
      <section class="issue-section activity">
        <div class="issue-section-head">
          <h3>Activity</h3>
          <div class="segmented" role="tablist" aria-label="Filter activity">
            <For each={TABS}>
              {([id, label]) => (
                <button
                  role="tab"
                  aria-selected={tab() === id}
                  classList={{ active: tab() === id }}
                  onClick={() => setTab(id)}
                >
                  {label}
                </button>
              )}
            </For>
          </div>
        </div>

        <ul class="timeline">
          <li class="history-item created">
            <span class="muted">
              Created {issue().created_by ? `by ${issue().created_by} ` : ''}
              {issue().created_at ? `on ${when(issue().created_at!)}` : ''}
            </span>
          </li>
          <For each={entries()} fallback={<li class="muted">Nothing yet.</li>}>
            {(entry) =>
              entry.comment ? (
                <CommentItem comment={entry.comment} />
              ) : entry.event ? (
                <HistoryItem event={entry.event} />
              ) : (
                <RunItem run={entry.run!} />
              )
            }
          </For>
        </ul>

        <form class="comment-form inline" onSubmit={send}>
          <textarea
            aria-label="Comment"
            placeholder="Comment or instruction for the agent… (Ctrl+Enter sends)"
            value={comment()}
            onInput={(e) => setComment(e.currentTarget.value)}
            onKeyDown={(e) =>
              e.key === 'Enter' && (e.ctrlKey || e.metaKey) && e.currentTarget.form?.requestSubmit()
            }
          />
          <button class="primary" type="submit" disabled={!comment().trim()}>
            Send
          </button>
        </form>
      </section>
    )
  }

  function HistoryItem(props: { event: IssueEvent }) {
    const value = (raw: string | null): string => {
      const field = props.event.field
      if (raw === null || raw === '') return '–'
      if (field === 'status') return STATUS_LABEL[raw] ?? raw
      if (field === 'priority') return PRIORITIES[Number(raw)] ?? raw
      if (field === 'assignee_id') return agentById(Number(raw))?.name ?? 'any agent'
      if (field === 'blocked_by') {
        const numbers: number[] = JSON.parse(raw)
        return numbers.length ? numbers.map((number) => key(number)).join(', ') : 'nothing'
      }
      if (field === 'reviewers') {
        const ids: number[] = JSON.parse(raw)
        return ids.length ? ids.map((id) => agentById(id)?.name ?? '?').join(', ') : 'none'
      }
      return raw
    }
    return (
      <li class="history-item">
        <strong>{props.event.actor === 'Owner' ? 'You' : props.event.actor}</strong> changed{' '}
        {FIELD_LABEL[props.event.field] ?? props.event.field}:{' '}
        <span class="history-old">{value(props.event.old)}</span>
        <Icon name="chevronRight" size={12} />
        <span class="history-new">{value(props.event.new)}</span>
        <span class="muted" title={when(props.event.at)}>
          {' '}
          · {timeAgo(props.event.at)}
        </span>
      </li>
    )
  }

  function Details() {
    const maker = () => agentById(issue().maker_id ?? null)
    const row = (label: string, content: JSX.Element) => (
      <div class="detail-row">
        <span class="detail-label">{label}</span>
        <div class="detail-value">{content}</div>
      </div>
    )
    function addReviewer(agentId: number) {
      if (agentId) updateIssue(issue().id, { reviewers: [...issue().reviewers, agentId] })
    }
    function removeReviewer(agentId: number) {
      updateIssue(issue().id, { reviewers: issue().reviewers.filter((id) => id !== agentId) })
    }

    return (
      <div class="issue-details">
        <Select
          class={`status-select ${issue().status}`}
          aria-label="Status"
          value={issue().status}
          options={STATUS_OPTIONS}
          onChange={(status) => updateIssue(issue().id, { status })}
        />
        <h3>Details</h3>
        {row(
          'Agent',
          <select
            aria-label="Agent"
            onChange={(e) => updateIssue(issue().id, { assignee_id: Number(e.currentTarget.value) || null })}
          >
            <option value="">Any free agent</option>
            <For each={board.agents}>
              {(agent) => (
                <option value={agent.id} selected={agent.id === issue().assignee_id}>
                  {agent.name}
                </option>
              )}
            </For>
          </select>,
        )}
        {row(
          'Priority',
          <select
            aria-label="Priority"
            onChange={(e) => updateIssue(issue().id, { priority: Number(e.currentTarget.value) })}
          >
            <For each={PRIORITIES}>
              {(label, index) => (
                <option value={index()} selected={index() === issue().priority}>
                  {label}
                </option>
              )}
            </For>
          </select>,
        )}
        {row(
          'Reviewers',
          <div class="reviewers">
            <For each={issue().reviewers}>
              {(agentId, index) => (
                <button class="chip" title="Remove" onClick={() => removeReviewer(agentId)}>
                  {index() + 1}. {agentById(agentId)?.name ?? '?'}
                  <Icon name="close" size={11} />
                </button>
              )}
            </For>
            <select
              aria-label="Add reviewer"
              onChange={(e) => {
                addReviewer(Number(e.currentTarget.value))
                e.currentTarget.value = ''
              }}
            >
              <option value="">+ Reviewer</option>
              <For each={board.agents.filter((agent) => !issue().reviewers.includes(agent.id))}>
                {(agent) => <option value={agent.id}>{agent.name}</option>}
              </For>
            </select>
          </div>,
        )}
        {row(
          'Group',
          <input
            aria-label="Group"
            placeholder="e.g. Milestone 1"
            value={issue().grp}
            onChange={(e) => updateIssue(issue().id, { grp: e.currentTarget.value })}
          />,
        )}
        {row(
          'Model',
          <ModelSelect
            provider={agentById(issue().assignee_id)?.provider ?? ''}
            value={issue().model ?? ''}
            emptyLabel="Agent's model"
            onChange={(model) => updateIssue(issue().id, { model })}
          />,
        )}
        {row('Spent', <Spending issueId={issue().id} version={version()} />)}

        <h3>History</h3>
        {row('Built by', <span>{maker()?.name ?? '–'}</span>)}
        {row('Created', <span>{issue().created_at ? when(issue().created_at!) : '–'}</span>)}
        {row('Updated', <span>{issue().updated_at ? when(issue().updated_at!) : '–'}</span>)}
        <Show when={issue().done_at}>{row('Done', <span>{when(issue().done_at!)}</span>)}</Show>
        <Show when={issue().landing === 'waiting'}>
          {row('Landing', <span>Pull request waiting for checks</span>)}
        </Show>
      </div>
    )
  }
}
