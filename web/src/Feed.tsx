import { createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import { api } from './api'
import { Icon } from './icons'
import { t, locale } from './i18n'
import { board, issueLink } from './store'

type Item = {
  runId: number
  seq: number
  at: number
  kind: string
  name: string
  text: string
  agent: string
  issue: number
  title: string
}

const LABEL: Record<string, string> = {
  assistant: 'Sagt',
  tool_call: 'Ruft auf',
  tool_result: 'Ergebnis',
  error: 'Fehler',
  changes: 'Änderung',
  server: 'Server',
  network: 'Netz blockiert',
  landing: 'Landung',
  end: 'Ende',
}
const clock = (at: number) => new Date(at).toLocaleTimeString(locale())
const id = (i: Item) => `${i.kind}:${i.runId}:${i.seq}:${i.at}`

/**
 * Everything every agent of the project does, as it happens: one stream, newest on top. Filter by
 * agent or kind, pause to read. Polls every two seconds and only fetches what is new.
 */
export function Feed() {
  const [items, setItems] = createSignal<Item[]>([])
  const [paused, setPaused] = createSignal(false)
  const [agent, setAgent] = createSignal('')
  const [hidden, setHidden] = createSignal(new Set<string>(['tool_result']))
  const [error, setError] = createSignal('')
  let latest = 0

  async function poll() {
    if (paused()) return
    try {
      const fresh = await api.get<Item[]>(`/projects/${board.project!.id}/feed?since=${latest}&limit=${latest ? 300 : 150}`)
      setError('')
      if (!fresh.length) return
      latest = Math.max(latest, ...fresh.map((i) => i.at))
      const known = new Set(items().map(id))
      setItems([...fresh.filter((i) => !known.has(id(i))), ...items()].slice(0, 600))
    } catch (e) {
      setError(String((e as Error).message))
    }
  }
  onMount(() => {
    poll()
    const timer = setInterval(poll, 2000)
    onCleanup(() => clearInterval(timer))
  })

  const agents = createMemo(() => [...new Set(items().map((i) => i.agent))].sort())
  const shown = createMemo(() =>
    items().filter((i) => !hidden().has(i.kind) && (!agent() || i.agent === agent())),
  )
  const toggle = (kind: string) => {
    const next = new Set(hidden())
    if (next.has(kind)) next.delete(kind)
    else next.add(kind)
    setHidden(next)
  }

  return (
    <div class="page narrow feed">
      <div class="page-head">
        <div>
          <h2>{t('Live-Feed')}</h2>
          <p class="muted">{t('Jeder Schritt jedes Agenten, sobald er passiert.')}</p>
        </div>
        <button onClick={() => setPaused(!paused())} aria-pressed={paused()}>
          <Icon name={paused() ? 'play' : 'pause'} size={14} /> {paused() ? t('Fortsetzen') : t('Pausieren')}
        </button>
      </div>
      <div class="feed-filter" role="group" aria-label={t('Filter')}>
        <select aria-label={t('Agent')} value={agent()} onChange={(e) => setAgent(e.currentTarget.value)}>
          <option value="">{t('Alle Agenten')}</option>
          <For each={agents()}>{(a) => <option value={a}>{a}</option>}</For>
        </select>
        <For each={Object.entries(LABEL)}>
          {([kind, label]) => (
            <button class="chip" classList={{ active: !hidden().has(kind) }} aria-pressed={!hidden().has(kind)} onClick={() => toggle(kind)}>
              {t(label)}
            </button>
          )}
        </For>
        <Show when={paused()}><span class="seen-meter">{t('pausiert')}</span></Show>
      </div>
      <Show when={error()}><p class="muted" role="alert">{t('Feed nicht ladbar: {error}', { error: error() })}</p></Show>
      <ol class="feed-list" aria-live="off">
        <For each={shown()} fallback={<li class="muted">{t('Noch keine Aktivität.')}</li>}>
          {(i) => (
            <li class={`feed-item feed-${i.kind}`} classList={{ [`level-${i.name.split(' ').at(-1)}`]: i.kind === 'landing' }}>
              <time>{clock(i.at)}</time>
              <strong class="feed-agent">{i.agent}</strong>
              <Show when={i.issue} fallback={<span />}>
                <a class="issue-key" href={issueLink(board.project!.key, i.issue)} title={i.title}>
                  {board.project!.key}-{i.issue}
                </a>
              </Show>
              <span class="feed-kind">{LABEL[i.kind] ? t(LABEL[i.kind]) : i.kind}{i.name ? ` · ${i.name.replace(/ (info|ok|warn|bad)$/, '')}` : ''}</span>
              <span class="feed-text">{i.text}</span>
            </li>
          )}
        </For>
      </ol>
    </div>
  )
}
