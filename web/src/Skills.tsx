import { createSignal, For, Show } from 'solid-js'
import { createStore } from 'solid-js/store'
import { api } from './api'
import { board, fail } from './store'
import type { Skill } from './types'
import { Field, Modal, onActivateKey } from './ui'

type Draft = Omit<Skill, 'id'> & { id?: number }

export function Skills() {
  const [editing, setEditing] = createSignal<Draft | null>(null)
  const usedBy = (skillId: number) => board.agents.filter((agent) => agent.skill_ids.includes(skillId)).length

  return (
    <div class="page">
      <div class="page-head">
        <div>
          <h2>Skills</h2>
          <p class="muted">
            Reusable knowledge. An agent only gets the skills in its prompt that are assigned
            to it.
          </p>
        </div>
        <button class="primary" onClick={() => setEditing({ name: '', description: '', content: '' })}>
          Add skill
        </button>
      </div>

      <div class="grid">
        <For each={board.skills} fallback={<p class="muted">No skills yet.</p>}>
          {(skill) => (
            <article
              class="tile"
              role="button"
              tabIndex={0}
              aria-label={`Edit skill ${skill.name}`}
              onClick={() => setEditing({ ...skill })}
              onKeyDown={onActivateKey(() => setEditing({ ...skill }))}
            >
              <strong>{skill.name}</strong>
              <p class="muted">{skill.description || 'No description'}</p>
              <p>{usedBy(skill.id)} agents use this skill</p>
            </article>
          )}
        </For>
      </div>

      <Show when={editing()}>
        {(draft) => <SkillForm draft={draft()} onClose={() => setEditing(null)} />}
      </Show>
    </div>
  )
}

function SkillForm(props: { draft: Draft; onClose: () => void }) {
  const [draft, setDraft] = createStore<Draft>(props.draft)

  async function save(e: SubmitEvent) {
    e.preventDefault()
    try {
      if (draft.id) await api.patch(`/skills/${draft.id}`, draft)
      else await api.post(`/projects/${board.project!.id}/skills`, draft)
      props.onClose()
    } catch (err) {
      fail(err)
    }
  }

  async function remove() {
    if (!confirm(`Delete skill "${draft.name}"?`)) return
    await api.del(`/skills/${draft.id}`).catch(fail)
    props.onClose()
  }

  return (
    <Modal title={draft.id ? 'Edit skill' : 'New skill'} onClose={props.onClose} wide>
      <form class="form" onSubmit={save}>
        <div class="row">
          <Field label="Name">
            <input required value={draft.name} onInput={(e) => setDraft('name', e.currentTarget.value)} />
          </Field>
          <Field label="Short description">
            <input
              value={draft.description}
              onInput={(e) => setDraft('description', e.currentTarget.value)}
            />
          </Field>
        </div>
        <Field label="Content (Markdown)">
          <textarea
            rows="16"
            class="mono"
            value={draft.content}
            onInput={(e) => setDraft('content', e.currentTarget.value)}
          />
        </Field>
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
