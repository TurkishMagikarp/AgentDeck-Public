import { createEffect, createResource, For, on, Show } from 'solid-js'
import { api } from './api'
import { ModelSelect } from './ModelSelect'
import { board, providerLabel, saveSettings } from './store'
import type { Budget } from './types'
import { formatTokens, Select, Toggle } from './ui'

type ProviderUsage = {
  provider: string
  label: string
  used: number
  cost: number
  tokens: number
  budget: Budget
  budgetLeft: number | null
  quotaLeft: number | null
  quotas: { window: string; utilization: number; resets_at: number | null }[]
  left: number
  available: boolean
  ready: boolean
  mode: 'subscription' | 'apikey'
}

type AgentUsage = {
  agent_name: string
  provider: string
  runs: number
  input: number
  cached: number
  output: number
  cost: number
  failed: number
}

type UsageData = { providers: ProviderUsage[]; byAgent: AgentUsage[] }

const WINDOWS = [
  ['5h', '5 Stunden'],
  ['day', 'Tag'],
  ['week', 'Woche'],
  ['month', 'Monat'],
] as const

const UNITS = [
  ['tokens', 'Tokens'],
  ['usd', 'US-Dollar'],
  ['runs', 'Läufe'],
] as const

const SCOPES = [
  ['global', 'alle Projekte'],
  ['project', 'nur dieses Projekt'],
] as const

export function Usage() {
  const projectId = () => board.project!.id
  const [usage, { refetch }] = createResource(projectId, (id) => api.get<UsageData>(`/projects/${id}/usage`))

  // Numbers change whenever a run ends or a budget is edited.
  createEffect(
    on([() => board.runs.length, () => JSON.stringify(board.project?.settings.budgets)], () => refetch(), {
      defer: true,
    }),
  )

  return (
    <div class="page">
      <div class="page-head">
        <div>
          <h2>Usage &amp; Routing</h2>
          <p class="muted">
            Fällt ein Anbieter unter seine Schwelle, weicht der Agent auf den nächsten in der Reihenfolge aus.
            Liegt keiner mehr darüber, pausieren die Agenten.
          </p>
        </div>
      </div>

      <div class="grid">
        <For each={usage()?.providers}>{(item) => <ProviderCard usage={item} />}</For>
      </div>

      <FallbackOrder />

      <RtkSavings />

      <h3>Verbrauch pro Agent</h3>
      <table>
        <thead>
          <tr>
            <th>Agent</th>
            <th>Anbieter</th>
            <th class="num">Läufe</th>
            <th class="num">Fehlgeschlagen</th>
            <th class="num" title="Eingabe, die nicht aus dem Cache kam, plus Ausgabe">
              Tokens neu
            </th>
            <th class="num" title="Erneut mitgeschickter Kontext, etwa ein Zehntel des Preises">
              aus dem Cache
            </th>
            <th class="num">Kosten</th>
          </tr>
        </thead>
        <tbody>
          <For
            each={usage()?.byAgent}
            fallback={
              <tr>
                <td colSpan={7} class="muted">
                  Noch keine Läufe.
                </td>
              </tr>
            }
          >
            {(row) => (
              <tr>
                <td>{row.agent_name}</td>
                <td>{providerLabel(row.provider)}</td>
                <td class="num">{row.runs}</td>
                <td class="num">{row.failed}</td>
                <td class="num">{formatTokens(row.input - row.cached + row.output)}</td>
                <td class="num">{formatTokens(row.cached)}</td>
                <td class="num">${row.cost.toFixed(2)}</td>
              </tr>
            )}
          </For>
        </tbody>
      </table>
    </div>
  )
}

function ProviderCard(props: { usage: ProviderUsage }) {
  const usage = () => props.usage
  const budget = () => usage().budget

  function setBudget<K extends keyof Budget>(key: K, value: Budget[K]) {
    saveSettings((settings) => {
      settings.budgets[usage().provider][key] = value
    })
  }

  const usedText = () => {
    if (budget().unit === 'usd') return `$${usage().cost.toFixed(2)}`
    if (budget().unit === 'runs') return `${usage().used} Läufe`
    return `${formatTokens(usage().tokens)} Tokens`
  }

  return (
    <article class="tile static">
      <div class="tile-head">
        <strong>{usage().label}</strong>
        <span class="badge" classList={{ bad: !usage().available }}>
          {!usage().ready ? 'nicht eingerichtet' : usage().available ? 'verfügbar' : 'pausiert'}
        </span>
      </div>

      <div class="meter" title={`${Math.round(usage().left)} % übrig`}>
        <div classList={{ low: !usage().available }} style={{ width: `${usage().left}%` }} />
        <span class="threshold" style={{ left: `${budget().stopAtPct}%` }} />
      </div>
      <p>
        <strong>{Math.round(usage().left)} %</strong> übrig · verbraucht {usedText()}
      </p>
      <Show when={usage().quotaLeft !== null}>
        <p class="muted">Vom CLI gemeldete Abo-Auslastung: {Math.round(100 - usage().quotaLeft!)} %</p>
      </Show>

      <div class="budget">
        <label>
          Budget
          <input
            type="number"
            min="0"
            value={budget().limit}
            onChange={(e) => setBudget('limit', Number(e.currentTarget.value))}
            title="0 = kein eigenes Budget, nur die Abo-Auslastung zählt"
          />
        </label>
        <label>
          Einheit
          <Select value={budget().unit} options={UNITS} onChange={(unit) => setBudget('unit', unit)} />
        </label>
        <label>
          Zeitraum
          <Select
            value={budget().window}
            options={WINDOWS}
            onChange={(window) => setBudget('window', window)}
          />
        </label>
        <label>
          Stopp bei % übrig
          <input
            type="number"
            min="0"
            max="100"
            value={budget().stopAtPct}
            onChange={(e) => setBudget('stopAtPct', Number(e.currentTarget.value))}
          />
        </label>
        <label>
          Zählt
          <Select value={budget().scope} options={SCOPES} onChange={(scope) => setBudget('scope', scope)} />
        </label>
      </div>
    </article>
  )
}

type Savings = { commands: number; input: number; output: number; saved: number }
type RtkReport = { installed: boolean; total: Savings; byAgent: (Savings & { agent: string })[] }

const share = (row: Savings) => (row.input ? Math.round((100 * row.saved) / row.input) : 0)

/** RTK shortens command output before the model reads it. This shows what that saved. */
function RtkSavings() {
  const projectId = () => board.project!.id
  const [report, { refetch }] = createResource(projectId, (id) => api.get<RtkReport>(`/projects/${id}/rtk`))
  createEffect(
    on(
      () => board.runs.length,
      () => refetch(),
      { defer: true },
    ),
  )

  return (
    <Show when={report()?.installed}>
      <section class="section">
        <div class="section-head">
          <h3>Ersparnis durch RTK</h3>
          <span class="muted">
            {formatTokens(report()!.total.saved)} Tokens gespart ({share(report()!.total)} %) bei{' '}
            {report()!.total.commands} Befehlen
          </span>
        </div>
        <p class="muted">
          RTK kürzt die Ausgabe von Shell-Befehlen, bevor das Modell sie liest. Gezählt wird ab dem ersten
          Lauf jedes Agenten in diesem Projekt.
        </p>
        <table>
          <thead>
            <tr>
              <th>Agent</th>
              <th class="num">Befehle</th>
              <th class="num">ohne RTK</th>
              <th class="num">mit RTK</th>
              <th class="num">gespart</th>
            </tr>
          </thead>
          <tbody>
            <For
              each={report()!.byAgent}
              fallback={
                <tr>
                  <td colSpan={5} class="muted">
                    Noch keine Befehle über RTK gelaufen.
                  </td>
                </tr>
              }
            >
              {(row) => (
                <tr>
                  <td>{row.agent}</td>
                  <td class="num">{row.commands}</td>
                  <td class="num">{formatTokens(row.input)}</td>
                  <td class="num">{formatTokens(row.output)}</td>
                  <td class="num">
                    {formatTokens(row.saved)} ({share(row)} %)
                  </td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </section>
    </Show>
  )
}

function FallbackOrder() {
  const settings = () => board.project!.settings

  function move(index: number, by: number) {
    saveSettings((s) => {
      const target = index + by
      if (target < 0 || target >= s.fallback.length) return
      ;[s.fallback[index], s.fallback[target]] = [s.fallback[target], s.fallback[index]]
    })
  }

  return (
    <section class="section">
      <div class="section-head">
        <h3>Ausweich-Reihenfolge</h3>
        <Toggle
          label="Ausweichen erlauben"
          checked={settings().fallbackEnabled}
          onChange={(on) => saveSettings((s) => void (s.fallbackEnabled = on))}
        />
      </div>
      <ol class="order">
        <For each={settings().fallback}>
          {(provider, index) => (
            <li>
              <span class="order-pos">{index() + 1}</span>
              <span class="order-name">{providerLabel(provider)}</span>
              <ModelSelect
                provider={provider}
                value={settings().fallbackModels[provider] ?? ''}
                emptyLabel="Standardmodell beim Ausweichen"
                onChange={(model) => saveSettings((s) => void (s.fallbackModels[provider] = model))}
              />
              <button
                class="ghost"
                onClick={() => move(index(), -1)}
                disabled={index() === 0}
                aria-label="Nach oben"
              >
                ↑
              </button>
              <button
                class="ghost"
                onClick={() => move(index(), 1)}
                disabled={index() === settings().fallback.length - 1}
                aria-label="Nach unten"
              >
                ↓
              </button>
            </li>
          )}
        </For>
      </ol>
    </section>
  )
}
