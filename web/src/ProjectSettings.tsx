import { api } from './api'
import { Icon } from './icons'
import { board, closeProject, fail, loadProjects, saveSettings, setBoard } from './store'
import type { Webhook, WebhookEvent } from './types'
import { createResource, createSignal, For, onCleanup, onMount, Show } from 'solid-js'
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

/**
 * A row of jump links over a long settings page: one per block, the one in view highlighted.
 * The blocks are found in the page itself, so a new block shows up here without extra code.
 */
function SectionRail(props: { root: () => HTMLElement | undefined }) {
  const [items, setItems] = createSignal<{ el: HTMLElement; label: string }[]>([])
  const [active, setActive] = createSignal(0)

  onMount(() => {
    const root = props.root()
    if (!root) return
    const scan = () => {
      const found = [...root.querySelectorAll<HTMLElement>('.section')]
        .map((el) => ({ el, label: el.querySelector('h3')?.textContent?.trim() ?? '' }))
        .filter((item) => item.label)
      // The rail sits inside the page it watches: only a real change of the blocks may update it,
      // or its own redraw would trigger the observer again, forever.
      const same =
        found.length === items().length && found.every((item, index) => item.el === items()[index].el && item.label === items()[index].label)
      if (!same) setItems(found)
    }
    const follow = () => {
      const top = root.getBoundingClientRect().top + 90
      const index = items().findLastIndex((item) => item.el.getBoundingClientRect().top <= top)
      setActive(Math.max(0, index))
    }
    scan()
    // Blocks appear and disappear with the settings (webhooks, network mode), so look again on change.
    const observer = new MutationObserver(() => {
      scan()
      follow()
    })
    observer.observe(root, { childList: true, subtree: true })
    root.addEventListener('scroll', follow, { passive: true })
    onCleanup(() => {
      observer.disconnect()
      root.removeEventListener('scroll', follow)
    })
  })

  return (
    <Show when={items().length > 1}>
      <nav class="section-rail" aria-label="Sections of this page">
        <For each={items()}>
          {(item, index) => (
            <button
              classList={{ active: active() === index() }}
              aria-current={active() === index() ? 'true' : undefined}
              onClick={() => {
                setActive(index())
                item.el.scrollIntoView({ behavior: 'smooth', block: 'start' })
              }}
            >
              {item.label}
            </button>
          )}
        </For>
      </nav>
    </Show>
  )
}

/** Long enough that nobody guesses the showcase link. */
function randomSlug() {
  const bytes = crypto.getRandomValues(new Uint8Array(9))
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
}

const EGRESS_MODES = [
  ['open', 'Open'],
  ['allowlist', 'Allowed hosts only'],
] as const

const WORKSPACES = [
  ['issue', 'One worktree per issue'],
  ['agent', 'One checkout per agent'],
] as const

const TEMPLATE_EXAMPLE = `## UI
Agents: Frontend
Title: page, view
- Screenshot before and after in the repo
- Keyboard use checked

## All
- Only files changed that the issue asks for`

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

  let page: HTMLDivElement | undefined

  return (
    <div class="page narrow" ref={page}>
      <div class="page-head">
        <h2>Project</h2>
      </div>
      <SectionRail root={() => page} />
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
        <div class="row">
          <Toggle
            label="Record the history of runs"
            title='Stores the prompt, tool calls, results, answers and the changes of every run, shortened and without detected secrets. To be seen under "Show history" at every run, for 30 days.'
            checked={project().settings.replay}
            onChange={(on) => saveSettings((s) => void (s.replay = on))}
          />
        </div>
        <section class="section">
          <div class="section-head">
            <h3>Acceptance</h3>
          </div>
          <p class="muted">
            Every issue gets a checklist: its "Done when" plus the matching template. The agent reports every
            item with proof, and the reviewers judge only by that. If something is still missing, only the
            first reviewer checks the interim state.
          </p>
          <div class="row">
            <Toggle
              label="Acceptance checklists"
              checked={project().settings.checklists.enabled}
              onChange={(on) => saveSettings((s) => void (s.checklists.enabled = on))}
            />
            <Toggle
              label="After changes, resume with the same reviewer"
              checked={project().settings.resumeReview}
              onChange={(on) => saveSettings((s) => void (s.resumeReview = on))}
            />
          </div>
          <Show when={project().settings.checklists.enabled}>
            <Field
              label="Templates"
              hint="'## Name' starts a template. 'Agents:' and 'Title:' (comma-separated) say what it applies to; the first match is used. A template without either applies to every issue. Items start with '- '."
            >
              <textarea
                rows="12"
                class="mono"
                placeholder={TEMPLATE_EXAMPLE}
                value={project().settings.checklists.templates}
                onChange={(e) => {
                  const templates = e.currentTarget.value
                  saveSettings((s) => void (s.checklists.templates = templates))
                }}
              />
            </Field>
          </Show>
          <Toggle
            label="Precheck before every review"
            checked={project().settings.precheck.enabled}
            onChange={(on) => saveSettings((s) => void (s.precheck.enabled = on))}
          />
          <Show when={project().settings.precheck.enabled}>
            <p class="muted">
              Before a reviewer sees the work: proof files present, everything committed, base branch merged
              in without conflicts, check command green. Otherwise the issue goes back without a review run.
            </p>
            <div class="row">
              <Field label="Check command" hint="Runs in the agent's checkout. Empty = only proof and merge.">
                <input
                  class="mono"
                  placeholder="npm test"
                  value={project().settings.precheck.command}
                  onChange={(e) => {
                    const command = e.currentTarget.value.trim()
                    saveSettings((s) => void (s.precheck.command = command))
                  }}
                />
              </Field>
              <Field label="Time limit (minutes)">
                <input
                  type="number"
                  min="1"
                  max="60"
                  value={project().settings.precheck.timeoutMin}
                  onChange={(e) => {
                    const minutes = Number(e.currentTarget.value) || 20
                    saveSettings((s) => void (s.precheck.timeoutMin = minutes))
                  }}
                />
              </Field>
            </div>
            <Toggle
              label="Run the check command only before landing"
              checked={project().settings.precheck.commandAt === 'landing'}
              onChange={(on) => saveSettings((s) => void (s.precheck.commandAt = on ? 'landing' : 'review'))}
            />
            <p class="muted">
              On: the reviewers see the work at once. The check command runs once after the last approval on
              the merged state, and only green is pushed. Red goes back to the maker with the output. Agents
              then do not run the full test suite themselves. Only with landing "Merge".
            </p>
          </Show>
        </section>
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
                <Field label="Merge-Art">
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
            <Field
              label="Approval before landing"
              hint='What matches here does not land automatically but waits for "Approve landing" in the issue. The approval holds for exactly one state of the branch; if it changes after that, it needs a new one.'
            >
              <div class="row">
                <Toggle
                  label="Every landing"
                  checked={project().settings.landing.approval.merge}
                  onChange={(on) => saveSettings((s) => void (s.landing.approval.merge = on))}
                />
                <Toggle
                  label="New dependencies"
                  title="package.json, requirements*.txt, pyproject.toml, Cargo.toml, go.mod, Gemfile, composer.json: new packages, not plain version changes"
                  checked={project().settings.landing.approval.dependencies}
                  onChange={(on) => saveSettings((s) => void (s.landing.approval.dependencies = on))}
                />
                <Toggle
                  label="Infrastructure files"
                  checked={project().settings.landing.approval.infra}
                  onChange={(on) => saveSettings((s) => void (s.landing.approval.infra = on))}
                />
              </div>
            </Field>
            <Show when={project().settings.landing.approval.infra}>
              <Field
                label="Infrastructure patterns"
                hint='One pattern per line. Without "/" it applies to the file name in any folder (*.tf), with "/" from the root of the repository (docker/**). ** includes subfolders.'
              >
                <textarea
                  rows="4"
                  class="mono"
                  value={project().settings.landing.approval.infraGlobs.join('\n')}
                  onChange={(e) => {
                    const globs = splitLines(e.currentTarget.value)
                    saveSettings((s) => void (s.landing.approval.infraGlobs = globs))
                  }}
                />
              </Field>
            </Show>
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

        <Webhooks projectId={project().id} />

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

        <Egress projectId={project().id} />

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

        <GithubIntake />

        <Connect />

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

const INTAKE_STATUSES = [
  ['backlog', 'Backlog: look first'],
  ['todo', 'To Do: agents start at once'],
] as const

const GITHUB_REPO = /^[\w.-]{1,39}\/[\w.-]{1,100}$/

/** GitHub issues with the project's label are filed on the board (server/intake.ts). */
function GithubIntake() {
  const intake = () => board.project!.settings.intake
  const switchOn = (on: boolean) => {
    if (on && !GITHUB_REPO.test(intake().repo)) return fail(new Error('Enter the repository as owner/name first.'))
    saveSettings((s) => void (s.intake.enabled = on))
  }

  return (
    <section class="section">
      <div class="section-head">
        <h3>Take in GitHub issues</h3>
        <Toggle label="Take in issues with the label" checked={intake().enabled} onChange={switchOn} />
      </div>
      <p class="muted">
        When an issue in the repository gets the label, AgentDeck creates it here and the agents take over. On
        GitHub only people who work on the repository may set a label: strangers can write an issue, but cannot
        hand it to the agents. The text still comes from outside, so the backlog is the default.
      </p>
      <div class="row">
        <Field label="Repository" hint="owner/name, as in the address on GitHub">
          <input
            class="mono"
            placeholder="acme/shop"
            value={intake().repo}
            onChange={(e) => {
              const repo = e.currentTarget.value.trim()
              saveSettings((s) => {
                s.intake.repo = GITHUB_REPO.test(repo) ? repo : ''
                if (!s.intake.repo) s.intake.enabled = false
              })
            }}
          />
        </Field>
        <Field label="Label">
          <input
            value={intake().label}
            onChange={(e) => saveSettings((s) => void (s.intake.label = e.currentTarget.value.trim() || 'agentdeck'))}
          />
        </Field>
        <Field label="Lands in">
          <Select
            value={intake().status}
            options={INTAKE_STATUSES}
            onChange={(status) => saveSettings((s) => void (s.intake.status = status))}
          />
        </Field>
      </div>
      <p class="muted">
        Needs the GitHub webhook of this server (<span class="mono">{location.origin}/api/github/webhook</span>) with
        the "Issues" event. Setup: README, "Approval gates and GitHub webhooks".
      </p>
    </section>
  )
}

/** How tools outside reach this server: the MCP endpoint and the metrics. The same for every project. */
function Connect() {
  const endpoint = `${location.origin}/api/mcp-server`
  const command = `claude mcp add --transport http agentdeck ${endpoint} --header "Authorization: Bearer $AGENTDECK_TOKEN"`
  const [copied, setCopied] = createSignal(false)
  const copy = () =>
    navigator.clipboard.writeText(command).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }, fail)

  return (
    <section class="section">
      <div class="section-head">
        <h3>Control from outside</h3>
      </div>
      <p class="muted">
        AgentDeck is an MCP server itself. Claude Code, Codex, Cursor or a chat app use it to read the boards,
        create issues, comment on them, move and stop them, with the rights of the token used. Applies to
        all projects.
      </p>
      <div class="inline-row">
        <code class="connect-command">{command}</code>
        <button class="ghost" onClick={copy}>
          {copied() ? 'Copied' : 'Copy'}
        </button>
      </div>
      <p class="muted">
        Numbers for Prometheus and Grafana (issues, runs, costs, tokens, quotas):{' '}
        <span class="mono">{location.origin}/api/metrics</span>, with a bearer token as well.
      </p>
    </section>
  )
}

const WEBHOOK_EVENTS: readonly (readonly [WebhookEvent, string])[] = [
  ['review', 'Ready for review'],
  ['blocked', 'Blocked'],
  ['done', 'Done'],
  ['failed', 'Run failed'],
  ['owner', 'Waits for you'],
]

const WEBHOOK_KINDS = [
  ['slack', 'Slack'],
  ['generic', 'Generic (JSON, signed)'],
] as const

/** Slack or any HTTPS endpoint. The URL is sent once and stays on the server, like the secret. */
function Webhooks(props: { projectId: number }) {
  const hooks = () => board.project?.settings.webhooks ?? []
  const [url, setUrl] = createSignal('')
  const [kind, setKind] = createSignal<Webhook['kind']>('slack')
  const [events, setEvents] = createSignal<WebhookEvent[]>(['blocked', 'done', 'owner'])
  const [secret, setSecret] = createSignal('')
  const [result, setResult] = createSignal('')

  const toggle = (list: WebhookEvent[], event: WebhookEvent, on: boolean) =>
    on ? [...list.filter((e) => e !== event), event] : list.filter((e) => e !== event)

  function add() {
    if (!url().trim()) return
    api
      .post<{ webhook: Webhook; secret?: string }>(`/projects/${props.projectId}/webhooks`, {
        url: url().trim(),
        kind: kind(),
        events: events(),
      })
      .then((created) => {
        setBoard('project', 'settings', 'webhooks', (list) => [...list, created.webhook])
        setSecret(created.secret ?? '')
        setUrl('')
      })
      .catch(fail)
  }

  function remove(hook: Webhook) {
    if (!confirm(`Delete the webhook to ${hook.host}?`)) return
    api
      .del(`/projects/${props.projectId}/webhooks/${hook.id}`)
      .then(() => setBoard('project', 'settings', 'webhooks', (list) => list.filter((h) => h.id !== hook.id)))
      .catch(fail)
  }

  function test(hook: Webhook) {
    setResult('')
    api
      .post<{ status: number }>(`/projects/${props.projectId}/webhooks/${hook.id}/test`)
      .then((r) => setResult(`${hook.host}: delivered (HTTP ${r.status})`))
      .catch(fail)
  }

  return (
    <section class="section">
      <div class="section-head">
        <h3>Webhooks</h3>
      </div>
      <p class="muted">
        Reports status changes to Slack or an endpoint of your own. Only https, no addresses in a private network.
        Project, issue number, title and status are sent, never code or comments. Generic webhooks
        are signed with HMAC-SHA256 (header X-AgentDeck-Signature).
      </p>
      <ul class="lessons">
        <For each={hooks()} fallback={<li class="muted">No webhooks yet.</li>}>
          {(hook) => (
            <li class="webhook">
              <span>
                <strong>{hook.kind === 'slack' ? 'Slack' : 'Generic'}</strong>{' '}
                <span class="mono">{hook.host}</span>
                <span class="webhook-events">
                  <For each={WEBHOOK_EVENTS}>
                    {([event, label]) => (
                      <Toggle
                        label={label}
                        checked={hook.events.includes(event)}
                        onChange={(on) =>
                          saveSettings((s) => {
                            const target = s.webhooks.find((h) => h.id === hook.id)
                            if (target) target.events = toggle(target.events, event, on)
                          })
                        }
                      />
                    )}
                  </For>
                </span>
              </span>
              <button class="ghost" onClick={() => test(hook)}>
                Test
              </button>
              <button
                class="ghost icon-button"
                title="Delete webhook"
                aria-label="Delete webhook"
                onClick={() => remove(hook)}
              >
                <Icon name="close" size={14} />
              </button>
            </li>
          )}
        </For>
      </ul>
      <Show when={result()}>
        <p class="muted">{result()}</p>
      </Show>
      <Show when={secret()}>
        <div class="notice">
          Signing secret, shown only now: <code class="mono">{secret()}</code>{' '}
          <button class="ghost" onClick={() => setSecret('')}>
            Noted
          </button>
        </div>
      </Show>
      <div class="inline-row">
        <input
          class="mono"
          placeholder="https://hooks.slack.com/services/…"
          aria-label="Webhook address"
          value={url()}
          onInput={(e) => setUrl(e.currentTarget.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()}
        />
        <Select aria-label="Kind" value={kind()} options={WEBHOOK_KINDS} onChange={setKind} />
        <button onClick={add}>Add</button>
      </div>
      <div class="webhook-events">
        <For each={WEBHOOK_EVENTS}>
          {([event, label]) => (
            <Toggle
              label={label}
              checked={events().includes(event)}
              onChange={(on) => setEvents((list) => toggle(list, event, on))}
            />
          )}
        </For>
      </div>
    </section>
  )
}

type EgressStatus = {
  sandbox: boolean
  mode: 'open' | 'allowlist'
  firewall: 'off' | 'open' | 'pending' | 'active' | 'unavailable'
  error: string
  blocked: { target: string; at: number }[]
}

/** Outbound network of the project's agents: open, or only the hosts on the list. */
function Egress(props: { projectId: number }) {
  const egress = () => board.project!.settings.egress
  const [status, { refetch }] = createResource(
    () => [props.projectId, egress().mode] as const,
    ([id]) => api.get<EgressStatus>(`/projects/${id}/egress`),
  )
  // The firewall is set up in the background; one more look shows how it went.
  const later = () => setTimeout(refetch, 1500)

  const allow = (target: string) => {
    // Without a port the entry covers 80 and 443 anyway.
    const entry = target.replace(/:(80|443)$/, '')
    saveSettings((s) => void (s.egress.allow = [...s.egress.allow.filter((e) => e !== entry), entry]))?.then(later)
  }

  const firewallText = (s: EgressStatus) => {
    if (!s.sandbox) return 'No sandbox: the setting only takes effect in the container.'
    if (s.mode === 'open') return 'Open: the agents reach every host.'
    if (s.firewall === 'active') return 'Firewall active: other targets and DNS are blocked.'
    if (s.firewall === 'unavailable')
      return `Firewall not available, the project is open (${s.error || 'error'}). The container needs iptables and NET_ADMIN, see the README.`
    return 'Setting up the firewall…'
  }

  return (
    <section class="section">
      <div class="section-head">
        <h3>Network of the agents</h3>
      </div>
      <p class="muted">
        With an allowlist the agents of this project reach only the listed hosts, through a proxy in
        AgentDeck. The container's firewall blocks everything else, DNS too. Git over SSH does not work then, Git
        over HTTPS does. AgentDeck itself (board, API) stays reachable.
      </p>
      <div class="row">
        <Field label="Outbound connections">
          <Select
            value={egress().mode}
            options={EGRESS_MODES}
            onChange={(mode) => saveSettings((s) => void (s.egress.mode = mode))?.then(later)}
          />
        </Field>
      </div>
      <Field
        label="Allowed hosts"
        hint="One entry per line: github.com, *.example.com (subdomains only), host:8443, 192.0.2.7. Without a port, 80 and 443 apply. Invalid entries are dropped."
      >
        <textarea
          rows="6"
          class="mono"
          value={egress().allow.join('\n')}
          onChange={(e) => {
            const allow = splitLines(e.currentTarget.value)
            saveSettings((s) => void (s.egress.allow = allow))
          }}
        />
      </Field>
      <Show when={status()}>
        {(s) => (
          <>
            <p class="muted">{firewallText(s())}</p>
            <Show when={s().blocked.length}>
              <p class="muted">Blocked recently:</p>
              <div class="chips">
                <For each={s().blocked}>
                  {(b) => (
                    <button class="ghost" title="Put on the allowlist" onClick={() => allow(b.target)}>
                      Allow {b.target}
                    </button>
                  )}
                </For>
              </div>
            </Show>
          </>
        )}
      </Show>
    </section>
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
          placeholder='e.g. tests run with "npm test -- --run"'
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
