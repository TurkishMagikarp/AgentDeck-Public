import { createEffect, createSignal, For, on, onCleanup, onMount, Show } from 'solid-js'
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
export function SearchPalette(props: { onClose: () => void }) {
  const [query, setQuery] = createSignal('')
  const [hits, setHits] = createSignal<Hit[]>(recentIssues())
  const [active, setActive] = createSignal(0)
  const [loading, setLoading] = createSignal(false)
  let input: HTMLInputElement | undefined
  let list: HTMLUListElement | undefined

  // Typing quickly sends one request for what was typed last, not one per key.
  let timer: number | undefined
  let latest = 0
  createEffect(
    on(query, (text) => {
      clearTimeout(timer)
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
        } catch (err) {
          fail(err)
        } finally {
          if (asked === latest) setLoading(false)
        }
      }, 150)
    }),
  )
  onCleanup(() => clearTimeout(timer))

  function open(hit: Hit | undefined) {
    if (!hit) return
    remember(hit)
    props.onClose()
    showIssuePage(hit.projectKey, hit.number)
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault()
      props.onClose()
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const count = hits().length
      if (!count) return
      setActive((index) => (index + (e.key === 'ArrowDown' ? 1 : count - 1)) % count)
      list?.children[active()]?.scrollIntoView({ block: 'nearest' })
    } else if (e.key === 'Enter') {
      e.preventDefault()
      open(hits()[active()])
    }
  }

  onMount(() => input?.focus())

  return (
    <div class="overlay palette-overlay" onClick={(e) => e.target === e.currentTarget && props.onClose()}>
      <div class="palette" role="dialog" aria-label="Search issues">
        <div class="palette-input">
          <Icon name="search" size={18} />
          <input
            ref={input}
            role="combobox"
            aria-expanded={hits().length > 0}
            aria-controls="palette-results"
            aria-activedescendant={hits().length ? `palette-hit-${active()}` : undefined}
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

        <Show when={!query().trim() && hits().length}>
          <p class="palette-section">Recently opened</p>
        </Show>

        <ul class="palette-results" id="palette-results" role="listbox" ref={list}>
          <For each={hits()}>
            {(hit, index) => (
              <li
                id={`palette-hit-${index()}`}
                role="option"
                aria-selected={index() === active()}
                classList={{ active: index() === active() }}
                onMouseMove={() => setActive(index())}
                onClick={() => open(hit)}
              >
                <span class={`status-dot ${hit.status}`} />
                <span class="mono palette-key">{hit.key}</span>
                <span class="palette-title">
                  {hit.title}
                  <Show when={hit.excerpt}>
                    <small class="muted">{hit.excerpt}</small>
                  </Show>
                </span>
                <span class="muted palette-meta">
                  {STATUS_LABEL[hit.status] ?? hit.status}
                  {hit.assignee ? ` · ${hit.assignee}` : ''}
                </span>
              </li>
            )}
          </For>
        </ul>

        <Show when={query().trim() && !loading() && !hits().length}>
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
