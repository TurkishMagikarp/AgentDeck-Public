import { createEffect, createMemo, createResource, For, on, onCleanup, Show } from 'solid-js'
import { api } from './api'
import { board, openIssue } from './store'
import { onActivateKey, timeAgo } from './ui'
import { t, locale } from './i18n'

type Commit = { hash: string; at: number; subject: string }
type Lane = {
  branch: string
  number: number
  title: string
  status: string
  maker: string
  commits: Commit[]
  fork: { hash: string; at: number }
  landed: boolean
  landedAt: number | null
  mergeHash: string
  working: { agent: string; kind: string }[]
}
type Graph =
  | { repo: false }
  | {
      repo: true
      base: string
      baseCommits: Commit[]
      branches: Lane[]
      agents: { name: string; enabled: boolean; branch: string; kind: string; working: boolean }[]
    }

type RepoGraph = Extract<Graph, { repo: true }>

const STEP = 34
const ROW = 40
const PAD = 24
const DOT = 6

const SLOTS = [1, 2, 3, 4, 5, 6].map((slot) => `var(--series-${slot})`)

const STATUS_LABEL: Record<string, string> = {
  backlog: 'Backlog',
  todo: 'To Do',
  in_progress: 'In Arbeit',
  review: 'Review',
  blocked: 'Wartet',
  done: 'Fertig',
}

const when = (at: number) =>
  new Date(at).toLocaleString(locale(), {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })

/**
 * The project's git workflow: the base branch on top, one lane per issue branch below it.
 * Commits are ordered by time across all lanes, so forks, work and landings line up.
 */
export function GitView() {
  const [graph, { refetch }] = createResource(
    () => board.project!.id,
    (id) => api.get<Graph>(`/projects/${id}/git`),
  )
  // A finished run usually means a new commit or a landing.
  createEffect(
    on(
      () => board.runs.length,
      () => refetch(),
      { defer: true },
    ),
  )
  const timer = setInterval(refetch, 15_000)
  onCleanup(() => clearInterval(timer))

  const colorOf = (agent: string) => {
    const index = board.agents.findIndex((candidate) => candidate.name === agent)
    return index >= 0 ? (SLOTS[index] ?? 'var(--muted)') : 'var(--muted)'
  }

  const layout = createMemo(() => {
    const fetched = graph()
    if (!fetched?.repo) return null
    const data: RepoGraph = fetched
    const lanes = data.branches

    // One column per commit, in time order. Working lanes get a last column for "now".
    const points = [
      ...data.baseCommits.map((commit) => ({ ...commit, lane: 0 })),
      ...lanes.flatMap((lane, index) => lane.commits.map((commit) => ({ ...commit, lane: index + 1 }))),
    ].sort((a, b) => a.at - b.at)
    const column = new Map<string, number>()
    points.forEach((point, index) => column.set(`${point.lane}:${point.hash}`, index))
    const nowColumn = points.length
    const x = (index: number) => PAD + index * STEP
    const y = (lane: number) => PAD + lane * ROW

    /** Column of the first base commit at or after a time: where a landing shows up on the base. */
    const baseColumnAt = (at: number) => {
      const found = data.baseCommits.find((commit) => commit.at >= at)
      return found ? column.get(`0:${found.hash}`)! : nowColumn
    }

    const drawn = lanes.map((lane, index) => {
      const laneY = y(index + 1)
      const forkColumn = column.get(`0:${lane.fork.hash}`)
      const startX = forkColumn === undefined ? PAD / 2 : x(forkColumn)
      const dots = lane.commits.map((commit) => ({
        ...commit,
        cx: x(column.get(`${index + 1}:${commit.hash}`)!),
      }))
      const firstX = dots[0]?.cx ?? (lane.working.length ? x(nowColumn) : startX + STEP)
      const lastX = dots.at(-1)?.cx ?? firstX
      const bend = Math.min(STEP, Math.max(8, firstX - startX))

      let path = `M ${startX} ${y(0)} C ${startX} ${laneY}, ${firstX - bend} ${laneY}, ${firstX} ${laneY} L ${lastX} ${laneY}`
      let mergeX: number | null = null
      if (lane.landed) {
        // The merge commit itself when there is one; otherwise the first base commit after landing.
        const mergeColumn = column.get(`0:${lane.mergeHash}`)
        if (mergeColumn !== undefined) mergeX = x(mergeColumn)
        else if (lane.landedAt) mergeX = Math.max(x(baseColumnAt(lane.landedAt)), lastX + STEP / 2)
      }
      if (mergeX !== null) path += ` C ${mergeX} ${laneY}, ${mergeX} ${laneY}, ${mergeX} ${y(0)}`
      const nowX = lane.working.length ? x(nowColumn) : null
      return {
        lane,
        laneY,
        path,
        dots,
        lastX,
        nowX,
        mergeX,
        color: colorOf(lane.working[0]?.agent || lane.maker),
      }
    })

    const width = x(nowColumn) + PAD * 2
    const height = y(lanes.length) + PAD
    const baseDots = data.baseCommits.map((commit) => ({ ...commit, cx: x(column.get(`0:${commit.hash}`)!) }))
    return { data, drawn, baseDots, width, height, nowX: x(nowColumn) }
  })

  const lastActivity = (lane: Lane) => Math.max(lane.landedAt ?? 0, lane.commits.at(-1)?.at ?? 0, lane.fork.at)
  const openLane = (number: number) => {
    const id = issueId(number)
    if (id) openIssue(id)
  }

  const issueId = (number: number) => board.issues.find((issue) => issue.number === number)?.id

  // The newest work is on the right, so the graph opens scrolled there.
  let scroller: HTMLDivElement | undefined
  createEffect(
    on(layout, () => queueMicrotask(() => scroller && (scroller.scrollLeft = scroller.scrollWidth))),
  )

  return (
    <div class="page">
      <div class="page-head">
        <div>
          <h2>Git</h2>
          <p class="muted">
            {t('Oben der Basis-Branch, darunter ein Branch pro Issue. Farbe = Agent, pulsierend = arbeitet gerade.')}
          </p>
        </div>
      </div>

      <Show when={graph()?.repo === false}>
        <p class="muted">{t('Dieses Projekt hat noch kein Git-Repository mit Commits.')}</p>
      </Show>

      <Show when={layout()}>
        {(view) => (
          <>
            <ul class="git-summary" aria-label={t('Überblick über das Repository')}>
              <li classList={{ zero: String(view().data.baseCommits.length) === '0' }}>
                <strong>{view().data.baseCommits.length}</strong>
                <span>{t('Commits auf {branch}', { branch: view().data.base })}</span>
              </li>
              <li classList={{ zero: String(view().data.branches.filter((lane) => !lane.landed).length) === '0' }}>
                <strong>{view().data.branches.filter((lane) => !lane.landed).length}</strong>
                <span>{t('Branches in Arbeit')}</span>
              </li>
              <li classList={{ zero: String(view().data.branches.filter((lane) => lane.landed).length) === '0' }}>
                <strong>{view().data.branches.filter((lane) => lane.landed).length}</strong>
                <span>{t('gelandet')}</span>
              </li>
              <li classList={{ zero: String(view().data.agents.filter((agent) => agent.working).length) === '0' }}>
                <strong>{view().data.agents.filter((agent) => agent.working).length}</strong>
                <span>{t('Agenten arbeiten gerade')}</span>
              </li>
            </ul>

            <ul class="git-agents">
              <For each={view().data.agents}>
                {(agent) => (
                  <li classList={{ idle: !agent.working, off: !agent.enabled }}>
                    <span class="key" style={{ background: colorOf(agent.name) }} />
                    <strong>{agent.name}</strong>
                    <span class="muted">
                      {agent.working
                        ? agent.kind === 'review'
                          ? t('prüft {branch}', { branch: agent.branch })
                          : t('arbeitet auf {branch}', { branch: agent.branch })
                        : agent.branch
                          ? t('hat {branch} ausgecheckt', { branch: agent.branch })
                          : t('frei')}
                    </span>
                  </li>
                )}
              </For>
            </ul>

            <div class="git-graph">
              <div class="git-labels" style={{ 'padding-top': `${PAD - ROW / 2}px` }}>
                <div class="git-label base" style={{ height: `${ROW}px` }}>
                  <span class="mono">{view().data.base}</span>
                </div>
                <For each={view().drawn}>
                  {(lane) => (
                    <button
                      class="git-label"
                      style={{ height: `${ROW}px` }}
                      onClick={() => {
                        const id = issueId(lane.lane.number)
                        if (id) openIssue(id)
                      }}
                      title={lane.lane.branch}
                    >
                      <span class="mono">
                        {board.project!.key}-{lane.lane.number}
                      </span>
                      <span class="git-title">{lane.lane.title}</span>
                      <span class="chip" classList={{ live: lane.lane.working.length > 0 }}>
                        {lane.lane.working.length
                          ? lane.lane.working.map((work) => work.agent).join(', ')
                          : lane.lane.landed
                            ? t('gelandet')
                            : STATUS_LABEL[lane.lane.status]
                              ? t(STATUS_LABEL[lane.lane.status])
                              : lane.lane.status}
                      </span>
                    </button>
                  )}
                </For>
              </div>

              <div class="git-scroll" ref={scroller}>
                <svg
                  width={view().width}
                  height={view().height}
                  role="img"
                  aria-label={t('Git-Graph der Agenten')}
                >
                  <line x1={PAD / 2} x2={view().nowX} y1={PAD} y2={PAD} class="git-base-line" />
                  <For each={view().drawn}>
                    {(lane) => (
                      <g style={{ color: lane.color }}>
                        <path d={lane.path} class="git-lane" classList={{ landed: lane.lane.landed }} />
                        <Show when={lane.nowX !== null}>
                          <line
                            x1={lane.lastX}
                            x2={lane.nowX!}
                            y1={lane.laneY}
                            y2={lane.laneY}
                            class="git-lane pending"
                          />
                          <circle cx={lane.nowX!} cy={lane.laneY} r={DOT + 2} class="git-now">
                            <title>
                              {lane.lane.working.map((work) => t('{agent} arbeitet gerade', { agent: work.agent })).join(', ')}
                            </title>
                          </circle>
                        </Show>
                        <For each={lane.dots}>
                          {(dot) => (
                            <circle cx={dot.cx} cy={lane.laneY} r={DOT} class="git-dot">
                              <title>{`${dot.hash} ${dot.subject}\n${when(dot.at)}`}</title>
                            </circle>
                          )}
                        </For>
                        <Show when={lane.mergeX !== null}>
                          <circle cx={lane.mergeX!} cy={PAD} r={DOT - 1} class="git-merge">
                            <title>{t('{issue} gelandet', { issue: `${board.project!.key}-${lane.lane.number}` })}</title>
                          </circle>
                        </Show>
                      </g>
                    )}
                  </For>
                  <For each={view().baseDots}>
                    {(dot) => (
                      <circle cx={dot.cx} cy={PAD} r={DOT - 1} class="git-base-dot">
                        <title>{`${dot.hash} ${dot.subject}\n${when(dot.at)}`}</title>
                      </circle>
                    )}
                  </For>
                </svg>
              </div>
            </div>
            <Show when={view().data.branches.length}>
              <h3 class="section-title">{t('Branches')}</h3>
              <div class="table-wrap git-table">
                <table class="scores">
                  <thead>
                    <tr>
                      <th scope="col">{t('Issue')}</th>
                      <th scope="col">{t('Von||Autor')}</th>
                      <th scope="col">{t('Stand')}</th>
                      <th scope="col" class="num">{t('Commits')}</th>
                      <th scope="col" class="num">{t('Letzte Aktivität')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    <For
                      each={[...view().data.branches].sort(
                        (a, b) => lastActivity(b) - lastActivity(a),
                      )}
                    >
                      {(lane) => (
                        <tr class="git-row" tabindex="0" onClick={() => openLane(lane.number)} onKeyDown={onActivateKey(() => openLane(lane.number))}>
                          <th scope="row">
                            <span class="mono">
                              {board.project!.key}-{lane.number}
                            </span>{' '}
                            {lane.title}
                          </th>
                          <td>{lane.maker || '-'}</td>
                          <td>
                            <span class="chip" classList={{ live: lane.working.length > 0, good: lane.landed }}>
                              {lane.working.length
                                ? t('{agent} arbeitet', { agent: lane.working.map((work) => work.agent).join(', ') })
                                : lane.landed
                                  ? t('gelandet')
                                  : STATUS_LABEL[lane.status]
                                    ? t(STATUS_LABEL[lane.status])
                                    : lane.status}
                            </span>
                          </td>
                          <td class="num">{lane.commits.length}</td>
                          <td class="num">{timeAgo(lastActivity(lane))}</td>
                        </tr>
                      )}
                    </For>
                  </tbody>
                </table>
              </div>
            </Show>
            <Show when={!view().drawn.length}>
              <p class="muted">
                {t('Noch keine Issue-Branches. Sie entstehen, sobald ein Agent an einem Issue arbeitet.')}
              </p>
            </Show>
          </>
        )}
      </Show>
    </div>
  )
}
