import { createMemo, createResource, createSignal, For, Show } from 'solid-js'
import { api } from './api'
import { t, locale } from './i18n'

type Kind = 'prompt' | 'assistant' | 'tool_call' | 'tool_result' | 'error' | 'changes' | 'end'
type Step = { seq: number; at: number; kind: Kind; name: string; payload: string; size: number }
type Replay = { run: { id: number; started_at: number; ended_at: number | null; status: string }; events: Step[] }

const KINDS: [Kind, string][] = [
  ['prompt', 'Auftrag'],
  ['assistant', 'Antworten'],
  ['tool_call', 'Werkzeuge'],
  ['tool_result', 'Ergebnisse'],
  ['error', 'Fehler'],
  ['changes', 'Änderungen'],
  ['end', 'Ende'],
]
const LABEL = Object.fromEntries(KINDS) as Record<Kind, string>

/** "+1:05" from the start of the run; hours only when the run took that long. */
function offset(ms: number) {
  const total = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = String(total % 60).padStart(2, '0')
  return h ? `+${h}:${String(m).padStart(2, '0')}:${s}` : `+${m}:${s}`
}

const oneLine = (text: string, max = 140) => {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/**
 * The replay of one run as a list of steps: what it was asked, which tools it called, what came
 * back, what it said and what it changed. Payloads open on a click; the filter shows one kind.
 */
export function RunReplay(props: { runId: number }) {
  const [data, { refetch }] = createResource(
    () => props.runId,
    (runId) => api.get<Replay>(`/runs/${runId}/events`),
  )
  const [shown, setShown] = createSignal<Set<Kind>>(new Set(KINDS.map(([kind]) => kind)))
  const [open, setOpen] = createSignal<Set<number>>(new Set())

  const counts = createMemo(() => {
    const byKind: Partial<Record<Kind, number>> = {}
    for (const step of data()?.events ?? []) byKind[step.kind] = (byKind[step.kind] ?? 0) + 1
    return byKind
  })
  const steps = createMemo(() => (data()?.events ?? []).filter((step) => shown().has(step.kind)))

  const toggleKind = (kind: Kind) => {
    const next = new Set(shown())
    if (next.has(kind)) next.delete(kind)
    else next.add(kind)
    setShown(next)
  }
  const toggleStep = (seq: number) => {
    const next = new Set(open())
    if (next.has(seq)) next.delete(seq)
    else next.add(seq)
    setOpen(next)
  }

  return (
    <div class="replay">
      <Show when={!data.loading || data()} fallback={<p class="muted">{t('Lade Verlauf…')}</p>}>
        <Show when={!data.error} fallback={<p class="muted">{t('Verlauf nicht ladbar: {error}', { error: String(data.error?.message ?? '') })}</p>}>
          <div class="replay-filter" role="group" aria-label={t('Schritte filtern')}>
            <For each={KINDS.filter(([kind]) => counts()[kind])}>
              {([kind, label]) => (
                <button
                  class={`chip replay-${kind}`}
                  classList={{ active: shown().has(kind) }}
                  aria-pressed={shown().has(kind)}
                  onClick={() => toggleKind(kind)}
                >
                  {t(label)} {counts()[kind]}
                </button>
              )}
            </For>
            <button class="link" onClick={() => refetch()}>
              {t('Aktualisieren')}
            </button>
          </div>
          <ol class="replay-steps">
            <For
              each={steps()}
              fallback={
                <li class="muted">
                  {data()?.events.length ? t('Kein Schritt dieser Art.') : t('Für diesen Lauf gibt es keine Aufzeichnung.')}
                </li>
              }
            >
              {(step) => (
                <li class={`replay-step replay-${step.kind}`}>
                  <button
                    class="replay-head"
                    aria-expanded={open().has(step.seq)}
                    onClick={() => toggleStep(step.seq)}
                  >
                    <time title={new Date(step.at).toLocaleString(locale())}>
                      {offset(step.at - (data()?.run.started_at ?? step.at))}
                    </time>
                    <span class="replay-kind">{LABEL[step.kind] ? t(LABEL[step.kind]) : step.kind}</span>
                    <Show when={step.name}>
                      <code>{step.name}</code>
                    </Show>
                    <span class="replay-summary">{oneLine(step.payload)}</span>
                  </button>
                  <Show when={open().has(step.seq)}>
                    <pre class="replay-payload">{step.payload}</pre>
                    <Show when={step.size > step.payload.length}>
                      <p class="muted">
                        {t('Gekürzt: {shown} von {total} Zeichen gespeichert.', {
                          shown: step.payload.length.toLocaleString(locale()),
                          total: step.size.toLocaleString(locale()),
                        })}
                      </p>
                    </Show>
                  </Show>
                </li>
              )}
            </For>
          </ol>
        </Show>
      </Show>
    </div>
  )
}
