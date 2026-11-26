import { createResource, createSignal, For, onCleanup, Show } from 'solid-js'
import { api } from './api'
import { t } from './i18n'
import { board, fail, openIssue } from './store'
import type { ArenaEntry, ArenaView, Issue } from './types'
import { Modal } from './ui'

const MIN_ENTRIES = 2
const MAX_ENTRIES = 4
const REFRESH_MS = 4000

const STATE_LABEL: Record<ArenaEntry['state'], string> = {
  working: 'arbeitet',
  'handed-in': 'abgegeben',
  out: 'ausgeschieden',
  winner: 'Gewinner',
  lost: 'nicht gewählt',
}

const PHASE_TEXT: Record<ArenaView['phase'], string> = {
  waiting: 'Die Beiträge sind in Arbeit. Sobald keiner mehr arbeitet, entscheidet die Jury.',
  judge: 'Alle Beiträge sind abgegeben. Die Jury vergleicht sie, ohne zu wissen, von wem sie stammen.',
  empty: 'Kein Beitrag wurde abgegeben.',
  closed: 'Entschieden. Nur der Gewinner geht in Prüfung und Landung.',
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
                  {t('Beitrag zu {ref}', { ref: `${board.project?.key}-${view().parent.number}` })}
                </button>
              </Show>
            </div>
            <p class="muted">{view().winnerId < 0 ? t('Ohne Ergebnis beendet.') : t(PHASE_TEXT[view().phase])}</p>
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
                    <span class="arena-state">{t(STATE_LABEL[entry.state])}</span>
                    <span class="muted arena-spent">
                      {entry.minutes} min · {entry.costUsd.toFixed(2)} $
                    </span>
                    <Show when={view().phase === 'judge' && entry.state === 'handed-in'}>
                      <button
                        class="ghost"
                        title={t('Entscheidet die Arena selbst, statt auf die Jury zu warten')}
                        onClick={() => pick(entry)}
                      >
                        {t('Diesen wählen')}
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
              {t('Arena starten')}
            </button>
          </div>
          <p class="muted">
            {t('Mehrere Agenten lösen dieses Issue parallel, jeder auf eigenem Branch. Eine Jury wählt das beste Ergebnis; nur das geht in Prüfung und Landung.')}
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
    <Modal title={t('Arena starten')} onClose={props.onClose}>
      <div class="form">
        <p class="muted">
          {t('Wähle {min} bis {max} Agenten. Jeder bekommt dieselbe Aufgabe und arbeitet für sich. Die Kosten fallen pro Beitrag an.', { min: MIN_ENTRIES, max: MAX_ENTRIES })}
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
            {t('Abbrechen')}
          </button>
          <button class="primary" disabled={!valid()} onClick={start}>
            {valid() ? t('{n} Agenten starten', { n: chosen().length }) : t('Agenten wählen')}
          </button>
        </footer>
      </div>
    </Modal>
  )
}
