import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from 'solid-js'
import { api } from './api'
import { Icon } from './icons'
import { fail, showIssuePage } from './store'

type Hit = {
  id: number
  key: string
  number: number
  title: string
  status: string
  project: string
  projectKey: string
  assignee: string | null
  excerpt: string
}

/** An action offered next to the issues: "Mission Control", "New project", switch project … */
export type Command = { id: string; label: string; hint?: string; run: () => void }

type Entry = { kind: 'command'; command: Command } | { kind: 'issue'; hit: Hit } | { kind: 'create'; title: string }

/** Where a typed sentence becomes a new issue: the project's name and what to do with the title. */
export type Capture = { project: string; create: (title: string) => void }

const STATUS_LABEL: Record<string, string> = {
  backlog: 'Backlog',
  todo: 'To Do',
  in_progress: 'In progress',
  review: 'Review',
  blocked: 'Waiting',
  done: 'Done',
}

const RECENT_KEY = 'agentdeck.recentIssues'

/** Issues opened from the search, newest first, so an empty search box is not a dead end. */
function recentIssues(): Hit[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]')
  } catch {
    return []
  }
}

function remember(hit: Hit) {
  try {
    const rest = recentIssues().filter((other) => other.id !== hit.id)
    localStorage.setItem(RECENT_KEY, JSON.stringify([{ ...hit, excerpt: '' }, ...rest].slice(0, 8)))
  } catch {
    // Private windows may refuse storage; the search works without it.
  }
}

/**
 * Search over all issues of all projects, opened with Ctrl+K, "/" or the search button.
 * Results come while typing; arrows choose, Enter opens the issue as a page.
 */
export function SearchPalette(props: { onClose: () => void; commands?: Command[]; capture?: Capture }) {
  const [query, setQuery] = createSignal('')
  const [hits, setHits] = createSignal<Hit[]>(recentIssues())
  const [active, setActive] = createSignal(0)
  const [loading, setLoading] = createSignal(false)
  // True from the first key until the answer for that text is in: the list is not final before.
  const [pending, setPending] = createSignal(false)
  let input: HTMLInputElement | undefined

  // Actions match on their label, so "mission" or "pause" finds them without a prefix to learn.
  const entries = createMemo<Entry[]>(() => {
    const text = query().trim().toLowerCase()
    const commands = (props.commands ?? [])
      .filter((command) => !text || `${command.label} ${command.hint ?? ''}`.toLowerCase().includes(text))
      .slice(0, text ? 6 : 8)
      .map((command): Entry => ({ kind: 'command', command }))
    // A sentence that is not an issue number can become an issue: the fastest way to park an idea.
    const title = query().trim()
    const create: Entry[] =
      props.capture && title.length >= 3 && !/^[A-Za-z][A-Za-z0-9]+-\d+$/.test(title)
        ? [{ kind: 'create', title }]
        : []
    return [...commands, ...hits().map((hit): Entry => ({ kind: 'issue', hit })), ...create]
  })
  let list: HTMLUListElement | undefined

  // Typing quickly sends one request for what was typed last, not one per key.
  let timer: number | undefined
  let latest = 0
  createEffect(
    on(query, (text) => {
      clearTimeout(timer)
      setPending(!!text.trim())
      if (!text.trim()) {
        setHits(recentIssues())
        setActive(0)
        return
      }
      timer = window.setTimeout(async () => {
        const asked = ++latest
        setLoading(true)
        try {
          const found = await api.get<Hit[]>(`/search?q=${encodeURIComponent(text)}`)
          if (asked !== latest) return
          setHits(found)
          setActive(0)
          setPending(false)
        } catch (err) {
          fail(err)
        } finally {
          if (asked === latest) setLoading(false)
        }
      }, 150)
    }),
  )
  onCleanup(() => clearTimeout(timer))

  function open(entry: Entry | undefined) {
    if (!entry) return
    props.onClose()
    if (entry.kind === 'command') return entry.command.run()
    if (entry.kind === 'create') return props.capture?.create(entry.title)
    remember(entry.hit)
    showIssuePage(entry.hit.projectKey, entry.hit.number)
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault()
      props.onClose()
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const count = entries().length
      if (!count) return
      setActive((index) => (index + (e.key === 'ArrowDown' ? 1 : count - 1)) % count)
      list?.children[active()]?.scrollIntoView({ block: 'nearest' })
    } else if (e.key === 'Enter') {
      e.preventDefault()
      // Before the search has answered, the list is not final: Enter must not create an issue from half a sentence.
      if (pending() && entries()[active()]?.kind === 'create') return
      open(entries()[active()])
    }
  }

  onMount(() => input?.focus())

  return (
    <div class="overlay palette-overlay" onClick={(e) => e.target === e.currentTarget && props.onClose()}>
      <div class="palette" role="dialog" aria-modal="true" aria-label="Search and actions">
        <div class="palette-input">
          <Icon name="search" size={18} />
          <input
            ref={input}
            role="combobox"
            aria-expanded={entries().length > 0}
            aria-controls="palette-results"
            aria-activedescendant={entries().length ? `palette-hit-${active()}` : undefined}
            placeholder="Search issues: ABC-439, title or text from the description"
            value={query()}
            onInput={(e) => setQuery(e.currentTarget.value)}
            onKeyDown={onKey}
          />
          <Show when={loading()}>
            <span class="muted palette-loading">searching…</span>
          </Show>
          <kbd>Esc</kbd>
        </div>

        <ul class="palette-results" id="palette-results" role="listbox" ref={list}>
          <For each={entries()}>
            {(entry, index) => (
              <li
                id={`palette-hit-${index()}`}
                role="option"
                aria-selected={index() === active()}
                classList={{ active: index() === active(), command: entry.kind !== 'issue' }}
                onMouseMove={() => setActive(index())}
                onClick={() => open(entry)}
              >
                {entry.kind === 'create' ? (
                  <>
                    <span class="palette-action" aria-hidden="true">
                      <Icon name="plus" size={13} />
                    </span>
                    <span class="palette-title">Create issue: {entry.title}</span>
                    <span class="muted palette-meta">in {props.capture?.project}</span>
                  </>
                ) : entry.kind === 'command' ? (
                  <>
                    <span class="palette-action" aria-hidden="true">
                      <Icon name="bolt" size={13} />
                    </span>
                    <span class="palette-title">{entry.command.label}</span>
                    <span class="muted palette-meta">{entry.command.hint ?? 'Action'}</span>
                  </>
                ) : (
                  <>
                    <span class={`status-dot ${entry.hit.status}`} />
                    <span class="mono palette-key">{entry.hit.key}</span>
                    <span class="palette-title">
                      {entry.hit.title}
                      <Show when={entry.hit.excerpt}>
                        <small class="muted">{entry.hit.excerpt}</small>
                      </Show>
                    </span>
                    <span class="muted palette-meta">
                      {STATUS_LABEL[entry.hit.status] ?? entry.hit.status}
                      {entry.hit.assignee ? ` · ${entry.hit.assignee}` : ''}
                    </span>
                  </>
                )}
              </li>
            )}
          </For>
        </ul>

        <Show when={query().trim() && !loading() && !entries().length}>
          <div class="palette-empty">
            <p>Nothing found for “{query().trim()}”.</p>
            <p class="muted">
              Try an issue number like ABC-439, a single word from the title, or fewer words. The search
              covers all projects, in title and description.
            </p>
          </div>
        </Show>

        <footer class="palette-help muted">
          <span>
            <kbd>↑</kbd> <kbd>↓</kbd> select
          </span>
          <span>
            <kbd>Enter</kbd> open
          </span>
          <span>
            <kbd>Ctrl</kbd> <kbd>K</kbd> anywhere
          </span>
        </footer>
      </div>
    </div>
  )
}
