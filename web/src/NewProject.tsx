import { createSignal, For, Match, Show, Switch } from 'solid-js'
import { api } from './api'
import { fail, loadProjects, openProject, providers } from './store'
import { Field, Modal } from './ui'

type ApplyResult = { projectId: number; agents: number; skills: number; issues: number }

export function NewProject(props: { onClose: () => void }) {
  const [mode, setMode] = createSignal<'ai' | 'manual'>('ai')

  async function finish(projectId: number) {
    await loadProjects()
    await openProject(projectId)
    props.onClose()
  }

  return (
    <Modal title="Neues Projekt" onClose={props.onClose} wide>
      <div class="tabs small">
        <button classList={{ active: mode() === 'ai' }} onClick={() => setMode('ai')}>
          Von der KI aufbauen lassen
        </button>
        <button classList={{ active: mode() === 'manual' }} onClick={() => setMode('manual')}>
          Leeres Projekt
        </button>
      </div>
      <Switch>
        <Match when={mode() === 'ai'}>
          <AiSetup onDone={finish} />
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
        <Field label="Kürzel" hint="Präfix der Issues, z. B. SHOP-12">
          <input
            placeholder={suggestedKey()}
            maxLength={8}
            value={key()}
            onInput={(e) => setKey(e.currentTarget.value.toUpperCase())}
          />
        </Field>
      </div>
      <Field
        label="Git-Repository auf dem Server"
        hint="Absoluter Pfad. Leer = AgentDeck legt einen Arbeitsordner an."
      >
        <input
          placeholder="/srv/repos/mein-projekt"
          value={repoPath()}
          onInput={(e) => setRepoPath(e.currentTarget.value)}
        />
      </Field>
      <Field label="Kontext für alle Agenten">
        <textarea rows="4" value={description()} onInput={(e) => setDescription(e.currentTarget.value)} />
      </Field>
      <footer>
        <span class="spacer" />
        <button class="primary" type="submit">
          Projekt anlegen
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
            label="Was soll gebaut werden?"
            hint="Die KI schlägt Agenten, Skills und Issues vor. Du siehst den Vorschlag, bevor etwas angelegt wird."
          >
            <textarea
              rows="8"
              required
              placeholder="Baue einen Webshop mit Next.js und Stripe. Ein Architekt plant, zwei Entwickler setzen um, ein Reviewer prüft…"
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
              {busy() ? 'KI plant…' : 'Vorschlag erstellen'}
            </button>
          </footer>
        </form>
      }
    >
      <div class="form">
        <Field label="Vorschlag (bearbeitbar)">
          <textarea
            rows="20"
            class="mono"
            value={blueprint()}
            onInput={(e) => setBlueprint(e.currentTarget.value)}
          />
        </Field>
        <footer>
          <button onClick={() => setBlueprint('')}>Zurück</button>
          <span class="spacer" />
          <button class="primary" onClick={apply}>
            So anlegen
          </button>
        </footer>
      </div>
    </Show>
  )
}
