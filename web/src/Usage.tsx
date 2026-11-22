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
  /** Set while the provider rests after a limit or a broken login. */
  resting: { until: number; reason: string } | null
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
  ['5h', '5 hours'],
  ['day', 'Day'],
  ['week', 'Week'],
  ['month', 'Month'],
] as const

const UNITS = [
  ['tokens', 'Tokens'],
  ['usd', 'US dollars'],
  ['runs', 'Runs'],
] as const

const SCOPES = [
  ['global', 'All projects'],
  ['project', 'This project only'],
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
            When a provider drops below its threshold, the agent falls back to the next one in the order. When
            none is left above it, the agents pause.
          </p>
        </div>
      </div>

      <div class="grid">
        <For each={usage()?.providers}>{(item) => <ProviderCard usage={item} onWake={refetch} />}</For>
      </div>

      <section class="section">
        <div class="section-head">
          <h3>Pace the quota</h3>
          <Toggle
            label="Plan by subscription window"
            checked={board.project!.settings.quotaPacing}
            onChange={(on) => saveSettings((s) => void (s.quotaPacing = on))}
          />
        </div>
        <p class="muted">
          When less than 30 % of a subscription window is left and the reset is more than three hours away,
          only one agent runs at a time and large issues wait. When the window resets within an hour with more
          than 30 % left, large issues go first. An issue is large when its previous runs used more than twice
          as much as a typical run in the project.
        </p>
      </section>

      <FallbackOrder />

      <RtkSavings />

      <h3>Usage per agent</h3>
      <table>
        <thead>
          <tr>
            <th>Agent</th>
            <th>Provider</th>
            <th class="num">Runs</th>
            <th class="num">Failed</th>
            <th class="num" title="Input that did not come from the cache, plus output">
              New tokens
            </th>
            <th class="num" title="Resent context, about a tenth of the price">
              From cache
            </th>
            <th class="num">Cost</th>
          </tr>
        </thead>
        <tbody>
          <For
            each={usage()?.byAgent}
            fallback={
              <tr>
                <td colSpan={7} class="muted">
                  No runs yet.
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

const restEnd = (at: number) =>
  new Date(at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })

function ProviderCard(props: { usage: ProviderUsage; onWake: () => void }) {
  const usage = () => props.usage
  const budget = () => usage().budget

  function setBudget<K extends keyof Budget>(key: K, value: Budget[K]) {
    saveSettings((settings) => {
      settings.budgets[usage().provider][key] = value
    })
  }

  const usedText = () => {
    if (budget().unit === 'usd') return `$${usage().cost.toFixed(2)}`
    if (budget().unit === 'runs') return `${usage().used} ${usage().used === 1 ? 'run' : 'runs'}`
    return `${formatTokens(usage().tokens)} tokens`
  }

  return (
    <article class="tile static">
      <div class="tile-head">
        <strong>{usage().label}</strong>
        <span class="badge" classList={{ bad: !usage().available }}>
          {!usage().ready ? 'Not set up' : usage().available ? 'Available' : 'Paused'}
        </span>
      </div>

      <div class="meter" title={`${Math.round(usage().left)}% left`}>
        <div classList={{ low: !usage().available }} style={{ width: `${usage().left}%` }} />
        <span class="threshold" style={{ left: `${budget().stopAtPct}%` }} />
      </div>
      <p>
        <strong>{Math.round(usage().left)}%</strong> left · used {usedText()}
      </p>
      <Show when={usage().resting}>
        {(rest) => (
          <p class="resting">
            {rest().reason}, paused until {restEnd(rest().until)}.{' '}
            <button
              class="link"
              onClick={() => api.post(`/providers/${usage().provider}/wake`).then(props.onWake)}
            >
              Release now
            </button>
          </p>
        )}
      </Show>
      <Show when={usage().quotaLeft !== null}>
        <p class="muted">
          Subscription quota used, as reported by the CLI: {Math.round(100 - usage().quotaLeft!)}%
        </p>
      </Show>

      <div class="budget">
        <label>
          Budget
          <input
            type="number"
            min="0"
            value={budget().limit}
            onChange={(e) => setBudget('limit', Number(e.currentTarget.value))}
            title="0 = no budget of its own, only the subscription quota counts"
          />
        </label>
        <label>
          Unit
          <Select value={budget().unit} options={UNITS} onChange={(unit) => setBudget('unit', unit)} />
        </label>
        <label>
          Period
          <Select
            value={budget().window}
            options={WINDOWS}
            onChange={(window) => setBudget('window', window)}
          />
        </label>
        <label>
          Stop at % left
          <input
            type="number"
            min="0"
            max="100"
            value={budget().stopAtPct}
            onChange={(e) => setBudget('stopAtPct', Number(e.currentTarget.value))}
          />
        </label>
        <label>
          Counts
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
          <h3>RTK savings</h3>
          <span class="muted">
            {formatTokens(report()!.total.saved)} tokens saved ({share(report()!.total)}%) across{' '}
            {report()!.total.commands} {report()!.total.commands === 1 ? 'command' : 'commands'}
          </span>
        </div>
        <p class="muted">
          RTK shortens shell command output before the model reads it. Counting starts with each agent's first
          run in this project.
        </p>
        <table>
          <thead>
            <tr>
              <th>Agent</th>
              <th class="num">Commands</th>
              <th class="num">Without RTK</th>
              <th class="num">With RTK</th>
              <th class="num">Saved</th>
            </tr>
          </thead>
          <tbody>
            <For
              each={report()!.byAgent}
              fallback={
                <tr>
                  <td colSpan={5} class="muted">
                    No commands have gone through RTK yet.
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
                    {formatTokens(row.saved)} ({share(row)}%)
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
        <h3>Fallback order</h3>
        <Toggle
          label="Allow fallback"
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
                emptyLabel="Default model on fallback"
                onChange={(model) => saveSettings((s) => void (s.fallbackModels[provider] = model))}
              />
              <button
                class="ghost"
                onClick={() => move(index(), -1)}
                disabled={index() === 0}
                aria-label="Move up"
              >
                ↑
              </button>
              <button
                class="ghost"
                onClick={() => move(index(), 1)}
                disabled={index() === settings().fallback.length - 1}
                aria-label="Move down"
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
