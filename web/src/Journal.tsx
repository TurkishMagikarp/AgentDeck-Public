import { For, Show, createMemo, createSignal, onCleanup, onMount } from 'solid-js'
import { api } from './api'
import { board, issueLink } from './store'
import { Icon } from './icons'
import { t, locale } from './i18n'
import type { JournalEntry, JournalKind } from './types'

/** Label and tone of each kind of line. The tone colours the badge: good, bad, info or wait. */
const KINDS: Record<JournalKind, { label: string; tone: 'good' | 'bad' | 'info' | 'wait' }> = {
  landed: { label: 'Gelandet', tone: 'good' },
  approved: { label: 'Freigegeben', tone: 'good' },
  landingRed: { label: 'Landung rot', tone: 'bad' },
  precheckRed: { label: 'Vorcheck rot', tone: 'bad' },
  runFailed: { label: 'Lauf fehlgeschlagen', tone: 'bad' },
  changes: { label: 'Änderungen', tone: 'info' },
  partial: { label: 'Teilabgabe', tone: 'info' },
  waits: { label: 'Wartet', tone: 'wait' },
  escalated: { label: 'Eskaliert', tone: 'wait' },
  watchdog: { label: 'Watchdog', tone: 'wait' },
}

/** The server's page size (server/journal.ts). */
const PAGE_SIZE = 200
const DAY_MS = 86_400_000
const startOfDay = (at: number) => new Date(at).setHours(0, 0, 0, 0)
/** "Heute" and "Gestern" read faster than a date; older days keep weekday and date. */
const day = (at: number) => {
  const ago = Math.round((startOfDay(Date.now()) - startOfDay(at)) / DAY_MS)
  if (ago === 0) return t('Heute')
  if (ago === 1) return t('Gestern')
  return new Date(at).toLocaleDateString(locale(), { weekday: 'short', day: '2-digit', month: '2-digit' })
}
const time = (at: number) => new Date(at).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' })

/**
 * What happened in the project, one short line per event, newest first: landings, red checks,
 * approvals, change requests, waits, escalations and failed runs. To follow up on a day later.
 */
export function Journal() {
  const [entries, setEntries] = createSignal<JournalEntry[]>([])
  const [hidden, setHidden] = createSignal(new Set<JournalKind>())
  const [more, setMore] = createSignal(true)
  const [query, setQuery] = createSignal('')
  const path = () => `/projects/${board.project!.id}/journal`

  async function refresh() {
    const fresh = await api.get<JournalEntry[]>(path())
    // A short first page is all there is; the button for older entries would only find nothing.
    if (fresh.length < PAGE_SIZE) setMore(false)
    // Keep older pages that were loaded already; the fresh page replaces the newest part.
    const oldest = fresh.at(-1)?.at ?? 0
    setEntries([...fresh, ...entries().filter((e) => e.at < oldest)])
  }
  async function loadOlder() {
    const last = entries().at(-1)
    if (!last) return
    const older = await api.get<JournalEntry[]>(`${path()}?before=${last.at}`)
    if (!older.length) setMore(false)
    setEntries([...entries(), ...older])
  }

  onMount(() => {
    refresh().catch(() => {})
    const timer = setInterval(() => refresh().catch(() => {}), 30_000)
    onCleanup(() => clearInterval(timer))
  })

  // The search looks at the line, the issue title and the issue number ("SHOP-4" or just "4").
  const matches = (entry: JournalEntry) => {
    const text = query().trim().toLowerCase()
    if (!text) return true
    return `${entry.text} ${entry.title} ${board.project!.key}-${entry.issue}`.toLowerCase().includes(text)
  }
  const shown = createMemo(() => entries().filter((e) => !hidden().has(e.kind) && matches(e)))
  const onlyProblems = () => Object.entries(KINDS).every(([kind, info]) => (info.tone === 'bad') !== hidden().has(kind as JournalKind))
  function showOnlyProblems() {
    // Pressing it again brings everything back.
    setHidden(
      onlyProblems()
        ? new Set<JournalKind>()
        : new Set(Object.entries(KINDS).filter(([, info]) => info.tone !== 'bad').map(([kind]) => kind as JournalKind)),
    )
  }
  const days = createMemo(() => {
    const groups: [string, JournalEntry[]][] = []
    for (const entry of shown()) {
      const label = day(entry.at)
      if (groups.at(-1)?.[0] !== label) groups.push([label, []])
      groups.at(-1)![1].push(entry)
    }
    return groups
  })
  const counts = createMemo(() => {
    const byKind = new Map<JournalKind, number>()
    for (const entry of entries()) byKind.set(entry.kind, (byKind.get(entry.kind) ?? 0) + 1)
    return byKind
  })
  function toggle(kind: JournalKind) {
    const next = new Set(hidden())
    if (next.has(kind)) next.delete(kind)
    else next.add(kind)
    setHidden(next)
  }

  return (
    <div class="page narrow journal">
      <div class="page-head">
        <div>
          <h2>Journal</h2>
          <p class="muted">{t('Was passiert ist, eine Zeile pro Ereignis, das Neueste oben.')}</p>
        </div>
        <button onClick={() => refresh().catch(() => {})} title={t('Neu laden')}>
          <Icon name="refresh" size={14} /> {t('Aktualisieren')}
        </button>
      </div>

      <div class="journal-search">
        <Icon name="search" size={14} />
        <input
          type="search"
          aria-label={t('Journal durchsuchen')}
          placeholder={t('Journal durchsuchen: Text, Titel oder Issue-Nummer')}
          value={query()}
          onInput={(e) => setQuery(e.currentTarget.value)}
        />
        <button classList={{ primary: onlyProblems() }} onClick={showOnlyProblems} title={t('Nur rote Ereignisse zeigen')}>
          {t('Nur Probleme')}
        </button>
      </div>

      <div class="journal-filter">
        <For each={Object.entries(KINDS) as [JournalKind, (typeof KINDS)[JournalKind]][]}>
          {([kind, info]) => (
            <Show when={counts().get(kind)}>
              <button
                class={`journal-chip ${info.tone}`}
                classList={{ off: hidden().has(kind) }}
                onClick={() => toggle(kind)}
                title={hidden().has(kind) ? t('Einblenden') : t('Ausblenden')}
              >
                {t(info.label)} <strong>{counts().get(kind)}</strong>
              </button>
            </Show>
          )}
        </For>
      </div>

      <For each={days()} fallback={<p class="muted">{query().trim() ? t('Nichts gefunden für „{query}“.', { query: query().trim() }) : t('Noch nichts passiert.')}</p>}>
        {([label, list]) => (
          <section class="journal-day">
            <h3>{label}</h3>
            <ul>
              <For each={list}>
                {(entry) => (
                  <li class="journal-line">
                    <time>{time(entry.at)}</time>
                    <span class={`journal-kind ${KINDS[entry.kind].tone}`}>{t(KINDS[entry.kind].label)}</span>
                    <a class="issue-key" href={issueLink(board.project!.key, entry.issue)} title={entry.title}>
                      {board.project!.key}-{entry.issue}
                    </a>
                    <span class="journal-text" title={`${entry.title}\n${entry.text}`}>
                      {entry.text}
                    </span>
                  </li>
                )}
              </For>
            </ul>
          </section>
        )}
      </For>

      <Show when={entries().length && more()}>
        <button class="journal-more" onClick={() => loadOlder().catch(() => {})}>
          {t('Ältere laden')}
        </button>
      </Show>
    </div>
  )
}
