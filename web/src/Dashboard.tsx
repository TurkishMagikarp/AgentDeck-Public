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
}

const RANGES = [
  [7, '7 Tage'],
  [14, '14 Tage'],
  [30, '30 Tage'],
  [90, '90 Tage'],
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
          <h2>Dashboard</h2>
          <p class="muted">
            Was fertig wurde, wer wie viel verbraucht hat und wie sich das Kontingent bewegt.
          </p>
        </div>
        <div class="segmented" role="group" aria-label="Zeitraum">
          <For each={RANGES}>
            {([value, label]) => (
              <button classList={{ active: days() === value }} onClick={() => setDays(value)}>
                {label}
              </button>
            )}
          </For>
        </div>
      </div>

      <Show when={stats()} fallback={<p class="muted">Lade Zahlen…</p>}>
        {(data) => (
          <>
            <div class="stat-row">
              <Stat value={data().totals.doneToday} label="heute fertig" />
              <Stat value={data().totals.doneWeek} label="in 7 Tagen fertig" />
              <Stat value={data().totals.open} label="noch offen" />
              <Stat value={data().totals.doneAll} label="insgesamt fertig" />
              <Stat value={data().totals.runs} label={`Läufe in ${days()} Tagen`} />
              <Stat
                value={
                  data().totals.runs
                    ? `${Math.round((100 * data().totals.failedRuns) / data().totals.runs)} %`
                    : '–'
                }
                label="davon fehlgeschlagen"
              />
              <Stat value={duration(data().totals.avgRunSeconds)} label="mittlere Laufzeit" />
            </div>

            <div class="chart-grid">
              <section class="section">
                <h3>Fertige Issues pro Tag</h3>
                <Columns days={data().days} values={data().done} color="var(--series-1)" name="fertig" />
              </section>

              <section class="section">
                <h3>Offene Issues am Tagesende</h3>
                <Lines
                  days={data().days}
                  series={[{ name: 'offen', color: 'var(--series-1)', values: data().open }]}
                  label="Offene Issues am Tagesende"
                />
              </section>

              <section class="section">
                <h3>Neue Tokens pro Agent und Tag</h3>
                <p class="muted">Ohne den Anteil, der aus dem Cache kam.</p>
                <StackedColumns
                  days={data().days}
                  series={toSeries(data().freshTokens)}
                  label="Neue Tokens pro Agent und Tag"
                />
              </section>

              <section class="section">
                <h3>Läufe pro Agent und Tag</h3>
                <StackedColumns
                  days={data().days}
                  series={toSeries(data().runsPerDay)}
                  label="Läufe pro Agent und Tag"
                />
              </section>

              <section class="section wide">
                <h3>Restkontingent pro Anbieter</h3>
                <Show
                  when={data().quota.length}
                  fallback={<p class="muted">Noch keine Messwerte. Sie entstehen mit jedem Lauf.</p>}
                >
                  <p class="muted">Stand am Tagesende, in Prozent des strengsten Limits.</p>
                  <Lines
                    days={data().days}
                    series={quotaSeries()}
                    label="Restkontingent pro Anbieter"
                    max={100}
                    unit=" %"
                  />
                </Show>
              </section>
            </div>

            <h3>Agenten im Zeitraum</h3>
            <table>
              <thead>
                <tr>
                  <th>Agent</th>
                  <th class="num">Läufe</th>
                  <th class="num">Fehlgeschlagen</th>
                  <th class="num">Tokens neu</th>
                  <th class="num">aus dem Cache</th>
                  <th class="num">mittlere Laufzeit</th>
                </tr>
              </thead>
              <tbody>
                <For
                  each={data().agentTotals}
                  fallback={
                    <tr>
                      <td colSpan={6} class="muted">
                        Noch keine Läufe in diesem Zeitraum.
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
          </>
        )}
      </Show>
    </div>
  )
}

function Stat(props: { value: number | string; label: string }) {
  return (
    <div class="stat">
      <strong>{typeof props.value === 'number' ? props.value.toLocaleString('de-DE') : props.value}</strong>
      <span>{props.label}</span>
    </div>
  )
}
