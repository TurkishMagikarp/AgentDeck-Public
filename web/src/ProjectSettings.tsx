import { api } from './api'
import { board, closeProject, fail, loadProjects, saveSettings } from './store'
import { For, Show } from 'solid-js'
import { Field, Select, Toggle } from './ui'

const LANDING_MODES = [
  ['off', 'Aus'],
  ['merge', 'Direkt mergen'],
  ['pr', 'Pull Request, Merge nach grünen Checks'],
] as const

const WORKSPACES = [
  ['issue', 'Pro Issue ein Worktree'],
  ['agent', 'Pro Agent ein Checkout'],
] as const

export function ProjectSettings() {
  const project = () => board.project!

  function save(patch: Record<string, string>) {
    api.patch(`/projects/${project().id}`, patch).then(loadProjects).catch(fail)
  }

  async function remove() {
    if (!confirm(`Projekt "${project().name}" mit allen Issues, Agenten und Läufen löschen?`)) return
    await api.del(`/projects/${project().id}`).catch(fail)
    closeProject()
    await loadProjects()
  }

  return (
    <div class="page narrow">
      <div class="page-head">
        <h2>Projekt</h2>
      </div>
      <div class="form">
        <div class="row">
          <Field label="Name">
            <input value={project().name} onChange={(e) => save({ name: e.currentTarget.value })} />
          </Field>
          <Field label="Gleichzeitige Agenten" hint="Obergrenze für das ganze Projekt">
            <input
              type="number"
              min="1"
              max="50"
              value={project().settings.maxConcurrent}
              onChange={(e) => {
                const value = Number(e.currentTarget.value) || 1
                saveSettings((s) => void (s.maxConcurrent = value))
              }}
            />
          </Field>
        </div>
        <div class="row">
          <Field
            label="Arbeitsordner"
            hint="Pro Agent: ein fester Checkout je Agent, Build-Caches (Godot-Import, node_modules) bleiben erhalten."
          >
            <Select
              value={project().settings.workspace}
              options={WORKSPACES}
              onChange={(workspace) => saveSettings((s) => void (s.workspace = workspace))}
            />
          </Field>
          <Field label="Änderungsrunden im Review" hint="Danach entscheidet ein Mensch">
            <input
              type="number"
              min="1"
              max="20"
              value={project().settings.maxReviewRounds}
              onChange={(e) => {
                const value = Number(e.currentTarget.value) || 3
                saveSettings((s) => void (s.maxReviewRounds = value))
              }}
            />
          </Field>
        </div>
        <Field
          label="Git-Repository auf dem Server"
          hint="Jedes Issue bekommt einen eigenen Worktree und Branch agentdeck/KEY-n."
        >
          <input value={project().repo_path} onChange={(e) => save({ repo_path: e.currentTarget.value })} />
        </Field>
        <section class="section">
          <div class="section-head">
            <h3>Landung</h3>
            <Select
              value={project().settings.landing.mode}
              options={LANDING_MODES}
              onChange={(mode) => saveSettings((s) => void (s.landing.mode = mode))}
            />
          </div>
          <p class="muted">
            Nach der letzten Freigabe bringt AgentDeck den Branch des Issues in den Basis-Branch. Agenten
            landen nie selbst.
          </p>
          <Show when={project().settings.landing.mode !== 'off'}>
            <div class="row">
              <Field label="Basis-Branch" hint="Leer = der im Repository ausgecheckte Branch">
                <input
                  placeholder="main"
                  value={project().settings.landing.baseBranch}
                  onChange={(e) => {
                    const branch = e.currentTarget.value.trim()
                    saveSettings((s) => void (s.landing.baseBranch = branch))
                  }}
                />
              </Field>
              <Show when={project().settings.landing.mode === 'merge'}>
                <Toggle
                  label="Nach dem Merge pushen"
                  checked={project().settings.landing.push}
                  onChange={(on) => saveSettings((s) => void (s.landing.push = on))}
                />
              </Show>
            </div>
            <Field
              label="Geschützte Pfade"
              hint="Ein Pfad pro Zeile. Ändert ein Branch etwas darunter, landet er nicht automatisch, sondern wartet auf dich."
            >
              <textarea
                rows="3"
                class="mono"
                placeholder={'.github/\nCLAUDE.md'}
                value={project().settings.landing.protectedPaths.join('\n')}
                onChange={(e) => {
                  const paths = e.currentTarget.value
                    .split('\n')
                    .map((path) => path.trim())
                    .filter(Boolean)
                  saveSettings((s) => void (s.landing.protectedPaths = paths))
                }}
              />
            </Field>
          </Show>
        </section>

        <Toggle
          label="Vollautonom: nichts wartet auf einen Menschen"
          title="Blockierte Issues und offene Prüfungen entscheidet der Agent unten. Was auch er nicht klären kann, wird ins Backlog geparkt und später erneut versucht."
          checked={project().settings.autonomous}
          onChange={(on) => saveSettings((s) => void (s.autonomous = on))}
        />

        <Field
          label="Blockierte Issues gehen zuerst an"
          hint="Dieser Agent entscheidet einmal, wie es weitergeht. Erst was er nicht klären kann, landet bei dir."
        >
          <select
            onChange={(e) => {
              const agentId = Number(e.currentTarget.value)
              saveSettings((s) => void (s.escalationAgentId = agentId))
            }}
          >
            <option value="0">direkt an mich</option>
            <For each={board.agents}>
              {(agent) => (
                <option value={agent.id} selected={agent.id === project().settings.escalationAgentId}>
                  {agent.name}
                </option>
              )}
            </For>
          </select>
        </Field>

        <Toggle
          label="Gruppen nacheinander öffnen"
          title="Ist nichts mehr offen, wandert das Backlog der nächsten Gruppe (nach Name sortiert) auf To Do"
          checked={project().settings.openGroupsInOrder}
          onChange={(on) => saveSettings((s) => void (s.openGroupsInOrder = on))}
        />

        <Toggle
          label="Mail an mich, wenn ein Issue auf mich wartet"
          title="Postfach und Empfänger stehen unter „Anbieter und Zugänge“"
          checked={project().settings.notifyOwner}
          onChange={(on) => saveSettings((s) => void (s.notifyOwner = on))}
        />

        <Field label="Kontext für alle Agenten">
          <textarea
            rows="6"
            value={project().description}
            onChange={(e) => save({ description: e.currentTarget.value })}
          />
        </Field>
        <footer>
          <button class="ghost danger" onClick={remove}>
            Projekt löschen
          </button>
        </footer>
      </div>
    </div>
  )
}
