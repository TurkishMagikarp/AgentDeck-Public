import { api } from './api'
import { board, closeProject, fail, loadProjects, saveSettings } from './store'
import { For, Show } from 'solid-js'
import { Field, Select, Toggle } from './ui'

const LANDING_MODES = [
  ['off', 'Off'],
  ['merge', 'Merge directly'],
  ['pr', 'Pull request, merge after green checks'],
] as const

const WORKSPACES = [
  ['issue', 'One worktree per issue'],
  ['agent', 'One checkout per agent'],
] as const

export function ProjectSettings() {
  const project = () => board.project!

  function save(patch: Record<string, string>) {
    api.patch(`/projects/${project().id}`, patch).then(loadProjects).catch(fail)
  }

  async function remove() {
    if (!confirm(`Delete project "${project().name}" with all its issues, agents and runs?`)) return
    await api.del(`/projects/${project().id}`).catch(fail)
    closeProject()
    await loadProjects()
  }

  return (
    <div class="page narrow">
      <div class="page-head">
        <h2>Project</h2>
      </div>
      <div class="form">
        <div class="row">
          <Field label="Name">
            <input value={project().name} onChange={(e) => save({ name: e.currentTarget.value })} />
          </Field>
          <Field label="Concurrent agents" hint="Limit for the whole project">
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
            label="Checkout"
            hint="Per agent: each agent keeps its own checkout, so build caches (Godot import, node_modules) survive."
          >
            <Select
              value={project().settings.workspace}
              options={WORKSPACES}
              onChange={(workspace) => saveSettings((s) => void (s.workspace = workspace))}
            />
          </Field>
          <Field label="Review rounds" hint="After that, a human decides">
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
          label="Git repository on the server"
          hint="Each issue gets its own worktree and branch agentdeck/KEY-n."
        >
          <input value={project().repo_path} onChange={(e) => save({ repo_path: e.currentTarget.value })} />
        </Field>
        <section class="section">
          <div class="section-head">
            <h3>Landing</h3>
            <Select
              value={project().settings.landing.mode}
              options={LANDING_MODES}
              onChange={(mode) => saveSettings((s) => void (s.landing.mode = mode))}
            />
          </div>
          <p class="muted">
            After the last approval, AgentDeck brings the issue's branch into the base branch. Agents never
            land on their own.
          </p>
          <Show when={project().settings.landing.mode !== 'off'}>
            <div class="row">
              <Field label="Base branch" hint="Empty = the branch checked out in the repository">
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
                  label="Push after merge"
                  checked={project().settings.landing.push}
                  onChange={(on) => saveSettings((s) => void (s.landing.push = on))}
                />
              </Show>
            </div>
            <Field
              label="Protected paths"
              hint="One path per line. If a branch changes anything under them, it does not land automatically and waits for you instead."
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
          label="Fully autonomous: nothing waits for a human"
          title="The agent below decides blocked issues and open reviews. Whatever it cannot resolve goes to the backlog and is retried later."
          checked={project().settings.autonomous}
          onChange={(on) => saveSettings((s) => void (s.autonomous = on))}
        />

        <Field
          label="Blocked issues go first to"
          hint="This agent decides once how to proceed. Only what it cannot resolve comes to you."
        >
          <select
            onChange={(e) => {
              const agentId = Number(e.currentTarget.value)
              saveSettings((s) => void (s.escalationAgentId = agentId))
            }}
          >
            <option value="0">Straight to me</option>
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
          label="Open groups in order"
          title="When nothing is left open, the backlog of the next group (sorted by name) moves to To do"
          checked={project().settings.openGroupsInOrder}
          onChange={(on) => saveSettings((s) => void (s.openGroupsInOrder = on))}
        />

        <Toggle
          label="Email me when an issue waits for me"
          title="Inbox and recipient are set under Providers and access"
          checked={project().settings.notifyOwner}
          onChange={(on) => saveSettings((s) => void (s.notifyOwner = on))}
        />

        <Field label="Context for all agents">
          <textarea
            rows="6"
            value={project().description}
            onChange={(e) => save({ description: e.currentTarget.value })}
          />
        </Field>
        <footer>
          <button class="ghost danger" onClick={remove}>
            Delete project
          </button>
        </footer>
      </div>
    </div>
  )
}
