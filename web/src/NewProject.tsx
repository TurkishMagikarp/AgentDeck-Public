import { createResource, createSignal, For, Match, Show, Switch } from 'solid-js'
import { api } from './api'
import { fail, loadProjects, openProject, providers } from './store'
import { Field, Modal } from './ui'

type ApplyResult = { projectId: number; agents: number; skills: number; issues: number }

export function NewProject(props: { onClose: () => void }) {
  const [mode, setMode] = createSignal<'ai' | 'template' | 'manual'>('ai')

  async function finish(projectId: number) {
    await loadProjects()
    await openProject(projectId)
    props.onClose()
  }

  return (
    <Modal title="New project" onClose={props.onClose} wide>
      <div class="tabs small">
        <button classList={{ active: mode() === 'ai' }} onClick={() => setMode('ai')}>
          Let the AI set it up
        </button>
        <button classList={{ active: mode() === 'template' }} onClick={() => setMode('template')}>
          From a template
        </button>
        <button classList={{ active: mode() === 'manual' }} onClick={() => setMode('manual')}>
          Empty project
        </button>
      </div>
      <Switch>
        <Match when={mode() === 'ai'}>
          <AiSetup onDone={finish} />
        </Match>
        <Match when={mode() === 'template'}>
          <TemplateSetup onDone={finish} />
        </Match>
        <Match when={mode() === 'manual'}>
          <ManualSetup onDone={finish} />
        </Match>
      </Switch>
    </Modal>
  )
}

function ManualSetup(props: { onDone: (projectId: number) => void }) {
  const [name, setName] = createSignal('')
  const [key, setKey] = createSignal('')
  const [repoPath, setRepoPath] = createSignal('')
  const [description, setDescription] = createSignal('')

  // Suggest a key from the name until the user types their own.
  const suggestedKey = () =>
    name()
      .replace(/[^a-zA-Z]/g, '')
      .slice(0, 4)
      .toUpperCase()

  async function create(e: SubmitEvent) {
    e.preventDefault()
    try {
      const project = await api.post<{ id: number }>('/projects', {
        name: name(),
        key: key() || suggestedKey(),
        repo_path: repoPath(),
        description: description(),
      })
      props.onDone(project.id)
    } catch (err) {
      fail(err)
    }
  }

  return (
    <form class="form" onSubmit={create}>
      <div class="row">
        <Field label="Name">
          <input required value={name()} onInput={(e) => setName(e.currentTarget.value)} />
        </Field>
        <Field label="Key" hint="Issue prefix, e.g. SHOP-12">
          <input
            placeholder={suggestedKey()}
            maxLength={8}
            value={key()}
            onInput={(e) => setKey(e.currentTarget.value.toUpperCase())}
          />
        </Field>
      </div>
      <Field
        label="Git repository on the server"
        hint="Absolute path. Leave empty and AgentDeck creates a checkout."
      >
        <input
          placeholder="/srv/repos/my-project"
          value={repoPath()}
          onInput={(e) => setRepoPath(e.currentTarget.value)}
        />
      </Field>
      <Field label="Context for all agents">
        <textarea rows="4" value={description()} onInput={(e) => setDescription(e.currentTarget.value)} />
      </Field>
      <footer>
        <span class="spacer" />
        <button class="primary" type="submit">
          Create project
        </button>
      </footer>
    </form>
  )
}

function AiSetup(props: { onDone: (projectId: number) => void }) {
  const [wish, setWish] = createSignal('')
  const [provider, setProvider] = createSignal('anthropic')
  const [blueprint, setBlueprint] = createSignal('')
  const [busy, setBusy] = createSignal(false)

  async function generate(e: SubmitEvent) {
    e.preventDefault()
    setBusy(true)
    try {
      const result = await api.post('/blueprint/generate', { prompt: wish(), provider: provider() })
      setBlueprint(JSON.stringify(result, null, 2))
    } catch (err) {
      fail(err)
    } finally {
      setBusy(false)
    }
  }

  async function apply() {
    try {
      const result = await api.post<ApplyResult>('/blueprint', JSON.parse(blueprint()))
      props.onDone(result.projectId)
    } catch (err) {
      fail(err)
    }
  }

  return (
    <Show
      when={blueprint()}
      fallback={
        <form class="form" onSubmit={generate}>
          <Field
            label="What should be built?"
            hint="The AI suggests agents, skills and issues. You see the proposal before anything is created."
          >
            <textarea
              rows="8"
              required
              placeholder="Build an online shop with Next.js and Stripe. An architect plans, two developers build, a reviewer checks…"
              value={wish()}
              onInput={(e) => setWish(e.currentTarget.value)}
            />
          </Field>
          <footer>
            <select onChange={(e) => setProvider(e.currentTarget.value)}>
              <For each={providers()}>
                {(p) => (
                  <option value={p.id} selected={p.id === provider()}>
                    {p.label}
                  </option>
                )}
              </For>
            </select>
            <span class="spacer" />
            <button class="primary" type="submit" disabled={busy()}>
              {busy() ? 'AI is planning…' : 'Create proposal'}
            </button>
          </footer>
        </form>
      }
    >
      <div class="form">
        <Field label="Proposal (editable)">
          <textarea
            rows="20"
            class="mono"
            value={blueprint()}
            onInput={(e) => setBlueprint(e.currentTarget.value)}
          />
        </Field>
        <footer>
          <button onClick={() => setBlueprint('')}>Back</button>
          <span class="spacer" />
          <button class="primary" onClick={apply}>
            Create as shown
          </button>
        </footer>
      </div>
    </Show>
  )
}

type Template = { id: string; name: string; summary: string; agents: string[]; issues: number }

function TemplateSetup(props: { onDone: (projectId: number) => void }) {
  const [templates] = createResource(() => api.get<Template[]>('/templates'))
  const [chosen, setChosen] = createSignal('')
  const [name, setName] = createSignal('')
  const [key, setKey] = createSignal('')
  const [repoPath, setRepoPath] = createSignal('')

  const suggestedKey = () =>
    name()
      .replace(/[^a-zA-Z]/g, '')
      .slice(0, 4)
      .toUpperCase()

  async function create(e: SubmitEvent) {
    e.preventDefault()
    try {
      const result = await api.post<ApplyResult>(`/templates/${chosen()}`, {
        name: name(),
        key: key() || suggestedKey(),
        repo_path: repoPath(),
      })
      props.onDone(result.projectId)
    } catch (err) {
      fail(err)
    }
  }

  return (
    <form class="form" onSubmit={create}>
      <div class="templates">
        <For each={templates()}>
          {(template) => (
            <button
              type="button"
              class="template"
              classList={{ active: chosen() === template.id }}
              onClick={() => setChosen(template.id)}
            >
              <strong>{template.name}</strong>
              <span>{template.summary}</span>
              <small class="muted">
                {template.agents.join(', ')} · {template.issues} Start-Issues
              </small>
            </button>
          )}
        </For>
      </div>
      <Show when={chosen()}>
        <div class="row">
          <Field label="Name">
            <input required value={name()} onInput={(e) => setName(e.currentTarget.value)} />
          </Field>
          <Field label="Key" hint="Issue prefix, e.g. SHOP-12">
            <input
              placeholder={suggestedKey()}
              maxLength={8}
              value={key()}
              onInput={(e) => setKey(e.currentTarget.value.toUpperCase())}
            />
          </Field>
        </div>
        <Field label="Git repository on the server" hint="Empty = AgentDeck creates a working folder.">
          <input
            placeholder="/repos/my-project"
            value={repoPath()}
            onInput={(e) => setRepoPath(e.currentTarget.value)}
          />
        </Field>
        <p class="muted">
          The project is fully autonomous and starts paused: check agents and providers, then press "Resume".
        </p>
      </Show>
      <footer>
        <span class="spacer" />
        <button class="primary" type="submit" disabled={!chosen()}>
          Create project
        </button>
      </footer>
    </form>
  )
}
