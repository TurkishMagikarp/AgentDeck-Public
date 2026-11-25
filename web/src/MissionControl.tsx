import { createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import { api } from './api'
import { fleet as data, refreshFleet } from './fleet'
import { Icon } from './icons'
import { fail, loadProjects, say, showIssuePage } from './store'
import { Modal, timeAgo } from './ui'

/** Order and colour of the status segments in a project's progress bar. */
const SEGMENTS = [
  ['done', 'Fertig', 'var(--good)'],
  ['review', 'Review', 'var(--series-5)'],
  ['in_progress', 'In progress', 'var(--live)'],
  ['blocked', 'Waits for a human', 'var(--bad)'],
  ['todo', 'To Do', 'var(--accent)'],
  ['backlog', 'Backlog', 'var(--border)'],
] as const

const OUTCOMES: Record<string, { label: string; tone: string }> = {
  done: { label: 'done', tone: 'good' },
  approve: { label: 'approved', tone: 'good' },
  review: { label: 'for review', tone: 'accent' },
  changes: { label: 'changes', tone: 'warn' },
  handoff: { label: 'handed over', tone: 'accent' },
  blocked: { label: 'blocked', tone: 'bad' },
  failed: { label: 'failed', tone: 'bad' },
  stopped: { label: 'gestoppt', tone: 'warn' },
  finished: { label: 'finished', tone: 'good' },
  todo: { label: 'back in the queue', tone: 'warn' },
}

/** A run this long is worth a look: the watchdog may already be on it. */
const LONG_RUN = 30 * 60_000

const money = (usd: number) => (usd < 10 ? usd.toFixed(2) : Math.round(usd).toString()) + ' $'

function duration(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds} s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} min ${seconds % 60 ? String(seconds % 60).padStart(2, '0') + ' s' : ''}`.trim()
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`
}

type Since = { hours: number; closed: number; blocked: number; runs: number; failed: number; costUsd: number }

const SEEN_KEY = 'agentdeck.lastSeen'
const readSeen = () => {
  try {
    return Number(localStorage.getItem(SEEN_KEY)) || 0
  } catch {
    return 0
  }
}
const writeSeen = () => {
  try {
    localStorage.setItem(SEEN_KEY, String(Date.now()))
  } catch {
    // Private windows may refuse storage; the summary then simply does not appear.
  }
}

export function MissionControl(props: {
  onOpenProject: (projectId: number) => void
  onSearch: () => void
  onProviders: () => void
  onNewProject: () => void
  /** Providers and new projects are the admin's; the others do not see the buttons. */
  admin: boolean
  onMore: () => void
}) {
  const [now, setNow] = createSignal(Date.now())
  const [confirming, setConfirming] = createSignal(false)
  const [busy, setBusy] = createSignal(false)

  // "While you were away": shown once when the last visit is at least 30 minutes back.
  const [since, setSince] = createSignal<Since | null>(null)
  onMount(() => {
    const seen = readSeen()
    if (seen && Date.now() - seen > 30 * 60_000)
      api
        .get<Since>(`/overview/since?t=${seen}`)
        .then((summary) => summary.runs + summary.closed + summary.blocked > 0 && setSince(summary))
        .catch(() => {})
    else writeSeen()
    const leaving = () => document.visibilityState === 'hidden' && !since() && writeSeen()
    document.addEventListener('visibilitychange', leaving)
    onCleanup(() => document.removeEventListener('visibilitychange', leaving))
  })
  const dismissSince = () => {
    writeSeen()
    setSince(null)
  }

  // Mission control is the one page nobody should have to refresh: poll while it is open.
  onMount(() => {
    refreshFleet().catch(fail)
    const poll = setInterval(() => document.visibilityState === 'visible' && refreshFleet().catch(() => {}), 4000)
    const tick = setInterval(() => setNow(Date.now()), 1000)
    onCleanup(() => {
      clearInterval(poll)
      clearInterval(tick)
    })
  })

  const totals = () => data()?.totals
  const attention = createMemo(() => data()?.inbox.length ?? 0)

  async function resolve(issueId: number, status: 'todo' | 'done') {
    try {
      await api.patch(`/issues/${issueId}`, { status })
      await refreshFleet()
    } catch (e) {
      fail(e)
    }
  }

  /** Every waiting issue back in the queue: one click after a night of blockers. */
  async function retryAll() {
    const items = data()?.inbox ?? []
    try {
      await Promise.all(items.map((item) => api.patch(`/issues/${item.issueId}`, { status: 'todo' })))
      say(`${items.length} issues back in the queue`)
      await refreshFleet()
    } catch (e) {
      fail(e)
    }
  }

  const [cap, setCap] = createSignal<string | null>(null)
  async function saveCap() {
    const value = cap()
    if (value === null) return
    try {
      await api.put('/spend-guard', { capUsd: value === '' ? 0 : Number(value) })
      setCap(null)
      await refreshFleet()
    } catch (e) {
      fail(e)
    }
  }

  async function pressKillSwitch(action: 'stop' | 'resume') {
    setBusy(true)
    try {
      await api.post('/kill-switch', { action })
      await refreshFleet()
      await loadProjects()
    } catch (e) {
      fail(e)
    } finally {
      setBusy(false)
      setConfirming(false)
    }
  }

  return (
    <div classList={{ mc: true, working: (data()?.running.length ?? 0) > 0 }} aria-busy={!data()}>
      <div class="mc-tools" aria-label="Werkzeuge">
        <button onClick={props.onSearch}>
          <Icon name="search" size={14} /> Search
        </button>
        <Show when={props.admin}>
          <button onClick={props.onNewProject}>
            <Icon name="plus" size={14} /> Project
          </button>
        </Show>
        <button onClick={props.onMore}>
          <Icon name="settings" size={14} /> More
        </button>
      </div>

      <header class="mc-head">
        <div>
          <h1>Mission Control</h1>
          <p class="muted">
            <Show when={data()} fallback="Loading…">
              {(d) => (
                <>
                  {d().running.length === 0
                    ? 'No agent is working right now.'
                    : `${d().running.length} ${d().running.length === 1 ? 'agent is' : 'agents are'} working right now.`}{' '}
                  {attention() > 0
                    ? `${attention()} ${attention() === 1 ? 'issue needs' : 'issues need'} you.`
                    : 'Nothing waits for you.'}
                </>
              )}
            </Show>
          </p>
        </div>
        <Show
          when={data()?.killSwitch}
          fallback={
            <button class="danger kill" onClick={() => setConfirming(true)} disabled={!data()?.projects.length}>
              <Icon name="stop" size={15} />
              Stop everything
            </button>
          }
        >
          <button class="primary kill" disabled={busy()} onClick={() => pressKillSwitch('resume')}>
            <Icon name="play" size={14} />
            Start again
          </button>
        </Show>
      </header>

      <Show when={since()}>
        {(s) => (
          <div class="mc-since" role="status">
            <span>
              <b>In the last {s().hours >= 48 ? `${Math.round(s().hours / 24)} days` : `${Math.round(s().hours)} h`}:</b>{' '}
              {s().closed} done · {s().runs} runs
              {s().failed ? ` (${s().failed} failed)` : ''} · {s().blocked} needed you · {money(s().costUsd)}
            </span>
            <button class="ghost" onClick={dismissSince}>
              <Icon name="check" size={13} /> Seen
            </button>
          </div>
        )}
      </Show>

      <Show when={data()?.killSwitch}>
        <div class="mc-banner" role="status">
          <Icon name="stop" size={16} />
          Kill switch active: all projects are paused. "Start again" wakes exactly the projects it paused.
        </div>
      </Show>

      <section class="kpis" aria-label="Key figures of the last 24 hours">
        <Kpi label="Running now" value={String(data()?.running.length ?? 0)} tone="live" live />
        <Kpi label="Needs you" value={String(attention())} tone={attention() ? 'bad' : 'good'} />
        <Kpi label="Done (24 h)" value={String(totals()?.closed24h ?? 0)} tone="good" />
        <Kpi
          label="Runs (24 h)"
          value={String(totals()?.runs24h ?? 0)}
          note={totals()?.failed24h ? `${totals()!.failed24h} failed` : 'no errors'}
          tone={totals()?.failed24h ? 'warn' : 'neutral'}
        />
        <Kpi label="Costs (24 h)" value={money(totals()?.cost24h ?? 0)} tone="neutral" />
        <Kpi
          label="Projects"
          value={String(totals()?.projects ?? 0)}
          note={totals()?.paused ? `${totals()!.paused} paused` : 'all active'}
          tone="neutral"
        />
      </section>

      <section class="guard" aria-label="Spend limit">
        <div class="guard-text">
          <b>Spend limit per 24 hours</b>
          <span class="muted">
            {data()?.guard.capUsd
              ? `At ${money(data()!.guard.capUsd)} the kill switch stops the fleet and sends you a push message.`
              : 'Off. Set a limit so that nothing gets expensive overnight.'}
            <Show when={data()?.guard.capUsd && data()!.guard.hoursLeft !== null}>
              {' '}
              <b classList={{ 'forecast-hot': data()!.guard.hoursLeft! < 6 }}>
                At the current pace ({money(data()!.guard.perHour)} per hour) it is reached in {data()!.guard.hoursLeft} h.
              </b>
            </Show>
          </span>
        </div>
        <Show when={data()?.guard.capUsd}>
          <div
            class="mc-meter"
            role="meter"
            aria-valuemin={0}
            aria-valuemax={data()!.guard.capUsd}
            aria-valuenow={data()!.guard.spentUsd}
            aria-label="Spend of the last 24 hours"
          >
            <span
              classList={{ hot: data()!.guard.spentUsd / data()!.guard.capUsd > 0.8 }}
              style={{ width: `${Math.min(100, (data()!.guard.spentUsd / data()!.guard.capUsd) * 100)}%` }}
            />
          </div>
        </Show>
        <form
          class="guard-form"
          onSubmit={(e) => {
            e.preventDefault()
            saveCap()
          }}
        >
          <label>
            <span class="sr-only">Limit in dollars</span>
            <input
              type="number"
              min="0"
              step="1"
              inputmode="decimal"
              placeholder="Limit in $"
              value={cap() ?? (data()?.guard.capUsd || '')}
              onInput={(e) => setCap(e.currentTarget.value)}
            />
          </label>
          <button type="submit" disabled={cap() === null}>
            Save
          </button>
        </form>
      </section>

      <div class="mc-grid">
        <section class="panel" aria-labelledby="mc-live">
          <h2 id="mc-live">
            <Icon name="bolt" size={15} /> Active now
          </h2>
          <Show
            when={data()?.running.length}
            fallback={<p class="empty">No agent at work. As soon as one starts, you see it live here.</p>}
          >
            <ul class="live-list">
              <For each={data()!.running}>
                {(r) => (
                  <li>
                    <button class="mc-row" onClick={() => showIssuePage(r.projectKey, r.issueNumber)}>
                      <span class="live-dot" aria-hidden="true" />
                      <span class="row-main">
                        <span class="row-title">
                          <b>{r.agent || 'Agent'}</b> is working on {r.projectKey}-{r.issueNumber}
                        </span>
                        <span class="row-sub">{r.line || r.issueTitle}</span>
                      </span>
                      <span classList={{ 'row-meta': true, mono: true, long: now() - r.startedAt > LONG_RUN }}>
                        {duration(now() - r.startedAt)}
                      </span>
                    </button>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </section>

        <section class="panel" aria-labelledby="mc-inbox">
          <h2 id="mc-inbox">
            <Icon name="inbox" size={15} /> Needs you
            <Show when={attention()}>
              <span class="count bad">{attention()}</span>
            </Show>
            <Show when={attention() > 1}>
              <button class="ghost inbox-all" onClick={retryAll} title="All back into the queue: agents try again">
                Retry all
              </button>
            </Show>
          </h2>
          <Show
            when={data()?.inbox.length}
            fallback={<p class="empty">Everything runs by itself. No decision open.</p>}
          >
            <ul class="live-list">
              <For each={data()!.inbox}>
                {(item) => (
                  <li class="row-wrap">
                    <button class="mc-row" onClick={() => showIssuePage(item.projectKey, item.number)}>
                      <span class="mc-dot bad" aria-hidden="true" />
                      <span class="row-main">
                        <span class="row-title">
                          <b class="mono">
                            {item.projectKey}-{item.number}
                          </b>{' '}
                          {item.title}
                        </span>
                        <Show when={item.reason}>
                          <span class="row-sub">{item.reason}</span>
                        </Show>
                      </span>
                      <span class="row-meta">{timeAgo(item.since)}</span>
                    </button>
                    <span class="row-actions">
                      <button title="Back into the queue: an agent tries again" onClick={() => resolve(item.issueId, 'todo')}>
                        Retry
                      </button>
                      <button title="Mark as done" onClick={() => resolve(item.issueId, 'done')}>
                        <Icon name="check" size={13} /> Fertig
                      </button>
                    </span>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </section>
      </div>

      <section aria-labelledby="mc-fleet">
        <h2 id="mc-fleet" class="section-title">
          Fleet
        </h2>
        <div class="fleet">
          <For each={data()?.projects}>
            {(project) => {
              const total = () => Object.values(project.counts).reduce((a, b) => a + b, 0)
              return (
                <button class="fleet-card" onClick={() => props.onOpenProject(project.id)}>
                  <span class="fleet-top">
                    <span class="project-key">{project.key}</span>
                    <b class="fleet-name">{project.name}</b>
                    <Show when={project.paused}>
                      <span class="chip warn">paused</span>
                    </Show>
                    <Show when={project.running}>
                      <span class="chip live">
                        <span class="live-dot small" /> {project.running}
                      </span>
                    </Show>
                  </span>
                  <span
                    class="stack"
                    role="img"
                    aria-label={SEGMENTS.map(([k, label]) => `${label} ${project.counts[k] ?? 0}`).join(', ')}
                  >
                    <For each={SEGMENTS}>
                      {([key, , color]) => (
                        <Show when={project.counts[key]}>
                          <span style={{ flex: project.counts[key], background: color }} />
                        </Show>
                      )}
                    </For>
                  </span>
                  <span class="fleet-foot muted">
                    <span>
                      {project.counts.done ?? 0} / {total()} done
                    </span>
                    <span>{money(project.costToday)} today</span>
                  </span>
                </button>
              )
            }}
          </For>
        </div>
        <ul class="mc-legend" aria-hidden="true">
          <For each={SEGMENTS}>
            {([, label, color]) => (
              <li>
                <i style={{ background: color }} /> {label}
              </li>
            )}
          </For>
        </ul>
      </section>

      <section class="panel" aria-labelledby="mc-trend">
        <h2 id="mc-trend">
          <Icon name="chart" size={15} /> Costs and runs, 14 days
        </h2>
        <Show when={data()?.daily}>{(days) => <Trend days={days()} />}</Show>
      </section>

      <Show when={data()?.agents.length}>
        <section class="panel" aria-labelledby="mc-agents">
          <h2 id="mc-agents">
            <Icon name="users" size={15} /> Agents, 7 days
          </h2>
          <div class="table-wrap">
            <table class="scores">
              <thead>
                <tr>
                  <th scope="col">Agent</th>
                  <th scope="col" class="num">Runs</th>
                  <th scope="col" class="num">Success</th>
                  <th scope="col" class="num">Avg. duration</th>
                  <th scope="col" class="num">Costs</th>
                </tr>
              </thead>
              <tbody>
                <For each={data()!.agents}>
                  {(a) => (
                    <tr>
                      <th scope="row">
                        {a.agent} <span class="muted mono">{a.projectKey}</span>
                      </th>
                      <td class="num">{a.runs}</td>
                      <td class="num">
                        <Show when={a.successRate !== null} fallback={<span class="muted">-</span>}>
                          <span class="rate">
                            <span class="rate-bar" aria-hidden="true">
                              <span
                                classList={{ low: a.successRate! < 0.5 }}
                                style={{ width: `${Math.round(a.successRate! * 100)}%` }}
                              />
                            </span>
                            {Math.round(a.successRate! * 100)} %
                          </span>
                        </Show>
                      </td>
                      <td class="num">{a.avgSeconds ? duration(a.avgSeconds * 1000) : '-'}</td>
                      <td class="num">{money(a.costUsd)}</td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>
        </section>
      </Show>

      <section class="panel" aria-labelledby="mc-feed">
        <h2 id="mc-feed">
          <Icon name="journal" size={15} /> What happened last
        </h2>
        <Show when={data()?.feed.length} fallback={<p class="empty">No finished runs yet.</p>}>
          <ul class="feed">
            <For each={data()!.feed}>
              {(f) => {
                const outcome = OUTCOMES[f.outcome] ?? { label: f.outcome, tone: 'neutral' }
                return (
                  <li>
                    <span class={`chip ${outcome.tone}`}>{outcome.label}</span>
                    <span class="feed-text">
                      <b>{f.agent || 'Agent'}</b> an{' '}
                      <span class="mono">
                        {f.projectKey}-{f.issueNumber}
                      </span>{' '}
                      {f.issueTitle}
                    </span>
                    <span class="row-meta mono">
                      {duration(f.seconds * 1000)} · {money(f.costUsd)}
                    </span>
                    <span class="row-meta">{timeAgo(f.at)}</span>
                  </li>
                )
              }}
            </For>
          </ul>
        </Show>
      </section>

      <Show when={data()?.health}>
        {(h) => (
          <footer class="health muted" aria-label="State of the server">
            <span>Up for {duration(h().uptimeSec * 1000)}</span>
            <span>{h().memoryMb} MB RAM</span>
            <span>Database {h().dbMb} MB</span>
            <Show when={h().diskTotalGb}>
              <span classList={{ 'disk-low': h().diskFreeGb / h().diskTotalGb < 0.1 }}>
                Disk: {h().diskFreeGb} of {h().diskTotalGb} GB free
                {h().diskFreeGb / h().diskTotalGb < 0.1 ? ' (almost full)' : ''}
              </span>
            </Show>
          </footer>
        )}
      </Show>

      <Show when={confirming()}>
        <Modal title="Stop everything?" onClose={() => setConfirming(false)}>
          <div class="modal-body">
            <p>
              The kill switch pauses <b>all {data()?.projects.filter((p) => !p.paused).length} active projects</b> and stops{' '}
              <b>{data()?.running.length} running agents</b> at once. Stopped issues go back to "To Do", nothing is
              lost.
            </p>
            <p class="muted">"Start again" only wakes the projects the kill switch paused.</p>
          </div>
          <footer class="modal-actions">
            <button onClick={() => setConfirming(false)}>Cancel</button>
            <button class="danger" disabled={busy()} onClick={() => pressKillSwitch('stop')}>
              <Icon name="stop" size={14} /> Stop now
            </button>
          </footer>
        </Modal>
      </Show>
    </div>
  )
}

function Kpi(props: { label: string; value: string; note?: string; tone: string; live?: boolean }) {
  return (
    <div class={`kpi ${props.tone}`} classList={{ zero: props.value === '0' || props.value === '0.00 $' }}>
      <span class="kpi-label">{props.label}</span>
      <span class="kpi-value">
        <Show when={props.live && props.value !== '0'}>
          <span class="live-dot" aria-hidden="true" />
        </Show>
        {props.value}
      </span>
      <Show when={props.note}>
        <span class="kpi-note">{props.note}</span>
      </Show>
    </div>
  )
}

/** Bars of the cost per day; the failed share of the runs is marked in red on top. Values sit in the title. */
function Trend(props: { days: NonNullable<ReturnType<typeof data>>['daily'] }) {
  const max = () => Math.max(0.01, ...props.days.map((d) => d.cost))
  return (
    <div class="trend" role="img" aria-label={`Costs per day: ${props.days.map((d) => `${d.day} ${money(d.cost)}`).join(', ')}`}>
      <For each={props.days}>
        {(d) => (
          <div class="trend-col" title={`${d.day}: ${money(d.cost)}, ${d.runs} runs, ${d.failed} failed`}>
            <span class="trend-bar-wrap">
              <span
                classList={{ 'trend-bar': true, idle: d.cost === 0 }}
                style={{ height: `${Math.max(d.cost === 0 ? 2 : 6, (d.cost / max()) * 100)}%` }}
              />
            </span>
            <span class="trend-day mono">{d.day.slice(8)}</span>
            <span classList={{ 'trend-runs': true, bad: d.failed > 0 }}>{d.runs || ''}</span>
          </div>
        )}
      </For>
    </div>
  )
}
