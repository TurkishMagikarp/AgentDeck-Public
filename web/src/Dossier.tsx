import { createMemo, createResource, createSignal, For, Show } from 'solid-js'
import { api } from './api'
import { Icon } from './icons'
import { t, locale } from './i18n'

type Tool = { name: string; count: number }
type Run = {
  id: number
  agent: string
  provider: string
  model: string
  status: string
  failure: string
  startedAt: number
  endedAt: number | null
  costUsd: number
  tokens: number
  events: number
  tools: Tool[]
  commands: string[]
  files: string[]
  fetches: string[]
  errors: string[]
  redactions: number
  changes: string
}
type Step = { key: string; at: number; actor: string; kind: string; text: string }
type Data = {
  totals: { runs: number; costUsd: number; tokens: number; seconds: number; toolCalls: number; files: number; commands: number }
  flags: { level: 'bad' | 'warn'; text: string }[]
  runs: Run[]
  steps: Step[]
}

const storeKey = (issueId: number) => `agentdeck.seen.${issueId}`
const loadSeen = (issueId: number): Set<string> => {
  try {
    return new Set(JSON.parse(localStorage.getItem(storeKey(issueId)) ?? '[]'))
  } catch {
    return new Set()
  }
}
const time = (at: number) => new Date(at).toLocaleString(locale(), { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
const dur = (s: number) => (s < 90 ? `${s} s` : `${Math.round(s / 60)} min`)

/**
 * Everything the agents did for one issue, on one page, for the review before a merge. Each line
 * can be marked as seen; the counter says how much of it you have not looked at yet.
 */
export function Dossier(props: { issueId: number; version: number }) {
  const [open, setOpen] = createSignal(false)
  const [data, { refetch }] = createResource(
    () => (open() ? { id: props.issueId, v: props.version } : false),
    ({ id }) => api.get<Data>(`/issues/${id}/dossier`),
  )
  const [seen, setSeen] = createSignal(loadSeen(props.issueId))
  const [openRuns, setOpenRuns] = createSignal(new Set<number>())

  const keys = createMemo(() => [
    ...(data()?.runs.map((r) => `run:${r.id}`) ?? []),
    ...(data()?.steps.map((s) => s.key) ?? []),
  ])
  const unseen = createMemo(() => new Set(keys().filter((k) => !seen().has(k))).size)
  const persist = (next: Set<string>) => {
    setSeen(next)
    localStorage.setItem(storeKey(props.issueId), JSON.stringify([...next]))
  }
  const mark = (key: string) => persist(new Set(seen()).add(key))
  const markAll = () => persist(new Set([...seen(), ...keys()]))
  const toggleRun = (id: number) => {
    const next = new Set(openRuns())
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setOpenRuns(next)
    mark(`run:${id}`)
  }

  return (
    <section class="issue-section dossier">
      <div class="section-head">
        <button class="ghost" aria-expanded={open()} onClick={() => setOpen(!open())}>
          <Icon name={open() ? 'chevronDown' : 'chevronRight'} size={14} />
          {t('Prüfbericht vor dem Merge')}
        </button>
        <Show when={open() && data()}>
          <span class="seen-meter" classList={{ done: unseen() === 0 }} role="status">
            {unseen() === 0 ? t('Alles gesehen') : t('{n} noch nicht gesehen', { n: unseen() })}
          </span>
        </Show>
      </div>
      <Show when={open()}>
        <Show when={data()} fallback={<p class="muted">{data.error ? String(data.error.message) : t('Lade Bericht…')}</p>}>
          {(d) => (
            <>
              <dl class="dossier-totals">
                <div><dt>{t('Läufe')}</dt><dd>{d().totals.runs}</dd></div>
                <div><dt>{t('Werkzeugaufrufe')}</dt><dd>{d().totals.toolCalls}</dd></div>
                <div><dt>{t('Dateien geschrieben')}</dt><dd>{d().totals.files}</dd></div>
                <div><dt>{t('Shell-Befehle')}</dt><dd>{d().totals.commands}</dd></div>
                <div><dt>{t('Dauer')}</dt><dd>{dur(d().totals.seconds)}</dd></div>
                <div><dt>{t('Kosten')}</dt><dd>${d().totals.costUsd.toFixed(2)}</dd></div>
              </dl>
              <Show when={d().flags.length}>
                <ul class="dossier-flags">
                  <For each={d().flags}>{(f) => <li class={f.level}>{f.text}</li>}</For>
                </ul>
              </Show>
              <div class="dossier-actions">
                <button class="link" onClick={markAll} disabled={unseen() === 0}>{t('Alles als gesehen markieren')}</button>
                <button class="link" onClick={() => refetch()}>{t('Aktualisieren')}</button>
              </div>

              <h4>{t('Läufe')}</h4>
              <ul class="dossier-runs">
                <For each={d().runs} fallback={<li class="muted">{t('Noch kein Lauf.')}</li>}>
                  {(run) => (
                    <li classList={{ unseen: !seen().has(`run:${run.id}`) }}>
                      <button class="dossier-run-head" aria-expanded={openRuns().has(run.id)} onClick={() => toggleRun(run.id)}>
                        <Icon name={openRuns().has(run.id) ? 'chevronDown' : 'chevronRight'} size={13} />
                        <strong>{run.agent}</strong>
                        <span class="muted">{run.model || run.provider}</span>
                        <span class={`run-state ${run.status}`}>{run.status}</span>
                        <span class="muted">{t('{calls} Aufrufe · {files} Dateien', { calls: run.tools.reduce((n, tool) => n + tool.count, 0), files: run.files.length })}</span>
                      </button>
                      <Show when={openRuns().has(run.id)}>
                        <div class="dossier-run-body">
                          <Show when={run.tools.length}>
                            <p class="tool-chips">
                              <For each={run.tools}>{(tool) => <span class="chip">{tool.name} {tool.count}</span>}</For>
                            </p>
                          </Show>
                          <Show when={run.changes}>
                            <h5>{t('Git-Änderungen dieses Laufs')}</h5>
                            <pre class="mono-list">{run.changes}</pre>
                          </Show>
                          <Show when={run.files.length}>
                            <h5>{t('Geschriebene Dateien')}</h5>
                            <ul class="mono-list"><For each={run.files}>{(f) => <li>{f}</li>}</For></ul>
                          </Show>
                          <Show when={run.commands.length}>
                            <h5>{t('Shell-Befehle')}</h5>
                            <ul class="mono-list"><For each={run.commands}>{(c) => <li>{c}</li>}</For></ul>
                          </Show>
                          <Show when={run.fetches.length}>
                            <h5>{t('Netzabrufe')}</h5>
                            <ul class="mono-list"><For each={run.fetches}>{(c) => <li>{c}</li>}</For></ul>
                          </Show>
                          <Show when={run.errors.length}>
                            <h5>{t('Fehler')}</h5>
                            <ul class="mono-list bad"><For each={run.errors}>{(c) => <li>{c}</li>}</For></ul>
                          </Show>
                          <Show when={!run.events}><p class="muted">{t('Keine Aufzeichnung für diesen Lauf.')}</p></Show>
                        </div>
                      </Show>
                    </li>
                  )}
                </For>
              </ul>

              <Show when={d().steps.some((s) => s.kind.startsWith('landing-'))}>
                <h4>{t('Landung: was der Server beim Merge getan hat')}</h4>
                <ol class="landing-trace">
                  <For each={d().steps.filter((s) => s.kind.startsWith('landing-'))}>
                    {(s) => (
                      <li class={s.kind} classList={{ unseen: !seen().has(s.key) }}>
                        <time>{time(s.at)}</time>
                        <span class="landing-text">{s.text}</span>
                        <Show when={!seen().has(s.key)}>
                          <button class="ghost icon-button" title={t('Als gesehen markieren')} aria-label={t('Als gesehen markieren')} onClick={() => mark(s.key)}>
                            <Icon name="close" size={12} />
                          </button>
                        </Show>
                      </li>
                    )}
                  </For>
                </ol>
              </Show>

              <h4>{t('Ablauf')}</h4>
              <ol class="dossier-steps">
                <For each={d().steps}>
                  {(s) => (
                    <li classList={{ unseen: !seen().has(s.key) }}>
                      <time>{time(s.at)}</time>
                      <strong>{s.actor}</strong>
                      <span class="step-text">{s.text}</span>
                      <Show when={!seen().has(s.key)}>
                        <button class="ghost icon-button" title={t('Als gesehen markieren')} aria-label={t('Als gesehen markieren')} onClick={() => mark(s.key)}>
                          <Icon name="close" size={12} />
                        </button>
                      </Show>
                    </li>
                  )}
                </For>
              </ol>
            </>
          )}
        </Show>
      </Show>
    </section>
  )
}
