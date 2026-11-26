import { createEffect, createResource, For, on, onCleanup, Show } from 'solid-js'
import { api } from './api'
import { ModelSelect } from './ModelSelect'
import { board, providerLabel, saveSettings } from './store'
import { TIER_LABEL, TIERS, type Budget } from './types'
import { formatTokens, Select, Toggle } from './ui'
import { locale, t } from './i18n'

type ProviderUsage = {
  provider: string
  label: string
  used: number
  cost: number
  tokens: number
  budget: Budget
  budgetLeft: number | null
  quotaLeft: number | null
  quotas: { window: string; utilization: number; updated_at: number; stale: boolean; active: boolean }[]
  left: number
  available: boolean
  /** Set while the provider rests after a limit or a broken login. */
  resting: { until: number; reason: string } | null
  resets: { available: number; enabled: boolean } | null
  ready: boolean
  unsupported: boolean
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
  ['5h', t('5 Stunden')],
  ['day', 'Tag'],
  ['week', t('Woche')],
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

/** Option labels stay German in the constants; they are translated where the select renders. */
const tr = <T extends string>(options: readonly (readonly [T, string])[]) =>
  options.map(([value, label]) => [value, t(label)] as const)

export function Usage() {
  const projectId = () => board.project!.id
  const [usage, { refetch }] = createResource(projectId, (id) => api.get<UsageData>(`/projects/${id}/usage`))

  // The server polls quotas even when there are no runs. Refresh open boards as well.
  const timer = setInterval(() => { if (document.visibilityState === 'visible') void refetch() }, 30_000)
  const onVisible = () => { if (document.visibilityState === 'visible') void refetch() }
  document.addEventListener('visibilitychange', onVisible)
  onCleanup(() => {
    clearInterval(timer)
    document.removeEventListener('visibilitychange', onVisible)
  })
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
            {t('Fällt ein Anbieter unter seine Schwelle, weicht der Agent auf den nächsten in der Reihenfolge aus. Liegt keiner mehr darüber, pausieren die Agenten.')}
          </p>
        </div>
      </div>

      <div class="grid">
        <For each={usage()?.providers.map((item) => item.provider)}>
          {(id) => <ProviderCard usage={usage()!.providers.find((item) => item.provider === id)!} onWake={refetch} />}
        </For>
      </div>

      <section class="section">
        <div class="section-head">
          <h3>{t('Kontingent einteilen')}</h3>
          <Toggle
            label={t('Nach Abo-Fenster planen')}
            checked={board.project!.settings.quotaPacing}
            onChange={(on) => saveSettings((s) => void (s.quotaPacing = on))}
          />
        </div>
        <p class="muted">
          {t('Gespart wird nicht: Agenten laufen voll, bis die Stopp-Schwelle des Anbieters erreicht ist. Setzt sich ein Abo-Fenster innerhalb einer Stunde mit mehr als 30 % Rest zurück, kommen große Issues zuerst dran. Groß ist ein Issue, dessen bisherige Läufe mehr als doppelt so viel verbraucht haben wie ein üblicher Lauf im Projekt.')}
        </p>
      </section>

      <FallbackOrder />

      <ModelTiersTable />

      <RtkSavings />

      <h3>{t('Verbrauch pro Agent')}</h3>
      <table>
        <thead>
          <tr>
            <th>Agent</th>
            <th>{t('Anbieter')}</th>
            <th class="num">{t('Läufe')}</th>
            <th class="num">{t('Fehlgeschlagen')}</th>
            <th class="num" title={t('Eingabe, die nicht aus dem Cache kam, plus Ausgabe')}>
              {t('Tokens neu')}
            </th>
            <th class="num" title={t('Erneut mitgeschickter Kontext, etwa ein Zehntel des Preises')}>
              {t('aus dem Cache')}
            </th>
            <th class="num">{t('Kosten')}</th>
          </tr>
        </thead>
        <tbody>
          <For
            each={usage()?.byAgent}
            fallback={
              <tr>
                <td colSpan={7} class="muted">
                  {t('Noch keine Läufe.')}
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

/** "seven_day" and "seven_day_fable" as Claude reports them, in words. */
function windowLabel(window: string) {
  const model = window.match(/^(?:seven_day|five_hour)_(.+)$/)?.[1]
  const base = window.startsWith('five_hour')
    ? t('5 Stunden')
    : window.startsWith('seven_day')
      ? t('Woche')
      : window
  return model ? `${base} ${model[0].toUpperCase()}${model.slice(1)}` : base
}

const restEnd = (at: number) =>
  new Date(at).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' })

function ProviderCard(props: { usage: ProviderUsage; onWake: () => void }) {
  const usage = () => props.usage
  const budget = () => usage().budget
  const knownLeft = () => usage().quotaLeft != null || usage().budgetLeft != null

  function setBudget<K extends keyof Budget>(key: K, value: Budget[K]) {
    saveSettings((settings) => {
      settings.budgets[usage().provider][key] = value
    })
  }

  const usedText = () => {
    if (budget().unit === 'usd') return `$${usage().cost.toFixed(2)}`
    if (budget().unit === 'runs') return usage().used === 1 ? t('1 Lauf') : t('{n} Läufe', { n: usage().used })
    return t('{n} Tokens', { n: formatTokens(usage().tokens) })
  }

  return (
    <article class="tile static">
      <div class="tile-head">
        <strong>{usage().label}</strong>
        <span class="badge" classList={{ bad: !usage().available }}>
          {usage().unsupported ? t('deaktiviert') : !usage().ready ? t('nicht eingerichtet') : usage().available ? t('verfügbar') : t('pausiert')}
        </span>
      </div>

      <Show when={knownLeft()}>
        <div class="meter" title={t('{n} % übrig', { n: Math.round(usage().left) })}>
          <div classList={{ low: !usage().available }} style={{ width: `${usage().left}%` }} />
          <span class="threshold" style={{ left: `${budget().stopAtPct}%` }} />
        </div>
      </Show>
      <p>
        <Show when={knownLeft()}>
          <strong>{Math.round(usage().left)} %</strong> {t('übrig')}
          {usage().quotaLeft == null ? ` ${t('im eigenen Budget')}` : ''} ·{' '}
        </Show>
        {t('Verbrauch')} {usedText()}
      </p>
      <Show when={usage().mode === 'subscription' && usage().quotaLeft == null}>
        <p class="muted">{t('Abo-Restkontingent unbekannt.')}</p>
      </Show>
      <Show when={usage().resting}>
        {(rest) => (
          <p class="resting">
            {t('{reason}, pausiert bis {time}.', { reason: rest().reason, time: restEnd(rest().until) })}{' '}
            <button
              class="link"
              onClick={() => api.post(`/providers/${usage().provider}/wake`).then(props.onWake)}
            >
              {t('Jetzt freigeben')}
            </button>
          </p>
        )}
      </Show>
      <Show when={usage().quotas.length}>
        <p class="muted">
          {t('Abo-Auslastung:')}{' '}
          {usage()
            .quotas.map((q) => `${windowLabel(q.window)} ${Math.round(q.utilization * 100)} %${
              q.stale ? (q.active ? ` (${t('letzter bekannter Wert')})` : ` (${t('veraltet, zählt nicht')})`) : ''
            }`)
            .join(' · ')}
        </p>
      </Show>

      <Show when={usage().resets}>
        {(resets) => (
          <div class="resets">
            <span class="muted">
              {t('Limit-Resets verfügbar:')} <strong>{resets().available}</strong>
            </span>
            <Toggle
              label={t('Automatisch einlösen')}
              checked={resets().enabled}
              onChange={(on) =>
                api.put(`/providers/${usage().provider}/resets`, { enabled: on }).then(props.onWake)
              }
            />
          </div>
        )}
      </Show>

      <div class="budget">
        <label>
          {t('Budget')}
          <input
            type="number"
            min="0"
            value={budget().limit}
            onChange={(e) => setBudget('limit', Number(e.currentTarget.value))}
            title={t('0 = kein eigenes Budget, nur die Abo-Auslastung zählt')}
          />
        </label>
        <label>
          {t('Einheit')}
          <Select value={budget().unit} options={tr(UNITS)} onChange={(unit) => setBudget('unit', unit)} />
        </label>
        <label>
          {t('Zeitraum')}
          <Select
            value={budget().window}
            options={tr(WINDOWS)}
            onChange={(window) => setBudget('window', window)}
          />
        </label>
        <label>
          {t('Stopp bei % übrig')}
          <input
            type="number"
            min="0"
            max="100"
            value={budget().stopAtPct}
            onChange={(e) => setBudget('stopAtPct', Number(e.currentTarget.value))}
          />
        </label>
        <label>
          {t('Zählt')}
          <Select value={budget().scope} options={tr(SCOPES)} onChange={(scope) => setBudget('scope', scope)} />
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
          <h3>{t('Ersparnis durch RTK')}</h3>
          <span class="muted">
            {t('{tokens} Tokens gespart ({pct} %) bei {commands} Befehlen', {
              tokens: formatTokens(report()!.total.saved),
              pct: share(report()!.total),
              commands: report()!.total.commands,
            })}
          </span>
        </div>
        <p class="muted">
          {t('RTK kürzt die Ausgabe von Shell-Befehlen, bevor das Modell sie liest. Gezählt wird ab dem ersten Lauf jedes Agenten in diesem Projekt.')}
        </p>
        <table>
          <thead>
            <tr>
              <th>Agent</th>
              <th class="num">{t('Befehle')}</th>
              <th class="num">{t('ohne RTK')}</th>
              <th class="num">{t('mit RTK')}</th>
              <th class="num">{t('gespart')}</th>
            </tr>
          </thead>
          <tbody>
            <For
              each={report()!.byAgent}
              fallback={
                <tr>
                  <td colSpan={5} class="muted">
                    {t('Noch keine Befehle über RTK gelaufen.')}
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

/**
 * Which model of each provider counts as strong, medium or light. Fallback and "Anbieter wechseln"
 * use it to give an agent the same kind of model on the other provider.
 */
function ModelTiersTable() {
  const settings = () => board.project!.settings

  return (
    <section class="section">
      <div class="section-head">
        <h3>{t('Modell-Stufen')}</h3>
      </div>
      <p class="muted">
        {t('Beim Ausweichen und beim Anbieterwechsel bekommt jeder Agent das Modell seiner Stufe beim neuen Anbieter. Leer heißt: Standard des Anbieters.')}
      </p>
      <div class="table-scroll">
        <table class="tiers">
          <thead>
            <tr>
              <th>{t('Anbieter')}</th>
              <For each={TIERS}>{(tier) => <th>{t(TIER_LABEL[tier])}</th>}</For>
            </tr>
          </thead>
          <tbody>
            <For each={settings().fallback}>
              {(provider) => (
                <tr>
                  <td>{providerLabel(provider)}</td>
                  <For each={TIERS}>
                    {(tier) => (
                      <td>
                        <ModelSelect
                          provider={provider}
                          value={settings().modelTiers[tier][provider] ?? ''}
                          onChange={(model) =>
                            saveSettings((s) => void (s.modelTiers[tier][provider] = model))
                          }
                        />
                      </td>
                    )}
                  </For>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </div>
    </section>
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
        <h3>{t('Anbieter-Reihenfolge')}</h3>
        <Toggle
          label={t('Overrides dürfen ausweichen')}
          checked={settings().fallbackEnabled}
          onChange={(on) => saveSettings((s) => void (s.fallbackEnabled = on))}
        />
      </div>
      <p class="muted">
        {t('Ohne Agenten-Override startet die Suche hier ganz oben, auch bei Prüfungen. Es gilt der Stoppwert des jeweiligen Anbieters. Das Modell folgt der Modell-Stufe des Agenten.')}
      </p>
      <ol class="order">
        <For each={settings().fallback}>
          {(provider, index) => (
            <li>
              <span class="order-pos">{index() + 1}</span>
              <span class="order-name">{providerLabel(provider)}</span>
              <button
                class="ghost"
                onClick={() => move(index(), -1)}
                disabled={index() === 0}
                aria-label={t('Nach oben')}
              >
                ↑
              </button>
              <button
                class="ghost"
                onClick={() => move(index(), 1)}
                disabled={index() === settings().fallback.length - 1}
                aria-label={t('Nach unten')}
              >
                ↓
              </button>
            </li>
          )}
        </For>
      </ol>
      <div class="budget">
        <label>
          {t('Reserve beim Ausweichen eines Overrides, % übrig')}
          <input
            type="number"
            min="0"
            max="95"
            value={settings().fallbackReservePct}
            onChange={(e) => saveSettings((s) => void (s.fallbackReservePct = Number(e.currentTarget.value)))}
            title={t('Gilt nur, wenn ein ausdrücklich zugewiesener Anbieter nicht verfügbar ist')}
          />
        </label>
        <Toggle
          label={t('Auch Prüfungen mit Override dürfen ausweichen')}
          checked={settings().fallbackReviews}
          onChange={(on) => saveSettings((s) => void (s.fallbackReviews = on))}
        />
      </div>
    </section>
  )
}
