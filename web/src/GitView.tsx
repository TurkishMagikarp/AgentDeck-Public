import { createEffect, createMemo, createResource, For, on, onCleanup, Show } from 'solid-js'
import { api } from './api'
import { board, openIssue } from './store'

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
  in_progress: 'In progress',
  review: 'Review',
  blocked: 'Waiting',
  done: 'Done',
}

const when = (at: number) =>
  new Date(at).toLocaleString('en-US', {
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
            The base branch on top, one branch per issue below it. Color = agent, pulsing = working right now.
          </p>
        </div>
      </div>

      <Show when={graph()?.repo === false}>
        <p class="muted">This project has no git repository with commits yet.</p>
      </Show>

      <Show when={layout()}>
        {(view) => (
          <>
            <ul class="git-agents">
              <For each={view().data.agents}>
                {(agent) => (
                  <li classList={{ idle: !agent.working, off: !agent.enabled }}>
                    <span class="key" style={{ background: colorOf(agent.name) }} />
                    <strong>{agent.name}</strong>
                    <span class="muted">
                      {agent.working
                        ? `${agent.kind === 'review' ? 'reviewing' : 'working on'} ${agent.branch}`
                        : agent.branch
                          ? `has ${agent.branch} checked out`
                          : 'free'}
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
                            ? 'landed'
                            : (STATUS_LABEL[lane.lane.status] ?? lane.lane.status)}
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
                  aria-label="Git graph of the agents"
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
                              {lane.lane.working
                                .map((work) => `${work.agent} is working right now`)
                                .join(', ')}
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
                            <title>{`${board.project!.key}-${lane.lane.number} landed`}</title>
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
            <Show when={!view().drawn.length}>
              <p class="muted">No issue branches yet. They appear as soon as an agent works on an issue.</p>
            </Show>
          </>
        )}
      </Show>
    </div>
  )
}
