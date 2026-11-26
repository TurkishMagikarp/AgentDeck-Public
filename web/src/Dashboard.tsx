import { createEffect, createMemo, createResource, createSignal, For, on, Show } from 'solid-js'
import { api } from './api'
import { Columns, compact, Lines, StackedColumns, type Series } from './charts'
import { locale, t } from './i18n'
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
  agentModels: {
    agent: string
    provider: string
    label: string
    model: string
    runs: number
    failed: number
    fresh: number
    cached: number
    cost: number
    avgMs: number
  }[]
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

const percent = (rate: number | null) => (rate === null ? '–' : `${Math.round(rate * 100)} %`)
const dollars = (value: number | null) => (value === null ? '–' : `$${value.toFixed(2)}`)

// The labels are German keys, translated where they are rendered.
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

const isoDay = (date: Date) => {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}
const daysAgo = (count: number) => {
  const date = new Date()
  date.setDate(date.getDate() - count)
  return isoDay(date)
}
// 26.11.2026 in German, 26 Nov 2026 in English.
const formatDay = (iso: string) => {
  const [year, month, day] = iso.split('-').map(Number)
  const date = new Date(year, month - 1, day)
  return locale().startsWith('de')
    ? date.toLocaleDateString(locale(), { day: '2-digit', month: '2-digit', year: 'numeric' })
    : date.toLocaleDateString(locale(), { day: 'numeric', month: 'short', year: 'numeric' })
}

const duration = (seconds: number) =>
  seconds >= 90 ? `${Math.round(seconds / 60)} min` : `${Math.round(seconds)} s`

export function Dashboard() {
  const [days, setDays] = createSignal(14)
  // A custom range replaces the presets until one of them is clicked again.
  const [custom, setCustom] = createSignal<{ from: string; to: string } | null>(null)
  const [draft, setDraft] = createSignal({ from: daysAgo(29), to: daysAgo(0) })
  const rangeError = () => {
    const { from, to } = draft()
    if (!from || !to) return t('Anfang und Ende wählen.')
    if (to < from) return t('Das Ende liegt vor dem Anfang.')
    if ((Date.parse(to) - Date.parse(from)) / 86_400_000 >= 366) return t('Höchstens 366 Tage.')
    return ''
  }
  const source = () => ({ id: board.project!.id, days: days(), custom: custom() })
  const [stats, { refetch }] = createResource(source, ({ id, days, custom }) =>
    api.get<Stats>(
      custom
        ? `/projects/${id}/stats?from=${custom.from}&to=${custom.to}`
        : `/projects/${id}/stats?days=${days}`,
    ),
  )
  const rangeDays = () => stats()?.days.length ?? days()
  // Models of one agent, for the split rows under it.
  const modelsOf = (agent: string) => (stats()?.agentModels ?? []).filter((row) => row.agent === agent)
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
          <h2>{t('Statistiken')}</h2>
          <p class="muted">
            {t('Was fertig wurde, wer wie viel verbraucht hat und wie sich das Kontingent bewegt.')}
          </p>
        </div>
        <div class="segmented" role="group" aria-label={t('Zeitraum')}>
          <For each={RANGES}>
            {([value, label]) => (
              <button
                classList={{ active: !custom() && days() === value }}
                onClick={() => {
                  setCustom(null)
                  setDays(value)
                }}
              >
                {t(label)}
              </button>
            )}
          </For>
        </div>
      </div>

      <form
        class="range-form"
        onSubmit={(event) => {
          event.preventDefault()
          if (!rangeError()) setCustom({ ...draft() })
        }}
      >
        <label>
          {t('Von')}
          <input
            type="date"
            value={draft().from}
            max={draft().to || undefined}
            onInput={(event) => setDraft({ ...draft(), from: event.currentTarget.value })}
          />
        </label>
        <label>
          {t('Bis')}
          <input
            type="date"
            value={draft().to}
            min={draft().from || undefined}
            onInput={(event) => setDraft({ ...draft(), to: event.currentTarget.value })}
          />
        </label>
        <button type="submit" disabled={!!rangeError()} classList={{ active: !!custom() }}>
          {t('Zeitraum anzeigen')}
        </button>
        <Show when={custom()}>
          {(range) => (
            <span class="muted">
              {t('{from} bis {to}', { from: formatDay(range().from), to: formatDay(range().to) })}
            </span>
          )}
        </Show>
        <Show when={rangeError()}>
          <span class="muted" role="alert">
            {rangeError()}
          </span>
        </Show>
      </form>

      <Show when={stats()} fallback={<p class="muted">{t('Lade Zahlen…')}</p>}>
        {(data) => (
          <>
            <div class="stat-row">
              <Stat value={data().totals.doneToday} label={t('heute fertig')} />
              <Stat value={data().totals.doneWeek} label={t('in 7 Tagen fertig')} />
              <Stat value={data().totals.open} label={t('noch offen')} />
              <Stat value={data().totals.doneAll} label={t('insgesamt fertig')} />
              <Stat value={data().totals.runs} label={t('Läufe in {n} Tagen', { n: rangeDays() })} />
              <Stat
                value={
                  data().totals.runs
                    ? `${Math.round((100 * data().totals.failedRuns) / data().totals.runs)} %`
                    : '–'
                }
                label={t('davon fehlgeschlagen')}
              />
              <Stat value={duration(data().totals.avgRunSeconds)} label={t('mittlere Laufzeit')} />
            </div>

            <div class="chart-grid">
              <section class="section">
                <h3>{t('Fertige Issues pro Tag')}</h3>
                <Columns days={data().days} values={data().done} color="var(--series-1)" name={t('fertig')} />
              </section>

              <section class="section">
                <h3>{t('Offene Issues am Tagesende')}</h3>
                <Lines
                  days={data().days}
                  series={[{ name: t('offen'), color: 'var(--series-1)', values: data().open }]}
                  label={t('Offene Issues am Tagesende')}
                />
              </section>

              <section class="section">
                <h3>{t('Neue Tokens pro Agent und Tag')}</h3>
                <p class="muted">{t('Ohne den Anteil, der aus dem Cache kam.')}</p>
                <StackedColumns
                  days={data().days}
                  series={toSeries(data().freshTokens)}
                  label={t('Neue Tokens pro Agent und Tag')}
                />
              </section>

              <section class="section">
                <h3>{t('Läufe pro Agent und Tag')}</h3>
                <StackedColumns
                  days={data().days}
                  series={toSeries(data().runsPerDay)}
                  label={t('Läufe pro Agent und Tag')}
                />
              </section>

              <section class="section wide">
                <h3>{t('Restkontingent pro Anbieter')}</h3>
                <Show
                  when={data().quota.length}
                  fallback={<p class="muted">{t('Noch keine Messwerte. Sie entstehen mit jedem Lauf.')}</p>}
                >
                  <p class="muted">{t('Stand am Tagesende, in Prozent des strengsten Limits.')}</p>
                  <Lines
                    days={data().days}
                    series={quotaSeries()}
                    label={t('Restkontingent pro Anbieter')}
                    max={100}
                    unit=" %"
                  />
                </Show>
              </section>
            </div>

            <h3>{t('Agenten im Zeitraum')}</h3>
            <table>
              <thead>
                <tr>
                  <th>{t('Agent')}</th>
                  <th>{t('Modell')}</th>
                  <th class="num">{t('Läufe')}</th>
                  <th class="num">{t('Fehlgeschlagen')}</th>
                  <th class="num">{t('Tokens neu')}</th>
                  <th class="num">{t('aus dem Cache')}</th>
                  <th class="num">{t('Kosten')}</th>
                  <th class="num">{t('mittlere Laufzeit')}</th>
                </tr>
              </thead>
              <tbody>
                <For
                  each={data().agentTotals}
                  fallback={
                    <tr>
                      <td colSpan={8} class="muted">
                        {t('Noch keine Läufe in diesem Zeitraum.')}
                      </td>
                    </tr>
                  }
                >
                  {(row) => (
                    <>
                      <tr class="agent-total">
                        <td>
                          <span class="key" style={{ background: colorOf()(row.agent) }} /> {row.agent}
                        </td>
                        <td class="muted">
                          {modelsOf(row.agent).length === 1
                            ? `${modelsOf(row.agent)[0].label} · ${modelsOf(row.agent)[0].model}`
                            : t('{n} Modelle', { n: modelsOf(row.agent).length })}
                        </td>
                        <td class="num">{row.runs}</td>
                        <td class="num">{row.failed}</td>
                        <td class="num">{compact(row.fresh)}</td>
                        <td class="num">{compact(row.cached)}</td>
                        <td class="num">{dollars(row.cost)}</td>
                        <td class="num">{duration(row.avgMs / 1000)}</td>
                      </tr>
                      <Show when={modelsOf(row.agent).length > 1}>
                        <For each={modelsOf(row.agent)}>
                          {(model) => (
                            <tr class="agent-model">
                              <td />
                              <td>
                                {model.label} · <span class="mono">{model.model}</span>
                              </td>
                              <td class="num">{model.runs}</td>
                              <td class="num">{model.failed}</td>
                              <td class="num">{compact(model.fresh)}</td>
                              <td class="num">{compact(model.cached)}</td>
                              <td class="num">{dollars(model.cost)}</td>
                              <td class="num">{duration(model.avgMs / 1000)}</td>
                            </tr>
                          )}
                        </For>
                      </Show>
                    </>
                  )}
                </For>
              </tbody>
            </table>

            <h3>{t('Ergebnisse pro Agent')}</h3>
            <p class="muted">
              {t('Gelandet: Issues, die der Agent gebaut hat und die im Zeitraum fertig wurden. Freigabequote: wie oft ein Prüfer seine Arbeit freigab, statt Änderungen zu verlangen.')}
            </p>
            <table>
              <thead>
                <tr>
                  <th>{t('Agent')}</th>
                  <th class="num">{t('Gelandet')}</th>
                  <th class="num">{t('Freigabequote')}</th>
                  <th class="num">{t('Kosten pro gelandetem Issue')}</th>
                </tr>
              </thead>
              <tbody>
                <For
                  each={data().outcomeByAgent}
                  fallback={
                    <tr>
                      <td colSpan={4} class="muted">
                        {t('Noch nichts gelandet oder geprüft.')}
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

            <h3>{t('Anbieter im Vergleich')}</h3>
            <div class="provider-compare">
              <For each={data().outcomeByProvider} fallback={<p class="muted">{t('Keine Läufe im Zeitraum.')}</p>}>
                {(row) => (
                  <article class="provider-card">
                    <header>{row.label}</header>
                    <div class="usable-ring" style={{ '--value': `${Math.round(row.usableRate * 100)}%` }}>
                      <span>{percent(row.usableRate)}</span>
                    </div>
                    <dl>
                      <dt>{t('Läufe')}</dt>
                      <dd>{row.runs}</dd>
                      <dt>{t('pro Lauf')}</dt>
                      <dd>{dollars(row.costPerRun)}</dd>
                      <dt>{t('Dauer')}</dt>
                      <dd>{Math.round(row.avgMs / 60000)} min</dd>
                    </dl>
                  </article>
                )}
              </For>
            </div>

            <h3>{t('Ergebnisse pro Modell')}</h3>
            <p class="muted">
              {t('Brauchbar: Der Lauf hat ein Ergebnis, eine Übergabe oder ein Urteil abgeliefert.')}
            </p>
            <table>
              <thead>
                <tr>
                  <th>{t('Anbieter')}</th>
                  <th>{t('Modell')}</th>
                  <th class="num">{t('Läufe')}</th>
                  <th class="num">{t('Fehlgeschlagen')}</th>
                  <th class="num">{t('Brauchbar')}</th>
                  <th class="num">{t('Kosten pro Lauf')}</th>
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
      <strong>{typeof props.value === 'number' ? props.value.toLocaleString(locale()) : props.value}</strong>
      <span>{props.label}</span>
    </div>
  )
}
