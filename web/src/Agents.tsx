import { createResource, createSignal, For, Show } from 'solid-js'
import { createStore } from 'solid-js/store'
import { api } from './api'
import { fleet } from './fleet'
import { ModelSelect } from './ModelSelect'
import { board, fail, liveLine, providerLabel, providers } from './store'
import { TIER_LABEL, type Agent, type Tier } from './types'
import { Field, initials, Modal, onActivateKey, Select, Toggle } from './ui'

type Draft = Omit<Agent, 'id'> & { id?: number }

const EFFORTS: [string, string][] = [
  ['', 'Default'],
  ['low', 'Low'],
  ['medium', 'Medium'],
  ['high', 'High'],
  ['xhigh', 'Very high'],
  ['max', 'Max'],
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
          <h2>Agents</h2>
          <p class="muted">Who works in this project, with which provider, and how many in parallel.</p>
        </div>
        <div class="row">
          <Show when={board.agents.length}>
            <button onClick={() => setSwitching(true)}>Switch provider</button>
          </Show>
          <button class="primary" onClick={() => setEditing(newAgent())}>
          Add agent
          </button>
        </div>
      </div>

      <Show when={switching()}>
        <SwitchProvider onClose={() => setSwitching(false)} />
      </Show>

      <div class="grid">
        <For
          each={board.agents}
          fallback={<p class="muted">No agents yet. Without agents the board stands still.</p>}
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
            Add agent
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
    <Modal title="Switch provider" onClose={props.onClose} wide>
      <div class="form">
        <Field
          label="New provider"
          hint="Sets a provider override for the selection. The model tier is kept."
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
                <th>Agent</th>
                <th>Tier</th>
                <th>Now</th>
                <th>After</th>
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
                          aria-label={`Switch ${agent.name}`}
                          onChange={(e) => toggle(agent.id, e.currentTarget.checked)}
                        />
                      </td>
                      <td>{agent.name}</td>
                      <td>{step() ? TIER_LABEL[step()!.tier] : '–'}</td>
                      <td class="muted">
                        {agent.provider_override ? providerLabel(agent.provider) : 'Project order'}
                        {agent.model && ` · ${agent.model}`}
                      </td>
                      <td>
                        {on() && step()
                          ? `${providerLabel(step()!.to.provider)} · ${step()!.to.model || 'default'}`
                          : 'stays'}
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
            Cancel
          </button>
          <button class="primary" disabled={saving() || !chosen().length} onClick={apply}>
            Switch {chosen().length} {chosen().length === 1 ? 'agent' : 'agents'}
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
      aria-label={`Edit ${props.agent.name}`}
      onClick={props.onEdit}
      onKeyDown={onActivateKey(props.onEdit)}
    >
      <div class="tile-head">
        <span class={`avatar large ${props.agent.provider}`}>{initials(props.agent.name)}</span>
        <div>
          <strong>{props.agent.name}</strong>
          <p class="muted">{props.agent.role || 'No role'}</p>
        </div>
      </div>
      <p class="muted">
        {props.agent.provider_override ? `Override: ${providerLabel(props.agent.provider)}` : 'Project order'}
        {props.agent.model && ` · ${props.agent.model}`}
      </p>
      <p>
        {running()} / {props.agent.max_instances} instances active
        {!props.agent.enabled && ' · disabled'}
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
          <p class="tile-week muted" title="Last 7 days: finished against failed runs">
            <span class="rate-bar" aria-hidden="true">
              <span
                classList={{ low: (w().successRate ?? 1) < 0.5 }}
                style={{ width: `${Math.round((w().successRate ?? 0) * 100)}%` }}
              />
            </span>
            {w().successRate === null ? 'no rating yet' : `${Math.round(w().successRate! * 100)}% success`} · {w().runs} runs ·{' '}
            ${w().costUsd < 10 ? w().costUsd.toFixed(2) : Math.round(w().costUsd)}
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
    if (!confirm(`Delete agent "${draft.name}"?`)) return
    await api.del(`/agents/${draft.id}`).catch(fail)
    props.onClose()
  }

  return (
    <Modal title={draft.id ? 'Edit agent' : 'New agent'} onClose={props.onClose}>
      <form class="form" onSubmit={save}>
        <div class="row">
          <Field label="Name">
            <input required value={draft.name} onInput={(e) => setDraft('name', e.currentTarget.value)} />
          </Field>
          <Field label="Role">
            <input
              placeholder="e.g. Backend developer"
              value={draft.role}
              onInput={(e) => setDraft('role', e.currentTarget.value)}
            />
          </Field>
        </div>

        <Toggle
          label="Override the provider for this agent"
          checked={draft.provider_override}
          onChange={(on) => setDraft('provider_override', on)}
        />
        <div class="row">
          <Field label={draft.provider_override ? 'Preferred provider' : 'Reference provider for the model tier'}>
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
          <Field label="Model">
            <ModelSelect
              provider={draft.provider}
              value={draft.model}
              onChange={(model) => setDraft('model', model)}
            />
          </Field>
          <Field label="Effort" hint="Thinking effort per run">
            <Select
              value={draft.effort}
              options={EFFORTS}
              onChange={(effort) => setDraft('effort', effort)}
            />
          </Field>
          <Field label="Max instances" hint="Copies running in parallel">
            <input
              type="number"
              min="1"
              max="20"
              value={draft.max_instances}
              onInput={(e) => setDraft('max_instances', Number(e.currentTarget.value))}
            />
          </Field>
        </div>

        <Field label="Instructions">
          <textarea
            rows="6"
            value={draft.instructions}
            onInput={(e) => setDraft('instructions', e.currentTarget.value)}
          />
        </Field>

        <Show when={board.skills.length}>
          <div class="field">
            <span>Skills</span>
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
            <span>MCP connections</span>
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
              <small>The Deepseek agent cannot use MCP connections yet.</small>
            </Show>
          </div>
        </Show>

        <Toggle label="Active" checked={draft.enabled} onChange={(on) => setDraft('enabled', on)} />

        <footer>
          <Show when={draft.id}>
            <button type="button" class="ghost danger" onClick={remove}>
              Delete
            </button>
          </Show>
          <span class="spacer" />
          <button type="button" onClick={props.onClose}>
            Cancel
          </button>
          <button class="primary" type="submit">
            Save
          </button>
        </footer>
      </form>
    </Modal>
  )
}
