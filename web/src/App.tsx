import { createEffect, createSignal, For, Match, onCleanup, onMount, Show, Switch } from 'solid-js'
import { Agents } from './Agents'
import { api, needsLogin } from './api'
import { Login } from './Login'
import { AuditLog } from './AuditLog'
import { ROLE_LABELS, Users } from './Users'
import { ConfirmToken } from './Confirm'
import { Board } from './Board'
import { Dashboard } from './Dashboard'
import { Journal } from './Journal'
import { fleet, refreshFleet } from './fleet'
import { MissionControl } from './MissionControl'
import { Dependencies } from './Dependencies'
import { GitView } from './GitView'
import { SearchPalette, type Capture, type Command } from './SearchPalette'
import { Icon } from './icons'
import { IssuePage } from './IssuePage'
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
  say,
  info,
  openProject,
  openingProject,
  projects,
  saveSettings,
  loadIssue,
  closeIssue,
  switchingProject,
} from './store'
import { Providers } from './Providers'
import { nextTheme, setTheme, theme } from './theme'
import { Modal, Toggle } from './ui'
import { Usage } from './Usage'
import { Routines } from './Routines'
import { Watchdog } from './Watchdog'

/** What the team does: the views you look at every day. */
const VIEWS = [
  ['board', 'Board', 'board'],
  ['dashboard', 'Statistics', 'chart'],
  ['journal', 'Journal', 'journal'],
  ['dependencies', 'Dependencies', 'network'],
  ['git', 'Git', 'branch'],
  ['agents', 'Agents', 'users'],
] as const

/** How the project is set up: grouped behind one tab, so the bar stays short. */
const SETTINGS = [
  ['settings', 'Project'],
  ['usage', 'Usage & routing'],
  ['routines', 'Routines'],
  ['watchdog', 'Watchdog'],
  ['skills', 'Skills'],
] as const

type Tab = (typeof VIEWS)[number][0] | (typeof SETTINGS)[number][0]
const isSettings = (tab: Tab) => SETTINGS.some(([id]) => id === tab)

export function App() {
  const [tab, setTab] = createSignal<Tab>('board')
  // Coming back to the settings opens the page that was open last.
  const [lastSettings, setLastSettings] = createSignal<Tab>('settings')
  const openTab = (next: Tab) => {
    if (isSettings(next)) setLastSettings(next)
    setTab(next)
  }
  // The tab bar scrolls when it is narrow: the open tab must never sit out of sight.
  createEffect(() => {
    tab()
    queueMicrotask(() =>
      document.querySelector('.tabs button.active')?.scrollIntoView({ inline: 'nearest', block: 'nearest' }),
    )
  })
  const [creating, setCreating] = createSignal(false)
  const [showProviders, setShowProviders] = createSignal(false)
  const [showAudit, setShowAudit] = createSignal(false)
  const [showUsers, setShowUsers] = createSignal(false)
  // Who is logged in. The server decides what each role may do; the UI only hides what would fail.
  const [me, setMe] = createSignal<{ name: string; role: 'viewer' | 'operator' | 'admin' } | null>(null)
  const isAdmin = () => me()?.role === 'admin'

  async function logout() {
    await api.post('/logout').catch(fail)
    location.reload()
  }
  const [searching, setSearching] = createSignal(false)
  // On phones the sidebar is hidden; its footer tools live in this menu.
  const [more, setMore] = createSignal(false)
  // The home page is the fleet overview; a project opens when one is picked.
  const [home, setHome] = createSignal(true)

  // Ctrl+K (Cmd+K) everywhere, "/" when no field has the focus, as in Jira and GitHub.
  const openSearchByKey = (e: KeyboardEvent) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target as HTMLElement)?.tagName ?? '')
    if ((e.key === 'k' && (e.ctrlKey || e.metaKey)) || (e.key === '/' && !typing)) {
      e.preventDefault()
      setSearching(true)
    }
  }
  onMount(() => document.addEventListener('keydown', openSearchByKey))
  onCleanup(() => document.removeEventListener('keydown', openSearchByKey))

  /** A sentence typed into Ctrl+K becomes an issue in the open project, or the one used last. */
  const capture = (): Capture | undefined => {
    const lastId = Number(localStorage.getItem('agentdeck.project'))
    const target =
      (!home() && projects().find((p) => p.id === board.project?.id)) ||
      projects().find((p) => p.id === lastId) ||
      projects()[0]
    if (!target) return
    return {
      project: target.name,
      create: (title) =>
        api
          .post<{ number: number }>(`/projects/${target.id}/issues`, { title, status: 'backlog' })
          .then((issue) => {
            say(`${target.key}-${issue.number} created in the backlog`)
            return Promise.all([loadProjects(), refreshFleet()])
          })
          .catch(fail),
    }
  }

  /** What Ctrl+K can do besides finding issues. */
  const commands = (): Command[] => [
    { id: 'home', label: 'Open Mission Control', hint: 'G then M', run: () => setHome(true) },
    ...(isAdmin() ? [{ id: 'new', label: 'Create a new project', run: () => setCreating(true) }] : []),
    ...(isAdmin() ? [{ id: 'providers', label: 'Providers and access', run: () => setShowProviders(true) }] : []),
    { id: 'theme', label: 'Switch theme (system, dark, light)', run: () => setTheme(nextTheme(theme())) },
    ...projects().map((project) => ({
      id: `project-${project.id}`,
      label: `Open project: ${project.name}`,
      hint: project.key,
      run: () => selectProject(project.id),
    })),
    ...(board.project && !home()
      ? [
          { id: 'pause', label: board.project.paused ? 'Resume project' : 'Pause project', run: togglePause },
          ...VIEWS.map(([id, label]) => ({ id: `tab-${id}`, label: `View: ${label}`, run: () => openTab(id) })),
        ]
      : []),
  ]

  // "G" then "M" jumps home, like GitHub's "G then P". Only when no field has the focus.
  let goKey = 0
  const goHomeByKey = (e: KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return
    if (/^(INPUT|TEXTAREA|SELECT)$/.test((e.target as HTMLElement)?.tagName ?? '')) return
    if (e.key === 'g') goKey = Date.now()
    else if (e.key === 'm' && Date.now() - goKey < 1200) setHome(true)
  }
  onMount(() => document.addEventListener('keydown', goHomeByKey))
  onCleanup(() => document.removeEventListener('keydown', goHomeByKey))

  // The badge on "Mission Control" and the tab title follow the fleet, whatever page is open.
  onMount(() => {
    const poll = setInterval(() => document.visibilityState === 'visible' && refreshFleet().catch(() => {}), 10_000)
    onCleanup(() => clearInterval(poll))
    refreshFleet().catch(() => {})
  })
  createEffect(() => {
    const waiting = fleet()?.inbox.length ?? 0
    document.title = waiting ? `(${waiting}) AgentDeck` : 'AgentDeck'
  })

  onMount(async () => {
    try {
      await Promise.all([loadProjects(), loadMeta(), api.get<any>('/me').then(setMe)])
      if (await openLinkedIssue()) return
      const lastId = Number(localStorage.getItem('agentdeck.project'))
      const start = projects().find((p) => p.id === lastId) ?? projects()[0]
      if (start) await openProject(start.id)
    } catch (err) {
      fail(err)
    }
  })

  /**
   * "#KEY-123" is the page of an issue, like a Jira link: mails, search results and shared links
   * open it as a full page. Returns false when the address names no issue.
   */
  async function openLinkedIssue() {
    const link = location.hash.match(/^#([A-Z][A-Z0-9]+)-(\d+)$/)
    if (!link) {
      // Back from an issue page to the board.
      if (detail.current) closeIssue()
      return false
    }
    // The project may be newer than the list this tab loaded.
    if (!projects().some((p) => p.key === link[1])) await loadProjects()
    const project = projects().find((p) => p.key === link[1])
    if (!project) return false

    setHome(false)
    if (board.project?.id !== project.id) await openProject(project.id)
    const issue = board.issues.find((candidate) => candidate.number === Number(link[2]))
    if (issue) await loadIssue(issue.id)
    return true
  }
  window.addEventListener('hashchange', () => openLinkedIssue().catch(fail))

  function selectProject(projectId: number) {
    setHome(false)
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
        <button classList={{ 'home-link': true, active: home() }} onClick={() => setHome(true)}>
          <Icon name="radar" size={15} />
          <span class="project-name">Mission Control</span>
          <Show when={fleet()?.inbox.length}>
            {(count) => (
              <span class="needs-you" title={`${count()} need you`}>
                {count()}
              </span>
            )}
          </Show>
          <Show when={projects().reduce((n, p) => n + p.running, 0)}>
            {(count) => <span class="running-count">{count()}</span>}
          </Show>
        </button>
        <ul>
          <For each={projects()}>
            {(project) => (
              <li>
                <button
                  classList={{ active: !home() && project.id === (openingProject() ?? board.project?.id) }}
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
        <button class="ghost sidebar-link account" onClick={() => setMore(true)}>
          <span class="account-avatar" aria-hidden="true">
            {(me()?.name ?? 'AD').slice(0, 2).toUpperCase()}
          </span>
          <span class="account-text">
            <strong>{me()?.name ?? 'Account'}</strong>
            <Show when={me()}>{(who) => <span class="muted">{ROLE_LABELS[who().role]}</span>}</Show>
          </span>
          <Icon name="chevronRight" size={14} />
        </button>
        <Show when={isAdmin()}>
          <button class="new-project" onClick={() => setCreating(true)}>
            <Icon name="plus" size={14} />
            Project
          </button>
        </Show>
      </nav>

      <main classList={{ switching: switchingProject() }} aria-busy={switchingProject()}>
        <Show when={home() && projects().length}>
          <MissionControl
            onOpenProject={selectProject}
            onSearch={() => setSearching(true)}
            onProviders={() => setShowProviders(true)}
            onNewProject={() => setCreating(true)}
            admin={isAdmin()}
            onMore={() => setMore(true)}
          />
        </Show>
        <Show when={!(home() && projects().length) && board.project} fallback={<Show when={!projects().length}><Welcome onCreate={() => setCreating(true)} /></Show>}>
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
                        <option value={other.id} selected={other.id === (openingProject() ?? project().id)}>
                          {other.name}
                        </option>
                      )}
                    </For>
                  </select>
                  <button class="icon-button" onClick={() => setHome(true)} aria-label="Mission Control">
                    <Icon name="radar" />
                  </button>
                  <button class="icon-button" onClick={() => setSearching(true)} aria-label="Search issues">
                    <Icon name="search" />
                  </button>
                  <button class="icon-button" onClick={() => setMore(true)} aria-label="More">
                    <Icon name="settings" />
                  </button>
                  <button class="icon-button" onClick={() => setCreating(true)} aria-label="New project">
                    <Icon name="plus" />
                  </button>
                </div>
                <nav class="tabs" aria-label="Views">
                  <For each={VIEWS}>
                    {([id, label, icon]) => (
                      <button
                        classList={{ active: tab() === id }}
                        aria-current={tab() === id ? 'page' : undefined}
                        title={label}
                        onClick={() => openTab(id)}
                      >
                        <Icon name={icon} />
                        <span class="tab-label">{label}</span>
                      </button>
                    )}
                  </For>
                  <button
                    classList={{ active: isSettings(tab()) }}
                    aria-current={isSettings(tab()) ? 'page' : undefined}
                    title="Settings"
                    onClick={() => openTab(lastSettings())}
                  >
                    <Icon name="settings" />
                    <span class="tab-label">Settings</span>
                  </button>
                </nav>
                <span class="spacer" />
                <button class="search-button" onClick={() => setSearching(true)} aria-label="Search issues">
                  <Icon name="search" size={14} />
                  <span class="search-label">Search</span>
                  <kbd>Ctrl K</kbd>
                </button>
                <Toggle
                  label="ADHD mode"
                  title="Agents reply with one result line and at most three bullet points"
                  checked={project().settings.adhd}
                  onChange={(on) => saveSettings((s) => void (s.adhd = on))}
                />
                <Toggle
                  label="Caveman"
                  title="Agents write tersely like a caveman and save output tokens. Code, commands and status stay exact."
                  checked={project().settings.caveman}
                  onChange={(on) => saveSettings((s) => void (s.caveman = on))}
                />
                <button classList={{ primary: project().paused }} onClick={togglePause}>
                  <Icon name={project().paused ? 'play' : 'pause'} size={14} />
                  {project().paused ? 'Resume' : 'Pause'}
                </button>
              </header>

              <Show when={isSettings(tab())}>
                <nav class="subnav" aria-label="Settings">
                  <For each={SETTINGS}>
                    {([id, label]) => (
                      <button
                        classList={{ active: tab() === id }}
                        aria-current={tab() === id ? 'page' : undefined}
                        onClick={() => openTab(id)}
                      >
                        {label}
                      </button>
                    )}
                  </For>
                </nav>
              </Show>

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
                <Match when={tab() === 'journal'}>
                  <Journal />
                </Match>
                <Match when={tab() === 'dependencies'}>
                  <Dependencies />
                </Match>
                <Match when={tab() === 'git'}>
                  <GitView />
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

      <Show when={more()}>
        <Modal title="Account" popover onClose={() => setMore(false)}>
          <div class="more-menu">
            <Show when={isAdmin()}>
              <button onClick={() => (setMore(false), setShowProviders(true))}>Providers and access</button>
              <button onClick={() => (setMore(false), setShowUsers(true))}>Users</button>
              <button onClick={() => (setMore(false), setShowAudit(true))}>Audit log</button>
            </Show>
            <button onClick={() => setTheme(nextTheme(theme()))}>
              Theme: {{ system: 'System', dark: 'Dark', light: 'Light' }[theme()]}
            </button>
            <button onClick={logout}>
              Log out
              <Show when={me()}>{(who) => <span class="muted"> · {who().name} ({ROLE_LABELS[who().role]})</span>}</Show>
            </button>
          </div>
        </Modal>
      </Show>
      <Show when={searching()}>
        <SearchPalette onClose={() => setSearching(false)} commands={commands()} capture={capture()} />
      </Show>
      <Show when={detail.current}>
        <IssuePage />
      </Show>
      <Show when={showProviders()}>
        <Providers onClose={() => setShowProviders(false)} />
      </Show>
      <Show when={creating()}>
        <NewProject onClose={() => setCreating(false)} />
      </Show>
      <Show when={showUsers()}>
        <Users onClose={() => setShowUsers(false)} />
      </Show>
      <Show when={showAudit()}>
        <AuditLog onClose={() => setShowAudit(false)} />
      </Show>
      <ConfirmToken />
      <Show when={needsLogin()}>
        <Login />
      </Show>
      <Show when={info()}>
        <div class="toast ok" role="status">
          {info()}
        </div>
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
      <p class="muted">
        Describe what you want built and let the AI suggest agents, skills and issues.
      </p>
      <button class="primary" onClick={props.onCreate}>
        Create your first project
      </button>
    </div>
  )
}
