import { createResource, createSignal, For, Match, Show, Switch } from 'solid-js'
import { api } from './api'
import { fail, loadProjects, openProject, projects, providers } from './store'
import { Field, Modal } from './ui'
import { language, t } from './i18n'

type ApplyResult = { projectId: number; agents: number; skills: number; issues: number }

export function NewProject(props: { onClose: () => void }) {
  const [mode, setMode] = createSignal<'ai' | 'template' | 'manual'>('ai')

  async function finish(projectId: number) {
    await loadProjects()
    await openProject(projectId)
    props.onClose()
  }

  return (
    <Modal title={t('Neues Projekt')} onClose={props.onClose} wide>
      <div class="tabs small">
        <button classList={{ active: mode() === 'ai' }} onClick={() => setMode('ai')}>
          {t('Von der KI aufbauen lassen')}
        </button>
        <button classList={{ active: mode() === 'template' }} onClick={() => setMode('template')}>
          {t('Aus Vorlage')}
        </button>
        <button classList={{ active: mode() === 'manual' }} onClick={() => setMode('manual')}>
          {t('Leeres Projekt')}
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
        settings: { language: language() },
      })
      props.onDone(project.id)
    } catch (err) {
      fail(err)
    }
  }

  return (
    <form class="form" onSubmit={create}>
      <div class="row">
        <Field label={t('Name')}>
          <input required value={name()} onInput={(e) => setName(e.currentTarget.value)} />
        </Field>
        <Field label={t('Kürzel')} hint={t('Präfix der Issues, z. B. SHOP-12')}>
          <input
            placeholder={suggestedKey()}
            maxLength={8}
            value={key()}
            onInput={(e) => setKey(e.currentTarget.value.toUpperCase())}
          />
        </Field>
      </div>
      <Field
        label={t('Git-Repository auf dem Server')}
        hint={t('Absoluter Pfad. Leer = AgentDeck legt einen Arbeitsordner an.')}
      >
        <input
          placeholder={t('/srv/repos/mein-projekt')}
          value={repoPath()}
          onInput={(e) => setRepoPath(e.currentTarget.value)}
        />
      </Field>
      <Field label={t('Kontext für alle Agenten')}>
        <textarea rows="4" value={description()} onInput={(e) => setDescription(e.currentTarget.value)} />
      </Field>
      <footer>
        <span class="spacer" />
        <button class="primary" type="submit">
          {t('Projekt anlegen')}
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
      const plan = JSON.parse(blueprint())
      // A new project works in the language of the person who creates it, unless the plan names one.
      // A plan for an existing key extends that project and leaves its language alone.
      const key = String(plan?.project?.key ?? '').toUpperCase()
      if (plan?.project && !projects().some((project) => project.key === key))
        plan.project.settings = { language: language(), ...plan.project.settings }
      const result = await api.post<ApplyResult>('/blueprint', plan)
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
            label={t('Was soll gebaut werden?')}
            hint={t('Die KI schlägt Agenten, Skills und Issues vor. Du siehst den Vorschlag, bevor etwas angelegt wird.')}
          >
            <textarea
              rows="8"
              required
              placeholder={t('Baue einen Webshop mit Next.js und Stripe. Ein Architekt plant, zwei Entwickler setzen um, ein Reviewer prüft…')}
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
              {busy() ? t('KI plant…') : t('Vorschlag erstellen')}
            </button>
          </footer>
        </form>
      }
    >
      <div class="form">
        <Field label={t('Vorschlag (bearbeitbar)')}>
          <textarea
            rows="20"
            class="mono"
            value={blueprint()}
            onInput={(e) => setBlueprint(e.currentTarget.value)}
          />
        </Field>
        <footer>
          <button onClick={() => setBlueprint('')}>{t('Zurück')}</button>
          <span class="spacer" />
          <button class="primary" onClick={apply}>
            {t('So anlegen')}
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
        settings: { language: language() },
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
                {template.agents.join(', ')} · {t('{n} Start-Issues', { n: template.issues })}
              </small>
            </button>
          )}
        </For>
      </div>
      <Show when={chosen()}>
        <div class="row">
          <Field label={t('Name')}>
            <input required value={name()} onInput={(e) => setName(e.currentTarget.value)} />
          </Field>
          <Field label={t('Kürzel')} hint={t('Präfix der Issues, z. B. SHOP-12')}>
            <input
              placeholder={suggestedKey()}
              maxLength={8}
              value={key()}
              onInput={(e) => setKey(e.currentTarget.value.toUpperCase())}
            />
          </Field>
        </div>
        <Field label={t('Git-Repository auf dem Server')} hint={t('Leer = AgentDeck legt einen Arbeitsordner an.')}>
          <input
            placeholder={t('/repos/mein-projekt')}
            value={repoPath()}
            onInput={(e) => setRepoPath(e.currentTarget.value)}
          />
        </Field>
        <p class="muted">
          {t('Das Projekt ist vollautonom und startet pausiert: Prüf Agenten und Anbieter, dann „Fortsetzen“.')}
        </p>
      </Show>
      <footer>
        <span class="spacer" />
        <button class="primary" type="submit" disabled={!chosen()}>
          {t('Projekt anlegen')}
        </button>
      </footer>
    </form>
  )
}
