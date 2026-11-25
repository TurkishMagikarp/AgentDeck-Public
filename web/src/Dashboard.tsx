import { createEffect, createMemo, createResource, createSignal, For, on, Show } from 'solid-js'
import { api } from './api'
import { Columns, compact, Lines, StackedColumns, type Series } from './charts'
import { board } from './store'

type AgentSeries = { agent: string; values: number[] }

type Stats = {
  days: string[]
  totals: {
    doneToday: number
    doneWeek: number
    doneAll: number
    open: number
    runs: number
    failedRuns: number
    avgRunSeconds: number
  }
  done: number[]
  created: number[]
  open: number[]
  freshTokens: AgentSeries[]
  runsPerDay: AgentSeries[]
  agentTotals: {
    agent: string
    runs: number
    failed: number
    fresh: number
    cached: number
    cost: number
    avgMs: number
  }[]
  quota: { provider: string; label: string; values: (number | null)[] }[]
  outcomeByAgent: {
    agent: string
    landed: number
    approvalRate: number | null
    costPerLanded: number | null
  }[]
  outcomeByModel: {
    provider: string
    label: string
    model: string
    runs: number
    failed: number
    usableRate: number
    costPerRun: number
  }[]
  outcomeByProvider: {
    provider: string
    label: string
    runs: number
    usableRate: number
    costPerRun: number
    avgMs: number
  }[]
}

const percent = (rate: number | null) => (rate === null ? '–' : `${Math.round(rate * 100)}%`)
const dollars = (value: number | null) => (value === null ? '–' : `$${value.toFixed(2)}`)

const RANGES = [
  [7, '7 days'],
  [14, '14 days'],
  [30, '30 days'],
  [90, '90 days'],
] as const

// Categorical slots in fixed order. A colour belongs to an agent, not to its rank in a chart:
// agents are numbered by their order in the project, so they keep their colour in every chart.
const SLOTS = [1, 2, 3, 4, 5, 6].map((slot) => `var(--series-${slot})`)
const OTHER = 'var(--muted)'

const duration = (seconds: number) =>
  seconds >= 90 ? `${Math.round(seconds / 60)} min` : `${Math.round(seconds)} s`

export function Dashboard() {
  const [days, setDays] = createSignal(14)
  const source = () => ({ id: board.project!.id, days: days() })
  const [stats, { refetch }] = createResource(source, ({ id, days }) =>
    api.get<Stats>(`/projects/${id}/stats?days=${days}`),
  )
  // A finished run changes almost every number on this page.
  createEffect(
    on(
      () => board.runs.length,
      () => refetch(),
      { defer: true },
    ),
  )

  const colorOf = createMemo(() => {
    const colors = new Map<string, string>()
    board.agents.forEach((agent, index) => colors.set(agent.name, SLOTS[index] ?? OTHER))
    return (agent: string) => colors.get(agent) ?? OTHER
  })
  // Stacks follow the order of the agents in the project, the same order the colours come from.
  const position = (agent: string) => {
    const index = board.agents.findIndex((candidate) => candidate.name === agent)
    return index === -1 ? board.agents.length : index
  }
  const toSeries = (rows: AgentSeries[]): Series[] =>
    [...rows]
      .sort((a, b) => position(a.agent) - position(b.agent))
      .map((row) => ({ name: row.agent, color: colorOf()(row.agent), values: row.values }))

  const quotaSeries = (): Series[] =>
    (stats()?.quota ?? []).map((series, index) => ({
      name: series.label,
      color: SLOTS[index] ?? OTHER,
      values: series.values,
    }))

  return (
    <div class="page">
      <div class="page-head">
        <div>
          <h2>Statistics</h2>
          <p class="muted">
            What got done, who used how much and how the quota moves.
          </p>
        </div>
        <div class="segmented" role="group" aria-label="Time range">
          <For each={RANGES}>
            {([value, label]) => (
              <button classList={{ active: days() === value }} onClick={() => setDays(value)}>
                {label}
              </button>
            )}
          </For>
        </div>
      </div>

      <Show when={stats()} fallback={<p class="muted">Loading numbers…</p>}>
        {(data) => (
          <>
            <div class="stat-row">
              <Stat value={data().totals.doneToday} label="Done today" />
              <Stat value={data().totals.doneWeek} label="Done in 7 days" />
              <Stat value={data().totals.open} label="Still open" />
              <Stat value={data().totals.doneAll} label="Done in total" />
              <Stat value={data().totals.runs} label={`Runs in ${days()} days`} />
              <Stat
                value={
                  data().totals.runs
                    ? `${Math.round((100 * data().totals.failedRuns) / data().totals.runs)} %`
                    : '–'
                }
                label="Of those failed"
              />
              <Stat value={duration(data().totals.avgRunSeconds)} label="Average run time" />
            </div>

            <div class="chart-grid">
              <section class="section">
                <h3>Issues done per day</h3>
                <Columns days={data().days} values={data().done} color="var(--series-1)" name="done" />
              </section>

              <section class="section">
                <h3>Open issues at end of day</h3>
                <Lines
                  days={data().days}
                  series={[{ name: 'open', color: 'var(--series-1)', values: data().open }]}
                  label="Open issues at end of day"
                />
              </section>

              <section class="section">
                <h3>New tokens per agent and day</h3>
                <p class="muted">Without the share that came from the cache.</p>
                <StackedColumns
                  days={data().days}
                  series={toSeries(data().freshTokens)}
                  label="New tokens per agent and day"
                />
              </section>

              <section class="section">
                <h3>Runs per agent and day</h3>
                <StackedColumns
                  days={data().days}
                  series={toSeries(data().runsPerDay)}
                  label="Runs per agent and day"
                />
              </section>

              <section class="section wide">
                <h3>Remaining quota per provider</h3>
                <Show
                  when={data().quota.length}
                  fallback={<p class="muted">No data yet. Every run adds a reading.</p>}
                >
                  <p class="muted">At end of day, as a percentage of the strictest limit.</p>
                  <Lines
                    days={data().days}
                    series={quotaSeries()}
                    label="Remaining quota per provider"
                    max={100}
                    unit=" %"
                  />
                </Show>
              </section>
            </div>

            <h3>Agents in this period</h3>
            <table>
              <thead>
                <tr>
                  <th>Agent</th>
                  <th class="num">Runs</th>
                  <th class="num">Failed</th>
                  <th class="num">New tokens</th>
                  <th class="num">From cache</th>
                  <th class="num">Average run time</th>
                </tr>
              </thead>
              <tbody>
                <For
                  each={data().agentTotals}
                  fallback={
                    <tr>
                      <td colSpan={6} class="muted">
                        No runs in this period yet.
                      </td>
                    </tr>
                  }
                >
                  {(row) => (
                    <tr>
                      <td>
                        <span class="key" style={{ background: colorOf()(row.agent) }} /> {row.agent}
                      </td>
                      <td class="num">{row.runs}</td>
                      <td class="num">{row.failed}</td>
                      <td class="num">{compact(row.fresh)}</td>
                      <td class="num">{compact(row.cached)}</td>
                      <td class="num">{duration(row.avgMs / 1000)}</td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>

            <h3>Outcomes per agent</h3>
            <p class="muted">
              Landed: issues the agent built that were finished in this period. Approval rate: how often a
              reviewer approved its work instead of asking for changes.
            </p>
            <table>
              <thead>
                <tr>
                  <th>Agent</th>
                  <th class="num">Landed</th>
                  <th class="num">Approval rate</th>
                  <th class="num">Cost per landed issue</th>
                </tr>
              </thead>
              <tbody>
                <For
                  each={data().outcomeByAgent}
                  fallback={
                    <tr>
                      <td colSpan={4} class="muted">
                        Nothing landed or reviewed yet.
                      </td>
                    </tr>
                  }
                >
                  {(row) => (
                    <tr>
                      <td>
                        <span class="key" style={{ background: colorOf()(row.agent) }} /> {row.agent}
                      </td>
                      <td class="num">{row.landed}</td>
                      <td class="num">{percent(row.approvalRate)}</td>
                      <td class="num">{dollars(row.costPerLanded)}</td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>

            <h3>Providers compared</h3>
            <div class="provider-compare">
              <For each={data().outcomeByProvider} fallback={<p class="muted">No runs in this period.</p>}>
                {(row) => (
                  <article class="provider-card">
                    <header>{row.label}</header>
                    <div class="usable-ring" style={{ '--value': `${Math.round(row.usableRate * 100)}%` }}>
                      <span>{percent(row.usableRate)}</span>
                    </div>
                    <dl>
                      <dt>Runs</dt>
                      <dd>{row.runs}</dd>
                      <dt>Per run</dt>
                      <dd>{dollars(row.costPerRun)}</dd>
                      <dt>Duration</dt>
                      <dd>{Math.round(row.avgMs / 60000)} min</dd>
                    </dl>
                  </article>
                )}
              </For>
            </div>

            <h3>Outcomes per model</h3>
            <p class="muted">
              Usable: the run delivered a result, a handoff or a verdict.
            </p>
            <table>
              <thead>
                <tr>
                  <th>Provider</th>
                  <th>Model</th>
                  <th class="num">Runs</th>
                  <th class="num">Failed</th>
                  <th class="num">Usable</th>
                  <th class="num">Cost per run</th>
                </tr>
              </thead>
              <tbody>
                <For each={data().outcomeByModel}>
                  {(row) => (
                    <tr>
                      <td>{row.label}</td>
                      <td class="mono">{row.model}</td>
                      <td class="num">{row.runs}</td>
                      <td class="num">{row.failed}</td>
                      <td class="num">{percent(row.usableRate)}</td>
                      <td class="num">{dollars(row.costPerRun)}</td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </>
        )}
      </Show>
    </div>
  )
}

function Stat(props: { value: number | string; label: string }) {
  return (
    <div classList={{ stat: true, zero: props.value === 0 || props.value === '0 %' }}>
      <strong>{typeof props.value === 'number' ? props.value.toLocaleString('en-US') : props.value}</strong>
      <span>{props.label}</span>
    </div>
  )
}
