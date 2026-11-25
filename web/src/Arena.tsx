import { createResource, createSignal, For, onCleanup, Show } from 'solid-js'
import { api } from './api'
import { board, fail, openIssue } from './store'
import type { ArenaEntry, ArenaView, Issue } from './types'
import { Modal } from './ui'

const MIN_ENTRIES = 2
const MAX_ENTRIES = 4
const REFRESH_MS = 4000

const STATE_LABEL: Record<ArenaEntry['state'], string> = {
  working: 'working',
  'handed-in': 'handed in',
  out: 'dropped out',
  winner: 'winner',
  lost: 'not picked',
}

const PHASE_TEXT: Record<ArenaView['phase'], string> = {
  waiting: 'The entries are in progress. Once none is still at work, the jury decides.',
  judge: 'All entries are handed in. The jury compares them without knowing who wrote them.',
  empty: 'No entry was handed in.',
  closed: 'Decided. Only the winner goes on to review and landing.',
}

/**
 * The arena of an issue: several agents solve it side by side and a jury picks one result. Shown on
 * the original and on every entry; an issue without an arena offers to start one.
 */
export function Arena(props: { issue: Issue; version: number }) {
  const [arena, { refetch }] = createResource(
    () => [props.issue.id, props.version] as const,
    ([id]) => api.get<ArenaView | null>(`/issues/${id}/arena`),
  )
  // The entries are other issues: their progress does not reach this page as events of its own.
  const timer = setInterval(() => {
    const current = arena()
    if (current && current.phase !== 'closed') refetch()
  }, REFRESH_MS)
  onCleanup(() => clearInterval(timer))

  const [choosing, setChoosing] = createSignal(false)
  const canStart = () =>
    !arena() &&
    !props.issue.arena_of &&
    ['backlog', 'todo'].includes(props.issue.status) &&
    agents().length >= 2
  const agents = () => board.agents.filter((agent) => agent.enabled)
  const isParent = () => arena()?.parent.id === props.issue.id

  const pick = (entry: ArenaEntry) =>
    api.post(`/issues/${arena()!.parent.id}/arena/pick`, { entry: entry.id }).then(refetch).catch(fail)

  return (
    <>
      <Show when={arena()}>
        {(view) => (
          <section class="issue-section arena">
            <div class="issue-section-head">
              <h3>Arena</h3>
              <Show when={!isParent()}>
                <button class="link" onClick={() => openIssue(view().parent.id).catch(fail)}>
                  Entry for {board.project?.key}-{view().parent.number}
                </button>
              </Show>
            </div>
            <p class="muted">{view().winnerId < 0 ? 'Ended without a result.' : PHASE_TEXT[view().phase]}</p>
            <ul class="arena-entries">
              <For each={view().entries}>
                {(entry) => (
                  <li class="arena-entry" data-state={entry.state}>
                    <button class="link-open" onClick={() => openIssue(entry.id).catch(fail)}>
                      <strong>{entry.agent}</strong>
                      <span class="muted">
                        {board.project?.key}-{entry.number}
                      </span>
                    </button>
                    <span class="arena-state">{STATE_LABEL[entry.state]}</span>
                    <span class="muted arena-spent">
                      {entry.minutes} min · {entry.costUsd.toFixed(2)} $
                    </span>
                    <Show when={view().phase === 'judge' && entry.state === 'handed-in'}>
                      <button
                        class="ghost"
                        title="Decides the arena yourself instead of waiting for the jury"
                        onClick={() => pick(entry)}
                      >
                        Pick this one
                      </button>
                    </Show>
                  </li>
                )}
              </For>
            </ul>
          </section>
        )}
      </Show>

      <Show when={canStart()}>
        <section class="issue-section arena">
          <div class="issue-section-head">
            <h3>Arena</h3>
            <button class="ghost" onClick={() => setChoosing(true)}>
              Start arena
            </button>
          </div>
          <p class="muted">
            Several agents solve this issue in parallel, each on its own branch. A jury picks the best
            result; only that one goes on to review and landing.
          </p>
        </section>
      </Show>

      <Show when={choosing()}>
        <StartArena
          issueId={props.issue.id}
          onClose={() => setChoosing(false)}
          onStarted={() => {
            setChoosing(false)
            refetch()
          }}
        />
      </Show>
    </>
  )
}

function StartArena(props: { issueId: number; onClose: () => void; onStarted: () => void }) {
  const agents = () => board.agents.filter((agent) => agent.enabled)
  const [chosen, setChosen] = createSignal<number[]>([])
  const toggle = (id: number) =>
    setChosen((list) => (list.includes(id) ? list.filter((other) => other !== id) : [...list, id]))
  const valid = () => chosen().length >= MIN_ENTRIES && chosen().length <= MAX_ENTRIES

  const start = () =>
    api.post(`/issues/${props.issueId}/arena`, { agents: chosen() }).then(props.onStarted).catch(fail)

  return (
    <Modal title="Start arena" onClose={props.onClose}>
      <div class="form">
        <p class="muted">
          Pick {MIN_ENTRIES} to {MAX_ENTRIES} agents. Each gets the same task and works on its own.
          Costs accrue per entry.
        </p>
        <div class="arena-choice">
          <For each={agents()}>
            {(agent) => (
              <label>
                <input
                  type="checkbox"
                  checked={chosen().includes(agent.id)}
                  onChange={() => toggle(agent.id)}
                />
                <span>
                  <strong>{agent.name}</strong> <span class="muted">{agent.role}</span>
                </span>
              </label>
            )}
          </For>
        </div>
        <footer>
          <button class="ghost" onClick={props.onClose}>
            Cancel
          </button>
          <button class="primary" disabled={!valid()} onClick={start}>
            {valid() ? `Start ${chosen().length} agents` : 'Pick agents'}
          </button>
        </footer>
      </div>
    </Modal>
  )
}
