import { createSignal, For, Match, onMount, Show, Switch } from 'solid-js'
import { Agents } from './Agents'
import { api, needsLogin } from './api'
import { Login } from './Login'
import { Board } from './Board'
import { Dashboard } from './Dashboard'
import { IssuePanel } from './IssuePanel'
import { NewProject } from './NewProject'
import { ProjectSettings } from './ProjectSettings'
import { Skills } from './Skills'
import {
  board,
  detail,
  error,
  fail,
  loadMeta,
  loadProjects,
  notice,
  openProject,
  projects,
  saveSettings,
  openIssue,
} from './store'
import { Providers } from './Providers'
import { Toggle } from './ui'
import { Usage } from './Usage'
import { Routines } from './Routines'
import { Watchdog } from './Watchdog'

const TABS = [
  ['board', 'Board'],
  ['dashboard', 'Dashboard'],
  ['agents', 'Agents'],
  ['skills', 'Skills'],
  ['usage', 'Usage & routing'],
  ['routines', 'Routines'],
  ['watchdog', 'Watchdog'],
  ['settings', 'Project'],
] as const

type Tab = (typeof TABS)[number][0]

export function App() {
  const [tab, setTab] = createSignal<Tab>('board')
  const [creating, setCreating] = createSignal(false)
  const [showProviders, setShowProviders] = createSignal(false)

  onMount(async () => {
    try {
      await Promise.all([loadProjects(), loadMeta()])
      if (await openLinkedIssue()) return
      const lastId = Number(localStorage.getItem('agentdeck.project'))
      const start = projects().find((p) => p.id === lastId) ?? projects()[0]
      if (start) await openProject(start.id)
    } catch (err) {
      fail(err)
    }
  })

  /** Mails link to an issue as "#KEY-123". Returns false when the address names none. */
  async function openLinkedIssue() {
    const link = location.hash.match(/^#([A-Z][A-Z0-9]+)-(\d+)$/)
    if (!link) return false
    // The project may be newer than the list this tab loaded.
    if (!projects().some((p) => p.key === link[1])) await loadProjects()
    const project = projects().find((p) => p.key === link[1])
    if (!project) return false

    await openProject(project.id)
    const issue = board.issues.find((candidate) => candidate.number === Number(link[2]))
    if (issue) await openIssue(issue.id)
    return true
  }
  window.addEventListener('hashchange', () => openLinkedIssue().catch(fail))

  function selectProject(projectId: number) {
    setTab('board')
    openProject(projectId).catch(fail)
  }

  function togglePause() {
    const project = board.project!
    api.patch(`/projects/${project.id}`, { paused: !project.paused }).catch(fail)
  }

  return (
    <div class="app">
      <nav class="sidebar">
        <div class="brand">
          <span class="brand-mark" />
          AgentDeck
        </div>
        <ul>
          <For each={projects()}>
            {(project) => (
              <li>
                <button
                  classList={{ active: project.id === board.project?.id }}
                  onClick={() => selectProject(project.id)}
                >
                  <span class="project-key">{project.key}</span>
                  <span class="project-name">{project.name}</span>
                  <Show when={project.id === board.project?.id ? board.runs.length : project.running}>
                    {(count) => <span class="running-count">{count()}</span>}
                  </Show>
                </button>
              </li>
            )}
          </For>
        </ul>
        <span class="spacer" />
        <button class="ghost sidebar-link" onClick={() => setShowProviders(true)}>
          Providers and access
        </button>
        <button class="new-project" onClick={() => setCreating(true)}>
          + Project
        </button>
      </nav>

      <main>
        <Show when={board.project} fallback={<Welcome onCreate={() => setCreating(true)} />}>
          {(project) => (
            <>
              <header class="topbar">
                <h1>{project().name}</h1>
                <div class="phone-bar">
                  <select
                    class="project-switch"
                    aria-label="Switch project"
                    onChange={(e) => selectProject(Number(e.currentTarget.value))}
                  >
                    <For each={projects()}>
                      {(other) => (
                        <option value={other.id} selected={other.id === project().id}>
                          {other.name}
                        </option>
                      )}
                    </For>
                  </select>
                  <button onClick={() => setShowProviders(true)}>Access</button>
                  <button onClick={() => setCreating(true)} aria-label="New project">
                    +
                  </button>
                </div>
                <div class="tabs">
                  <For each={TABS}>
                    {([id, label]) => (
                      <button classList={{ active: tab() === id }} onClick={() => setTab(id)}>
                        {label}
                      </button>
                    )}
                  </For>
                </div>
                <span class="spacer" />
                <Toggle
                  label="ADHD mode"
                  title="Agents reply with one result line and at most three bullet points"
                  checked={project().settings.adhd}
                  onChange={(on) => saveSettings((s) => void (s.adhd = on))}
                />
                <button classList={{ primary: project().paused }} onClick={togglePause}>
                  {project().paused ? 'Resume' : 'Pause'}
                </button>
              </header>

              <Show when={notice()}>
                <div class="notice">{notice()}</div>
              </Show>

              <Switch>
                <Match when={tab() === 'board'}>
                  <Board />
                </Match>
                <Match when={tab() === 'dashboard'}>
                  <Dashboard />
                </Match>
                <Match when={tab() === 'agents'}>
                  <Agents />
                </Match>
                <Match when={tab() === 'skills'}>
                  <Skills />
                </Match>
                <Match when={tab() === 'usage'}>
                  <Usage />
                </Match>
                <Match when={tab() === 'watchdog'}>
                  <Watchdog />
                </Match>
                <Match when={tab() === 'routines'}>
                  <Routines />
                </Match>
                <Match when={tab() === 'settings'}>
                  <ProjectSettings />
                </Match>
              </Switch>
            </>
          )}
        </Show>
      </main>

      <Show when={detail.current}>
        <IssuePanel />
      </Show>
      <Show when={showProviders()}>
        <Providers onClose={() => setShowProviders(false)} />
      </Show>
      <Show when={creating()}>
        <NewProject onClose={() => setCreating(false)} />
      </Show>
      <Show when={needsLogin()}>
        <Login />
      </Show>
      <Show when={error() && !needsLogin()}>
        <div class="toast" role="alert">
          {error()}
        </div>
      </Show>
    </div>
  )
}

function Welcome(props: { onCreate: () => void }) {
  return (
    <div class="welcome">
      <h1>No project yet</h1>
      <p class="muted">Describe what you want built and let the AI suggest agents, skills and issues.</p>
      <button class="primary" onClick={props.onCreate}>
        Create your first project
      </button>
    </div>
  )
}
