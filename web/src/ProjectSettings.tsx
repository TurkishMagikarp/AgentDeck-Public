import { api } from './api'
import { Icon } from './icons'
import { board, closeProject, fail, loadProjects, saveSettings } from './store'
import { createResource, createSignal, For, Show } from 'solid-js'
import { Field, Select, Toggle } from './ui'

const LANDING_MODES = [
  ['off', 'Off'],
  ['merge', 'Merge directly'],
  ['pr', 'Pull request, merge after green checks'],
] as const

const MERGE_METHODS = [
  ['merge', 'Merge commit'],
  ['squash', 'Squash'],
  ['rebase', 'Rebase'],
] as const

const splitLines = (text: string) =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)

/** Long enough that nobody guesses the showcase link. */
function randomSlug() {
  const bytes = crypto.getRandomValues(new Uint8Array(9))
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
}

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
            hint="Per agent: each agent keeps its own checkout, so build caches (asset import, node_modules) survive."
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
              aria-label="Landing"
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
              <Show when={project().settings.landing.mode === 'pr'}>
                <Field label="Merge method">
                  <Select
                    value={project().settings.landing.mergeMethod}
                    options={MERGE_METHODS}
                    onChange={(method) => saveSettings((s) => void (s.landing.mergeMethod = method))}
                  />
                </Field>
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
            <div class="row">
              <Field
                label="Evidence required for"
                hint="Paths, one per line. If a branch changes anything under them, the agent's summary must contain one of the evidence lines on the right, otherwise the issue goes back to the agent."
              >
                <textarea
                  rows="3"
                  class="mono"
                  placeholder={'src/ui/\nassets/'}
                  value={project().settings.landing.evidence.paths.join('\n')}
                  onChange={(e) => {
                    const paths = splitLines(e.currentTarget.value)
                    saveSettings((s) => void (s.landing.evidence.paths = paths))
                  }}
                />
              </Field>
              <Field label="Evidence lines" hint='Text, one per line, e.g. "Screenshot:".'>
                <textarea
                  rows="3"
                  class="mono"
                  placeholder={'Screenshot:\nUI unchanged'}
                  value={project().settings.landing.evidence.markers.join('\n')}
                  onChange={(e) => {
                    const markers = splitLines(e.currentTarget.value)
                    saveSettings((s) => void (s.landing.evidence.markers = markers))
                  }}
                />
              </Field>
            </div>
            <Field
              label="GitHub token file"
              hint="Optional. Path in the container to a token for this project only, such as a GitHub App token that a host job renews. Agents get it as GH_TOKEN, and landing uses it. Empty = GitHub connection or gh login."
            >
              <input
                class="mono"
                placeholder="/run/github/token"
                value={project().settings.landing.githubTokenFile}
                onChange={(e) => {
                  const file = e.currentTarget.value.trim()
                  saveSettings((s) => void (s.landing.githubTokenFile = file))
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

        <section class="section">
          <div class="section-head">
            <h3>Cost cap per issue</h3>
          </div>
          <p class="muted">
            If an issue uses more, it is parked after the current run and you get notified. "Allow another
            round" lets it use the same amount again. 0 = no cap.
          </p>
          <div class="row">
            <Field label="Dollars" hint="As reported by the provider, also on a subscription">
              <input
                type="number"
                min="0"
                step="0.5"
                value={project().settings.issueCap.usd}
                onChange={(e) => {
                  const usd = Math.max(0, Number(e.currentTarget.value) || 0)
                  saveSettings((s) => void (s.issueCap.usd = usd))
                }}
              />
            </Field>
            <Field label="Thousand tokens" hint="New tokens, without cache">
              <input
                type="number"
                min="0"
                step="50"
                value={project().settings.issueCap.tokens / 1000}
                onChange={(e) => {
                  const tokens = Math.max(0, Math.round(Number(e.currentTarget.value) * 1000) || 0)
                  saveSettings((s) => void (s.issueCap.tokens = tokens))
                }}
              />
            </Field>
          </div>
        </section>

        <section class="section">
          <div class="section-head">
            <h3>Preview with screenshots</h3>
          </div>
          <p class="muted">
            When work goes to review, AgentDeck starts the app from the branch, takes a desktop and a phone
            screenshot and stops it again. The images show in the issue, and the reviewer gets them too.
          </p>
          <div class="row">
            <Field label="Start command" hint="$PORT is replaced by a free port. Empty = off.">
              <input
                class="mono"
                placeholder="npm run dev -- --port $PORT"
                value={project().settings.preview.command}
                onChange={(e) => {
                  const command = e.currentTarget.value.trim()
                  saveSettings((s) => void (s.preview.command = command))
                }}
              />
            </Field>
            <Field label="Page" hint="Path that gets captured">
              <input
                class="mono"
                value={project().settings.preview.path}
                onChange={(e) => {
                  const path = e.currentTarget.value.trim() || '/'
                  saveSettings((s) => void (s.preview.path = path))
                }}
              />
            </Field>
          </div>
        </section>

        <section class="section">
          <div class="section-head">
            <h3>Showcase</h3>
            <Toggle
              label="Public page"
              checked={project().settings.showcase.enabled}
              onChange={(on) =>
                saveSettings((s) => {
                  s.showcase.enabled = on
                  if (on && !s.showcase.slug) s.showcase.slug = randomSlug()
                })
              }
            />
          </div>
          <p class="muted">
            A page without login that shows which agents are working right now and what got done. No code, no
            comments, no costs. Anyone with the link can see it.
          </p>
          <Show when={project().settings.showcase.enabled}>
            <div class="inline-row">
              <a
                class="mono"
                href={`/show/${project().settings.showcase.slug}`}
                target="_blank"
                rel="noreferrer"
              >
                {location.origin}/show/{project().settings.showcase.slug}
              </a>
              <button
                class="ghost"
                title="The old link stops working afterwards"
                onClick={() => saveSettings((s) => void (s.showcase.slug = randomSlug()))}
              >
                New link
              </button>
            </div>
            <Toggle
              label="Show issue titles"
              checked={project().settings.showcase.titles}
              onChange={(on) => saveSettings((s) => void (s.showcase.titles = on))}
            />
          </Show>
        </section>

        <Lessons projectId={project().id} />

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

type Lesson = { id: number; body: string; source: string; created_at: number }

/** Notes every run of the project reads: written by agents, by the self-healing, or by hand. */
function Lessons(props: { projectId: number }) {
  const [lessons, { mutate }] = createResource(
    () => props.projectId,
    (id) => api.get<Lesson[]>(`/projects/${id}/lessons`),
  )
  const [draft, setDraft] = createSignal('')

  function add() {
    if (!draft().trim()) return
    api
      .post<Lesson[]>(`/projects/${props.projectId}/lessons`, { body: draft() })
      .then((list) => {
        mutate(list)
        setDraft('')
      })
      .catch(fail)
  }

  function remove(lesson: Lesson) {
    api.del<Lesson[]>(`/projects/${props.projectId}/lessons/${lesson.id}`).then(mutate).catch(fail)
  }

  return (
    <section class="section">
      <div class="section-head">
        <h3>Lessons learned</h3>
      </div>
      <p class="muted">
        Every run reads the latest 15 notes. Agents write them themselves when they find out something that is
        not in the repository.
      </p>
      <ul class="lessons">
        <For each={lessons()} fallback={<li class="muted">Nothing learned yet.</li>}>
          {(lesson) => (
            <li>
              <span>{lesson.body}</span>
              <small class="muted">{lesson.source}</small>
              <button
                class="ghost icon-button"
                title="Delete note"
                aria-label="Delete note"
                onClick={() => remove(lesson)}
              >
                <Icon name="close" size={14} />
              </button>
            </li>
          )}
        </For>
      </ul>
      <div class="inline-row">
        <input
          placeholder='e.g. Tests run with "npm test -- --run"'
          aria-label="New note"
          value={draft()}
          onInput={(e) => setDraft(e.currentTarget.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()}
        />
        <button onClick={add}>Add</button>
      </div>
    </section>
  )
}
