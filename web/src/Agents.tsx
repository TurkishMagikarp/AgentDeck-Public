import { createResource, createSignal, For, Show } from 'solid-js'
import { createStore } from 'solid-js/store'
import { api } from './api'
import { ModelSelect } from './ModelSelect'
import { board, fail, providerLabel, providers } from './store'
import type { Agent } from './types'
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

  return (
    <div class="page">
      <div class="page-head">
        <div>
          <h2>Agents</h2>
          <p class="muted">Who works in this project, with which provider, and how many in parallel.</p>
        </div>
        <button class="primary" onClick={() => setEditing(newAgent())}>
          Add agent
        </button>
      </div>

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
      </div>

      <Show when={editing()}>
        {(draft) => <AgentForm draft={draft()} onClose={() => setEditing(null)} />}
      </Show>
    </div>
  )
}

function AgentCard(props: { agent: Agent; onEdit: () => void }) {
  const running = () => board.runs.filter((run) => run.agent_id === props.agent.id).length
  const skills = () => board.skills.filter((skill) => props.agent.skill_ids.includes(skill.id))

  return (
    <article
      class="tile"
      classList={{ disabled: !props.agent.enabled }}
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
        {providerLabel(props.agent.provider)}
        {props.agent.model && ` · ${props.agent.model}`}
      </p>
      <p>
        {running()} / {props.agent.max_instances} instances active
        {!props.agent.enabled && ' · disabled'}
      </p>
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

        <div class="row">
          <Field label="Provider">
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
