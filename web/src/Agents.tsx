import { createResource, createSignal, For, Show } from 'solid-js'
import { createStore } from 'solid-js/store'
import { api } from './api'
import { fleet } from './fleet'
import { t } from './i18n'
import { ModelSelect } from './ModelSelect'
import { board, fail, liveLine, providerLabel, providers } from './store'
import { TIER_LABEL, type Agent, type Tier } from './types'
import { Field, initials, Modal, onActivateKey, Select, Toggle } from './ui'

type Draft = Omit<Agent, 'id'> & { id?: number }

const EFFORTS: [string, string][] = [
  ['', 'Standard'],
  ['low', 'niedrig'],
  ['medium', 'mittel'],
  ['high', 'hoch'],
  ['xhigh', 'sehr hoch'],
  ['max', 'maximal'],
]

const newAgent = (): Draft => ({
  name: '',
  role: '',
  provider: providers()[0]?.id ?? 'anthropic',
  provider_override: false,
  model: '',
  instructions: '',
  skill_ids: [],
  mcp_ids: [],
  max_instances: 1,
  effort: '',
  enabled: true,
})

export function Agents() {
  const [editing, setEditing] = createSignal<Draft | null>(null)
  const [switching, setSwitching] = createSignal(false)

  return (
    <div class="page">
      <div class="page-head">
        <div>
          <h2>{t('Agenten')}</h2>
          <p class="muted">{t('Wer in diesem Projekt arbeitet, mit welchem Anbieter und wie oft parallel.')}</p>
        </div>
        <div class="row">
          <Show when={board.agents.length}>
            <button onClick={() => setSwitching(true)}>{t('Anbieter wechseln')}</button>
          </Show>
          <button class="primary" onClick={() => setEditing(newAgent())}>
            {t('Agent hinzufügen')}
          </button>
        </div>
      </div>

      <Show when={switching()}>
        <SwitchProvider onClose={() => setSwitching(false)} />
      </Show>

      <div class="grid">
        <For
          each={board.agents}
          fallback={<p class="muted">{t('Noch keine Agenten. Ohne Agenten bleibt das Board stehen.')}</p>}
        >
          {(agent) => (
            <AgentCard
              agent={agent}
              onEdit={() =>
                setEditing({ ...agent, skill_ids: [...agent.skill_ids], mcp_ids: [...agent.mcp_ids] })
              }
            />
          )}
        </For>
        <Show when={board.agents.length}>
          <button class="tile add-tile" onClick={() => setEditing(newAgent())}>
            <span aria-hidden="true">+</span>
            {t('Agent hinzufügen')}
          </button>
        </Show>
      </div>

      <Show when={editing()}>
        {(draft) => <AgentForm draft={draft()} onClose={() => setEditing(null)} />}
      </Show>
    </div>
  )
}

type SwitchStep = {
  agent_id: number
  name: string
  tier: Tier
  from: { provider: string; model: string }
  to: { provider: string; model: string }
}

/**
 * Moves the team (or a part of it) to another provider. Shows first who gets which model, so
 * nothing changes before the owner has seen it. Runs in progress finish on their old provider.
 */
function SwitchProvider(props: { onClose: () => void }) {
  const [target, setTarget] = createSignal(
    providers().find((p) => board.agents.some((a) => a.provider !== p.id))?.id ?? providers()[0]?.id ?? '',
  )
  const [chosen, setChosen] = createSignal<number[]>(board.agents.map((agent) => agent.id))
  const [saving, setSaving] = createSignal(false)
  const path = () => `/projects/${board.project!.id}/switch-provider`

  const [plan] = createResource(
    () => ({ provider: target(), agent_ids: chosen() }),
    (request) => api.post<{ plan: SwitchStep[] }>(path(), { ...request, dryRun: true }).then((r) => r.plan),
  )

  const toggle = (agentId: number, on: boolean) =>
    setChosen((ids) => (on ? [...ids, agentId] : ids.filter((other) => other !== agentId)))

  async function apply() {
    setSaving(true)
    try {
      await api.post(path(), { provider: target(), agent_ids: chosen() })
      props.onClose()
    } catch (e) {
      fail(e)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal title={t('Anbieter wechseln')} onClose={props.onClose} wide>
      <div class="form">
        <Field
          label={t('Neuer Anbieter')}
          hint={t('Setzt einen Anbieter-Override für die Auswahl. Die Modell-Stufe bleibt erhalten.')}
        >
          <Select
            value={target()}
            options={providers().map((p) => [p.id, p.label] as [string, string])}
            onChange={setTarget}
          />
        </Field>
        <div class="table-scroll">
          <table class="switch-plan">
            <thead>
              <tr>
                <th />
                <th>{t('Agent')}</th>
                <th>{t('Stufe')}</th>
                <th>{t('Jetzt')}</th>
                <th>{t('Danach')}</th>
              </tr>
            </thead>
            <tbody>
              <For each={board.agents}>
                {(agent) => {
                  const step = () => plan.latest?.find((s) => s.agent_id === agent.id)
                  const on = () => chosen().includes(agent.id)
                  return (
                    <tr classList={{ off: !on() }}>
                      <td>
                        <input
                          type="checkbox"
                          checked={on()}
                          aria-label={t('{name} umstellen', { name: agent.name })}
                          onChange={(e) => toggle(agent.id, e.currentTarget.checked)}
                        />
                      </td>
                      <td>{agent.name}</td>
                      <td>{step() ? t(TIER_LABEL[step()!.tier]) : '–'}</td>
                      <td class="muted">
                        {agent.provider_override ? providerLabel(agent.provider) : t('Projektreihenfolge')}
                        {agent.model && ` · ${agent.model}`}
                      </td>
                      <td>
                        {on() && step()
                          ? `${providerLabel(step()!.to.provider)} · ${step()!.to.model || t('Standard')}`
                          : t('bleibt')}
                      </td>
                    </tr>
                  )
                }}
              </For>
            </tbody>
          </table>
        </div>
        <footer>
          <span class="spacer" />
          <button type="button" onClick={props.onClose}>
            {t('Abbrechen')}
          </button>
          <button class="primary" disabled={saving() || !chosen().length} onClick={apply}>
            {chosen().length === 1 ? t('1 Agent umstellen') : t('{n} Agenten umstellen', { n: chosen().length })}
          </button>
        </footer>
      </div>
    </Modal>
  )
}

function AgentCard(props: { agent: Agent; onEdit: () => void }) {
  const running = () => board.runs.filter((run) => run.agent_id === props.agent.id).length
  const skills = () => board.skills.filter((skill) => props.agent.skill_ids.includes(skill.id))
  // What this agent is doing right now, and how the last week went (the same numbers as Mission Control).
  const current = () => {
    const run = board.runs.find((candidate) => candidate.agent_id === props.agent.id)
    const issue = run && board.issues.find((candidate) => candidate.id === run.issue_id)
    return run && issue ? { key: `${board.project?.key}-${issue.number}`, line: liveLine[issue.id] || issue.title } : null
  }
  const week = () => fleet()?.agents.find((row) => row.agent === props.agent.name && row.projectKey === board.project?.key)

  return (
    <article
      class="tile"
      classList={{ disabled: !props.agent.enabled, working: running() > 0 }}
      role="button"
      tabIndex={0}
      aria-label={t('{name} bearbeiten', { name: props.agent.name })}
      onClick={props.onEdit}
      onKeyDown={onActivateKey(props.onEdit)}
    >
      <div class="tile-head">
        <span class={`avatar large ${props.agent.provider}`}>{initials(props.agent.name)}</span>
        <div>
          <strong>{props.agent.name}</strong>
          <p class="muted">{props.agent.role || t('Keine Rolle')}</p>
        </div>
      </div>
      <p class="muted">
        {props.agent.provider_override ? t('Override: {provider}', { provider: providerLabel(props.agent.provider) })
          : t('Projektreihenfolge')}
        {props.agent.model && ` · ${props.agent.model}`}
      </p>
      <p>
        {t('{running} / {max} Instanzen aktiv', { running: running(), max: props.agent.max_instances })}
        {!props.agent.enabled && ` · ${t('deaktiviert')}`}
      </p>
      <Show when={current()}>
        {(now) => (
          <p class="tile-now">
            <span class="live-dot small" aria-hidden="true" />
            <span class="mono">{now().key}</span>
            <span class="tile-now-line">{now().line}</span>
          </p>
        )}
      </Show>
      <Show when={week()}>
        {(w) => (
          <p class="tile-week muted" title={t('Letzte 7 Tage: abgeschlossene gegen fehlgeschlagene Läufe')}>
            <span class="rate-bar" aria-hidden="true">
              <span
                classList={{ low: (w().successRate ?? 1) < 0.5 }}
                style={{ width: `${Math.round((w().successRate ?? 0) * 100)}%` }}
              />
            </span>
            {w().successRate === null
              ? t('noch keine Wertung')
              : t('{rate} % Erfolg', { rate: Math.round(w().successRate! * 100) })}{' '}
            · {t('{n} Läufe', { n: w().runs })} ·{' '}
            {w().costUsd < 10 ? w().costUsd.toFixed(2) : Math.round(w().costUsd)} $
          </p>
        )}
      </Show>
      <div class="chips">
        <For each={skills()}>{(skill) => <span class="chip">{skill.name}</span>}</For>
      </div>
    </article>
  )
}

function AgentForm(props: { draft: Draft; onClose: () => void }) {
  const [draft, setDraft] = createStore<Draft>(props.draft)

  function toggleSkill(skillId: number, on: boolean) {
    setDraft('skill_ids', (ids) => (on ? [...ids, skillId] : ids.filter((id) => id !== skillId)))
  }

  // Only connections with a stored key can be handed to an agent.
  const [connections] = createResource(async () => {
    const all = await api.get<{ id: string; label: string; description: string; hasKey: boolean }[]>('/mcp')
    return all.filter((connection) => connection.hasKey)
  })

  function toggleConnection(id: string, on: boolean) {
    setDraft('mcp_ids', (ids) => (on ? [...ids, id] : ids.filter((other) => other !== id)))
  }

  async function save(e: SubmitEvent) {
    e.preventDefault()
    try {
      if (draft.id) await api.patch(`/agents/${draft.id}`, draft)
      else await api.post(`/projects/${board.project!.id}/agents`, draft)
      props.onClose()
    } catch (err) {
      fail(err)
    }
  }

  async function remove() {
    if (!confirm(t('Agent "{name}" löschen?', { name: draft.name }))) return
    await api.del(`/agents/${draft.id}`).catch(fail)
    props.onClose()
  }

  return (
    <Modal title={draft.id ? t('Agent bearbeiten') : t('Neuer Agent')} onClose={props.onClose}>
      <form class="form" onSubmit={save}>
        <div class="row">
          <Field label={t('Name')}>
            <input required value={draft.name} onInput={(e) => setDraft('name', e.currentTarget.value)} />
          </Field>
          <Field label={t('Rolle')}>
            <input
              placeholder={t('z. B. Backend-Entwickler')}
              value={draft.role}
              onInput={(e) => setDraft('role', e.currentTarget.value)}
            />
          </Field>
        </div>

        <Toggle
          label={t('Anbieter für diesen Agenten überschreiben')}
          checked={draft.provider_override}
          onChange={(on) => setDraft('provider_override', on)}
        />
        <div class="row">
          <Field label={
              draft.provider_override ? t('Bevorzugter Anbieter') : t('Referenzanbieter für die Modell-Stufe')
            }>
            <select
              onChange={(e) => {
                // A model of one provider means nothing to another.
                setDraft({ provider: e.currentTarget.value, model: '' })
              }}
            >
              <For each={providers()}>
                {(provider) => (
                  <option value={provider.id} selected={provider.id === draft.provider}>
                    {provider.label}
                  </option>
                )}
              </For>
            </select>
          </Field>
          <Field label={t('Modell')}>
            <ModelSelect
              provider={draft.provider}
              value={draft.model}
              onChange={(model) => setDraft('model', model)}
            />
          </Field>
          <Field label={t('Effort')} hint={t('Denkaufwand pro Lauf')}>
            <Select
              value={draft.effort}
              options={EFFORTS.map(([value, label]) => [value, t(label)] as [string, string])}
              onChange={(effort) => setDraft('effort', effort)}
            />
          </Field>
          <Field label={t('Max. Instanzen')} hint={t('Parallel laufende Kopien')}>
            <input
              type="number"
              min="1"
              max="20"
              value={draft.max_instances}
              onInput={(e) => setDraft('max_instances', Number(e.currentTarget.value))}
            />
          </Field>
        </div>

        <Field label={t('Anweisungen')}>
          <textarea
            rows="6"
            value={draft.instructions}
            onInput={(e) => setDraft('instructions', e.currentTarget.value)}
          />
        </Field>

        <Show when={board.skills.length}>
          <div class="field">
            <span>{t('Skills')}</span>
            <div class="chips">
              <For each={board.skills}>
                {(skill) => (
                  <Toggle
                    label={skill.name}
                    title={skill.description}
                    checked={draft.skill_ids.includes(skill.id)}
                    onChange={(on) => toggleSkill(skill.id, on)}
                  />
                )}
              </For>
            </div>
          </div>
        </Show>

        <Show when={connections()?.length}>
          <div class="field">
            <span>{t('MCP-Verbindungen')}</span>
            <div class="chips">
              <For each={connections()}>
                {(connection) => (
                  <Toggle
                    label={connection.label}
                    title={connection.description}
                    checked={draft.mcp_ids.includes(connection.id)}
                    onChange={(on) => toggleConnection(connection.id, on)}
                  />
                )}
              </For>
            </div>
            <Show when={draft.provider === 'deepseek' && draft.mcp_ids.length}>
              <small>{t('Der Deepseek-Agent kann MCP-Verbindungen noch nicht nutzen.')}</small>
            </Show>
          </div>
        </Show>

        <Toggle label={t('Aktiv')} checked={draft.enabled} onChange={(on) => setDraft('enabled', on)} />

        <footer>
          <Show when={draft.id}>
            <button type="button" class="ghost danger" onClick={remove}>
              {t('Löschen')}
            </button>
          </Show>
          <span class="spacer" />
          <button type="button" onClick={props.onClose}>
            {t('Abbrechen')}
          </button>
          <button class="primary" type="submit">
            {t('Speichern')}
          </button>
        </footer>
      </form>
    </Modal>
  )
}
