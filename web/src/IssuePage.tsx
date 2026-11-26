import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show, type JSX } from 'solid-js'
import { api } from './api'
import { Arena } from './Arena'
import { PRIORITIES } from './Board'
import { Changes } from './Changes'
import { Dossier } from './Dossier'
import { Icon } from './icons'
import { CommentItem, CostForecast, RunItem, Screenshots, Spending } from './IssueParts'
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
import { t, locale } from './i18n'
import { Select, timeAgo } from './ui'

const STATUS_OPTIONS: [Status, string][] = [
  ['backlog', 'Backlog'],
  ['todo', 'To Do'],
  ['in_progress', 'In Arbeit'],
  ['review', 'Review'],
  ['blocked', 'Wartet auf Mensch'],
  ['done', 'Fertig'],
]
const STATUS_RAW = Object.fromEntries(STATUS_OPTIONS) as Record<string, string>
const statusLabel = (status: string) => (STATUS_RAW[status] ? t(STATUS_RAW[status]) : status)
const statusOptions = (): [Status, string][] => STATUS_OPTIONS.map(([id, label]) => [id, t(label)])

const FIELD_LABEL: Record<string, string> = {
  title: 'Titel',
  status: 'Status',
  assignee_id: 'Agent',
  priority: 'Priorität',
  blocked_by: 'Wartet auf',
  reviewers: 'Prüfer',
  grp: 'Gruppe',
  model: 'Modell',
}

type Tab = 'all' | 'comments' | 'history' | 'runs'
const TABS: [Tab, string][] = [
  ['all', 'Alle'],
  ['comments', 'Kommentare'],
  ['history', 'Verlauf'],
  ['runs', 'Läufe'],
]

type Entry = { at: number; comment?: Comment; event?: IssueEvent; run?: Run }

const when = (at: number) => new Date(at).toLocaleString(locale(), { dateStyle: 'medium', timeStyle: 'short' })

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
    if (!confirm(t('{key} wirklich löschen?', { key: key() }))) return
    await api.del(`/issues/${issue().id}`).catch(fail)
    leaveIssuePage()
  }

  return (
    <div class="issue-page" role="main" aria-label={t('Issue {key}', { key: key() })}>
      <header class="issue-page-bar">
        <nav class="breadcrumb" aria-label={t('Pfad')}>
          <button class="ghost" onClick={leaveIssuePage}>
            {board.project?.name}
          </button>
          <span class="muted">/</span>
          <span class="issue-key">{key()}</span>
        </nav>
        <span class="spacer" />
        <Show when={copied()}>
          <span class="muted copied">{t('Link kopiert')}</span>
        </Show>
        <button class="ghost icon-button" title={t('Link kopieren')} aria-label={t('Link kopieren')} onClick={copyLink}>
          <Icon name="link" />
        </button>
        <button class="ghost danger" onClick={remove}>
          {t('Löschen')}
        </button>
        <button
          class="ghost icon-button"
          onClick={leaveIssuePage}
          aria-label={t('Zurück zum Board')}
          title={t('Zurück zum Board (Esc)')}
        >
          <Icon name="close" />
        </button>
      </header>

      <div class="issue-layout">
        <IssueTitle title={issue().title} onSave={(title) => updateIssue(issue().id, { title })} />

        <div class="issue-main">
          <Show when={!activeRun() && waitReasons[issue().id]}>
            {(reason) => (
              <p class={`wait-reason large ${reason().kind}`}>
                <Icon name="clock" size={14} />
                <span>
                  <strong>{t('Wartet:')}</strong> {reason().text}
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
                    <strong>{run().agent_name}</strong> {t('arbeitet')} ({providerLabel(run().provider)})
                    <p class="muted">{liveLine[issue().id] ?? t('startet…')}</p>
                  </div>
                  <button onClick={() => api.post(`/issues/${issue().id}/stop`).catch(fail)}>{t('Stoppen')}</button>
                </div>
                <RunLog runId={run().id} live />
              </section>
            )}
          </Show>

          <Description />
          <Show when={board.project?.settings.checklists.enabled || issue().checklist?.length}>
            <Checklist />
          </Show>
          <Dependencies />
          <Arena issue={issue()} version={version()} />

          <Show when={issue().handoff}>
            <section class="issue-section">
              <h3>{t('Übergabenotiz')}</h3>
              <p class="prose">{issue().handoff}</p>
            </section>
          </Show>

          <Screenshots issueId={issue().id} comments={detail.current!.comments.length} />
          <Changes issueId={issue().id} version={version()} />
          <Dossier issueId={issue().id} version={version()} />
          <Activity />
        </div>

        <aside class="issue-side" aria-label={t('Details')}>
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
          <h3>{t('Beschreibung')}</h3>
          <Show when={!editing()}>
            <button class="ghost" onClick={start}>
              {t('Bearbeiten')}
            </button>
          </Show>
        </div>
        <Show
          when={editing()}
          fallback={
            <div class="prose description-view" onDblClick={start} title={t('Doppelklick zum Bearbeiten')}>
              <Show when={issue().description} fallback={<span class="muted">{t('Keine Beschreibung.')}</span>}>
                {issue().description}
              </Show>
            </div>
          }
        >
          <textarea
            class="description"
            aria-label={t('Beschreibung')}
            value={draft()}
            onInput={(e) => setDraft(e.currentTarget.value)}
            onKeyDown={(e) => e.key === 'Enter' && (e.ctrlKey || e.metaKey) && save()}
            ref={(element) => queueMicrotask(() => element.focus())}
          />
          <div class="inline-row end">
            <button class="ghost" onClick={() => setEditing(false)}>
              {t('Abbrechen')}
            </button>
            <button class="primary" onClick={save}>
              {t('Speichern')}
            </button>
          </div>
        </Show>
      </section>
    )
  }

  /** The acceptance checklist, with what the maker last reported per item. Editable, one item per line. */
  function Checklist() {
    const [editing, setEditing] = createSignal(false)
    const [draft, setDraft] = createSignal('')
    const items = () => issue().checklist ?? []
    const start = () => {
      setDraft(items().join('\n'))
      setEditing(true)
    }
    const save = () => {
      updateIssue(issue().id, { checklist: draft().split('\n') })
      setEditing(false)
    }
    /** The maker's line for item n ("2. ok: proof"), if it reported one. */
    const reported = (n: number) =>
      (issue().checklist_report ?? '')
        .split('\n')
        .map((line) => line.match(/^\s*(\d+)[.)]?\s*\[?([a-zäöü/]+)\]?\s*[:—–-]?\s*(.*)$/i))
        .find((found) => found && Number(found[1]) === n)
    const met = (n: number) =>
      /^(ok|done|erledigt|erfüllt|ja|yes|n\/a|entfällt)$/i.test(reported(n)?.[2] ?? '')

    return (
      <section class="issue-section">
        <div class="issue-section-head">
          <h3>{t('Abnahme-Checkliste')}</h3>
          <Show when={!editing()}>
            <button class="ghost" onClick={start}>
              {t('Bearbeiten')}
            </button>
          </Show>
        </div>
        <Show
          when={editing()}
          fallback={
            <Show
              when={items().length}
              fallback={
                <p class="muted">
                  {t('Noch keine. Sie entsteht beim nächsten Start aus „Done when“ und den Vorlagen.')}
                </p>
              }
            >
              <ol class="checklist">
                <For each={items()}>
                  {(item, index) => (
                    <li classList={{ met: met(index() + 1) }}>
                      <span class="checklist-mark" aria-label={met(index() + 1) ? t('erfüllt') : t('offen')}>
                        {met(index() + 1) ? '✓' : '○'}
                      </span>
                      <span>
                        {item}
                        <Show when={reported(index() + 1)?.[3]}>
                          {(proof) => <span class="muted checklist-proof">{proof()}</span>}
                        </Show>
                      </span>
                    </li>
                  )}
                </For>
              </ol>
            </Show>
          }
        >
          <textarea
            class="description"
            aria-label={t('Checkliste, ein Punkt pro Zeile')}
            value={draft()}
            onInput={(e) => setDraft(e.currentTarget.value)}
            onKeyDown={(e) => e.key === 'Enter' && (e.ctrlKey || e.metaKey) && save()}
            ref={(element) => queueMicrotask(() => element.focus())}
          />
          <div class="inline-row end">
            <button class="ghost" onClick={() => setEditing(false)}>
              {t('Abbrechen')}
            </button>
            <button class="primary" onClick={save}>
              {t('Speichern')}
            </button>
          </div>
        </Show>
      </section>
    )
  }

  /** "Wartet auf" and "Hält auf" as lists, each editable. */
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
    // "Hält auf" is stored on the other issue: it lists this one among its blockers.
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
          <h3>{t('Abhängigkeiten')}</h3>
          <Show when={holdsInTotal() > links().dependents.length}>
            <span class="muted">{t('hält über die Kette {n} Issues auf', { n: holdsInTotal() })}</span>
          </Show>
        </div>
        <LinkList
          title={t('Wartet auf')}
          empty={t('Wartet auf nichts.')}
          links={links().blockers}
          onRemove={(link) => removeBlocker(link.number)}
          onAdd={addBlocker}
        />
        <LinkList
          title={t('Hält auf')}
          empty={t('Niemand wartet auf dieses Issue.')}
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
                <span class="muted link-status">{statusLabel(link.status)}</span>
                <span class="muted link-agent">{agentById(link.assignee_id)?.name ?? ''}</span>
                <button
                  class="ghost icon-button"
                  title={t('Verknüpfung entfernen')}
                  aria-label={t('{key} entfernen', { key: key(link.number) })}
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
            aria-label={t('{title}: Issue hinzufügen', { title: props.title })}
            placeholder={t('Issue hinzufügen, z. B. {key}', { key: `${board.project?.key}-12` })}
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
          <h3>{t('Aktivität')}</h3>
          <div class="segmented" role="tablist" aria-label={t('Aktivität filtern')}>
            <For each={TABS}>
              {([id, label]) => (
                <button
                  role="tab"
                  aria-selected={tab() === id}
                  classList={{ active: tab() === id }}
                  onClick={() => setTab(id)}
                >
                  {t(label)}
                </button>
              )}
            </For>
          </div>
        </div>

        <ul class="timeline">
          <li class="history-item created">
            <span class="muted">
              {issue().created_by
                ? t('Angelegt von {by} am {date}', { by: issue().created_by!, date: when(issue().created_at ?? 0) })
                : t('Angelegt am {date}', { date: when(issue().created_at ?? 0) })}
            </span>
          </li>
          <For each={entries()} fallback={<li class="muted">{t('Noch nichts.')}</li>}>
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
            aria-label={t('Kommentar')}
            placeholder={t('Kommentar oder Anweisung an den Agenten… (Strg+Enter sendet)')}
            value={comment()}
            onInput={(e) => setComment(e.currentTarget.value)}
            onKeyDown={(e) =>
              e.key === 'Enter' && (e.ctrlKey || e.metaKey) && e.currentTarget.form?.requestSubmit()
            }
          />
          <button class="primary" type="submit" disabled={!comment().trim()}>
            {t('Senden')}
          </button>
        </form>
      </section>
    )
  }

  function HistoryItem(props: { event: IssueEvent }) {
    const value = (raw: string | null): string => {
      const field = props.event.field
      if (raw === null || raw === '') return '–'
      if (field === 'status') return statusLabel(raw)
      if (field === 'priority') return PRIORITIES[Number(raw)] ? t(PRIORITIES[Number(raw)]) : raw
      if (field === 'assignee_id') return agentById(Number(raw))?.name ?? t('beliebiger Agent')
      if (field === 'blocked_by') {
        const numbers: number[] = JSON.parse(raw)
        return numbers.length ? numbers.map((number) => key(number)).join(', ') : t('nichts')
      }
      if (field === 'reviewers') {
        const ids: number[] = JSON.parse(raw)
        return ids.length ? ids.map((id) => agentById(id)?.name ?? '?').join(', ') : t('keine')
      }
      return raw
    }
    return (
      <li class="history-item">
        <strong>{props.event.actor === 'Owner' ? t('Du') : props.event.actor}</strong>{' '}
        {t(props.event.actor === 'Owner' ? 'hast {field} geändert:' : 'hat {field} geändert:', {
          field: FIELD_LABEL[props.event.field] ? t(FIELD_LABEL[props.event.field]) : props.event.field,
        })}{' '}
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
          aria-label={t('Status')}
          value={issue().status}
          options={statusOptions()}
          onChange={(status) => updateIssue(issue().id, { status })}
        />
        <h3>{t('Details')}</h3>
        {row(
          t('Agent'),
          <select
            aria-label={t('Agent')}
            onChange={(e) => updateIssue(issue().id, { assignee_id: Number(e.currentTarget.value) || null })}
          >
            <option value="">{t('Beliebiger freier Agent')}</option>
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
          t('Priorität'),
          <select
            aria-label={t('Priorität')}
            onChange={(e) => updateIssue(issue().id, { priority: Number(e.currentTarget.value) })}
          >
            <For each={PRIORITIES}>
              {(label, index) => (
                <option value={index()} selected={index() === issue().priority}>
                  {t(label)}
                </option>
              )}
            </For>
          </select>,
        )}
        {row(
          t('Prüfer'),
          <div class="reviewers">
            <For each={issue().reviewers}>
              {(agentId, index) => (
                <button class="chip" title={t('Entfernen')} onClick={() => removeReviewer(agentId)}>
                  {index() + 1}. {agentById(agentId)?.name ?? '?'}
                  <Icon name="close" size={11} />
                </button>
              )}
            </For>
            <select
              aria-label={t('Prüfer hinzufügen')}
              onChange={(e) => {
                addReviewer(Number(e.currentTarget.value))
                e.currentTarget.value = ''
              }}
            >
              <option value="">{t('+ Prüfer')}</option>
              <For each={board.agents.filter((agent) => !issue().reviewers.includes(agent.id))}>
                {(agent) => <option value={agent.id}>{agent.name}</option>}
              </For>
            </select>
          </div>,
        )}
        {row(
          t('Gruppe'),
          <input
            aria-label={t('Gruppe')}
            placeholder={t('z. B. Meilenstein 1')}
            value={issue().grp}
            onChange={(e) => updateIssue(issue().id, { grp: e.currentTarget.value })}
          />,
        )}
        {row(
          t('Modell'),
          <ModelSelect
            provider={agentById(issue().assignee_id)?.provider ?? ''}
            value={issue().model ?? ''}
            emptyLabel={t('Modell des Agenten')}
            onChange={(model) => updateIssue(issue().id, { model })}
          />,
        )}
        {row(t('Verbrauch'), <Spending issueId={issue().id} version={version()} />)}
        <Show when={issue().status !== 'done'}>
          {row(t('Prognose'), <CostForecast issueId={issue().id} version={version()} />)}
        </Show>

        <h3>{t('Verlauf')}</h3>
        {row(t('Gebaut von'), <span>{maker()?.name ?? '–'}</span>)}
        {row(t('Angelegt'), <span>{issue().created_at ? when(issue().created_at!) : '–'}</span>)}
        {row(t('Geändert'), <span>{issue().updated_at ? when(issue().updated_at!) : '–'}</span>)}
        <Show when={issue().done_at}>{row(t('Erledigt'), <span>{when(issue().done_at!)}</span>)}</Show>
        <Show when={issue().landing === 'waiting'}>
          {row(t('Landung'), <span>{t('Pull Request wartet auf Checks')}</span>)}
        </Show>
        <Show when={issue().landing === 'approval' && issue().gate_sha}>
          {row(
            t('Landung'),
            <span>
              {t('Wartet auf deine Freigabe für Stand')} <code>{issue().gate_sha!.slice(0, 10)}</code>{' '}
              <button
                class="link"
                title={t('Lässt genau diesen Stand einmal landen. Ändert sich der Branch, braucht er eine neue Freigabe.')}
                onClick={() =>
                  api.post(`/issues/${issue().id}/approve-landing`, { sha: issue().gate_sha }).catch(fail)
                }
              >
                {t('Landung freigeben')}
              </button>
            </span>,
          )}
        </Show>
      </div>
    )
  }
}

/** The title wraps like a heading instead of running out of the window. Enter saves it. */
function IssueTitle(props: { title: string; onSave: (title: string) => void }) {
  let field!: HTMLTextAreaElement
  const fitHeight = () => {
    field.style.height = 'auto'
    field.style.height = `${field.scrollHeight}px`
  }
  createEffect(
    on(
      () => props.title,
      () => queueMicrotask(fitHeight),
    ),
  )
  onMount(() => window.addEventListener('resize', fitHeight))
  onCleanup(() => window.removeEventListener('resize', fitHeight))

  function save() {
    const title = field.value.replace(/\s+/g, ' ').trim()
    if (!title) field.value = props.title
    else if (title !== props.title) props.onSave(title)
    fitHeight()
  }

  return (
    <textarea
      ref={field}
      class="title-input issue-title"
      aria-label={t('Titel')}
      rows={1}
      value={props.title}
      onInput={fitHeight}
      onChange={save}
      onKeyDown={(e) => {
        if (e.key !== 'Enter') return
        e.preventDefault()
        e.currentTarget.blur()
      }}
    />
  )
}
