import { createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import { api } from './api'
import { PRIORITIES } from './Board'
import { ModelSelect } from './ModelSelect'
import { RunLog } from './RunLog'
import { board, closeIssue, detail, fail, liveLine, providerLabel, runForIssue, updateIssue } from './store'
import type { Comment, Run, Status } from './types'
import { formatTokens, Select, timeAgo } from './ui'

const STATUS_OPTIONS: [Status, string][] = [
  ['backlog', 'Backlog'],
  ['todo', 'To do'],
  ['in_progress', 'In progress'],
  ['review', 'Review'],
  ['blocked', 'Waits for a human'],
  ['done', 'Done'],
]

type TimelineEntry = { at: number; comment?: Comment; run?: Run }

export function IssuePanel() {
  const issue = () => detail.current!.issue
  const [comment, setComment] = createSignal('')
  const activeRun = () => runForIssue(issue().id)

  const closeOnEscape = (e: KeyboardEvent) => e.key === 'Escape' && closeIssue()
  onMount(() => document.addEventListener('keydown', closeOnEscape))
  onCleanup(() => document.removeEventListener('keydown', closeOnEscape))

  // Comments and finished runs share one timeline, like a Jira activity stream.
  const timeline = createMemo<TimelineEntry[]>(() => {
    const current = detail.current!
    const entries: TimelineEntry[] = [
      ...current.comments.map((c) => ({ at: c.created_at, comment: c })),
      ...current.runs
        .filter((r) => r.status !== 'running')
        .map((r) => ({ at: r.ended_at ?? r.started_at, run: r })),
    ]
    return entries.sort((a, b) => a.at - b.at)
  })

  async function sendComment(e: SubmitEvent) {
    e.preventDefault()
    const body = comment().trim()
    if (!body) return
    setComment('')
    await api.post(`/issues/${issue().id}/comments`, { body }).catch(fail)
  }

  async function remove() {
    if (!confirm(`Delete ${board.project?.key}-${issue().number}?`)) return
    await api.del(`/issues/${issue().id}`).catch(fail)
    closeIssue()
  }

  function addReviewer(agentId: number) {
    if (agentId) updateIssue(issue().id, { reviewers: [...issue().reviewers, agentId] })
  }

  function removeReviewer(agentId: number) {
    updateIssue(issue().id, { reviewers: issue().reviewers.filter((id) => id !== agentId) })
  }

  function saveBlockedBy(text: string) {
    const numbers = text
      .split(/[\s,]+/)
      .map((part) => Number(part.replace(/^\D+/, '')))
      .filter(Boolean)
    updateIssue(issue().id, { blocked_by: numbers })
  }

  return (
    <aside class="panel">
      <header>
        <span class="issue-key">
          {board.project?.key}-{issue().number}
        </span>
        <span class="spacer" />
        <button class="ghost danger" onClick={remove}>
          Delete
        </button>
        <button class="ghost" onClick={closeIssue} aria-label="Close">
          ✕
        </button>
      </header>

      <div class="panel-body">
        <input
          class="title-input"
          value={issue().title}
          onChange={(e) => updateIssue(issue().id, { title: e.currentTarget.value })}
        />

        <div class="props">
          <label>
            Status
            <Select
              value={issue().status}
              options={STATUS_OPTIONS}
              onChange={(status) => updateIssue(issue().id, { status })}
            />
          </label>
          <label>
            Agent
            <select
              onChange={(e) =>
                updateIssue(issue().id, { assignee_id: Number(e.currentTarget.value) || null })
              }
            >
              <option value="">Any free agent</option>
              <For each={board.agents}>
                {(agent) => (
                  <option value={agent.id} selected={agent.id === issue().assignee_id}>
                    {agent.name}
                  </option>
                )}
              </For>
            </select>
          </label>
          <label>
            Priority
            <select onChange={(e) => updateIssue(issue().id, { priority: Number(e.currentTarget.value) })}>
              <For each={PRIORITIES}>
                {(label, index) => (
                  <option value={index()} selected={index() === issue().priority}>
                    {label}
                  </option>
                )}
              </For>
            </select>
          </label>
          <label>
            Blocked by
            <input
              placeholder="e.g. 3, 7"
              value={issue().blocked_by.join(', ')}
              onChange={(e) => saveBlockedBy(e.currentTarget.value)}
            />
          </label>
          <label>
            Group
            <input
              placeholder="e.g. Milestone 1"
              value={issue().grp}
              onChange={(e) => updateIssue(issue().id, { grp: e.currentTarget.value })}
            />
          </label>
          <label title="Empty = the agent's model">
            Model for this issue
            <ModelSelect
              provider={board.agents.find((agent) => agent.id === issue().assignee_id)?.provider ?? ''}
              value={issue().model ?? ''}
              emptyLabel="Agent's model"
              onChange={(model) => updateIssue(issue().id, { model })}
            />
          </label>
        </div>

        <div class="reviewers">
          <span class="muted">Reviewers, in this order:</span>
          <For each={issue().reviewers} fallback={<span class="muted">none</span>}>
            {(agentId, index) => (
              <button class="chip" title="Remove" onClick={() => removeReviewer(agentId)}>
                {index() + 1}. {board.agents.find((agent) => agent.id === agentId)?.name ?? '?'} ✕
              </button>
            )}
          </For>
          <select
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
        </div>

        <textarea
          class="description"
          placeholder="Description and acceptance criteria"
          value={issue().description ?? ''}
          onChange={(e) => updateIssue(issue().id, { description: e.currentTarget.value })}
        />

        <Show when={activeRun()}>
          {(run) => (
            <>
              <div class="run-banner">
                <span class="pulse" />
                <div>
                  <strong>{run().agent_name}</strong> is working ({providerLabel(run().provider)})
                  <p class="muted">{liveLine[issue().id] ?? 'starting…'}</p>
                </div>
                <button onClick={() => api.post(`/issues/${issue().id}/stop`).catch(fail)}>Stop</button>
              </div>
              <RunLog runId={run().id} live />
            </>
          )}
        </Show>

        <Show when={issue().handoff}>
          <section class="handoff">
            <h4>Handoff note</h4>
            <p>{issue().handoff}</p>
          </section>
        </Show>

        <h4>Activity</h4>
        <ul class="timeline">
          <For each={timeline()} fallback={<li class="muted">No activity yet.</li>}>
            {(entry) =>
              entry.comment ? <CommentItem comment={entry.comment} /> : <RunItem run={entry.run!} />
            }
          </For>
        </ul>
      </div>

      <form class="comment-form" onSubmit={sendComment}>
        <textarea
          placeholder="Comment or instruction for the agent…"
          value={comment()}
          onInput={(e) => setComment(e.currentTarget.value)}
          onKeyDown={(e) =>
            e.key === 'Enter' && (e.ctrlKey || e.metaKey) && e.currentTarget.form?.requestSubmit()
          }
        />
        <button class="primary" type="submit">
          Send
        </button>
      </form>
    </aside>
  )
}

function CommentItem(props: { comment: Comment }) {
  return (
    <li class={`comment ${props.comment.kind}`}>
      <div class="comment-head">
        <strong>{props.comment.author}</strong>
        <span class="muted">{timeAgo(props.comment.created_at)}</span>
      </div>
      <p>{props.comment.body}</p>
    </li>
  )
}

function RunItem(props: { run: Run }) {
  const run = () => props.run
  const [showsOutput, setShowsOutput] = createSignal(false)
  // What was actually new for the model: input that did not come from the cache, plus its output.
  const freshTokens = () =>
    (run().input_tokens ?? 0) - (run().cached_tokens ?? 0) + (run().output_tokens ?? 0)
  const seconds = () => Math.round(((run().ended_at ?? Date.now()) - run().started_at) / 1000)
  const label = () =>
    ({ done: 'finished', failed: 'failed', stopped: 'stopped' })[run().status ?? ''] ?? run().status

  return (
    <li class={`run-item ${run().status}`}>
      Run by {run().agent_name} {label()} · {providerLabel(run().provider)}
      {run().model ? ` (${run().model})` : ''} · {seconds()} s ·{' '}
      <span title="An agent resends its whole context on every step. This part comes from the cache and costs about a tenth.">
        {formatTokens(freshTokens())} new tokens, {formatTokens(run().cached_tokens ?? 0)} from cache
      </span>
      <Show when={run().cost_usd}> · ${run().cost_usd!.toFixed(2)}</Show>{' '}
      <button class="link" onClick={() => setShowsOutput(!showsOutput())}>
        {showsOutput() ? 'Hide output' : 'Show output'}
      </button>
      <Show when={showsOutput()}>
        <RunLog runId={run().id} />
      </Show>
    </li>
  )
}
