import { api } from './api'
import { Icon } from './icons'
import { board, closeProject, fail, loadProjects, saveSettings, setBoard } from './store'
import type { Webhook, WebhookEvent } from './types'
import { createResource, createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import { Field, Select, Toggle } from './ui'
import { t } from './i18n'

// Labels stay German keys in the constants; they are translated where they are shown.
const tl = <T extends string>(list: readonly (readonly [T, string])[]) =>
  list.map(([value, label]) => [value, t(label)] as const)

const LANDING_MODES = [
  ['off', 'Aus'],
  ['merge', 'Direkt mergen'],
  ['pr', 'Pull Request, Merge nach grünen Checks'],
] as const

const MERGE_METHODS = [
  ['merge', 'Merge-Commit'],
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
      <nav class="section-rail" aria-label={t('Abschnitte dieser Seite')}>
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
  ['open', 'Offen'],
  ['allowlist', 'Nur erlaubte Hosts'],
] as const

const WORKSPACES = [
  ['issue', 'Pro Issue ein Worktree'],
  ['agent', 'Pro Agent ein Checkout'],
] as const

const AGENT_LANGUAGES = [
  ['de', 'Deutsch'],
  ['en', 'English'],
] as const

const templateExample = () =>
  t(
    '## Oberfläche\nAgenten: Frontend\nTitel: seite, ansicht\n- Screenshot vorher und nachher im Repo\n- Tastaturbedienung geprüft\n\n## Alle\n- Nur Dateien geändert, die das Issue verlangt',
  )

export function ProjectSettings() {
  const project = () => board.project!

  function save(patch: Record<string, string>) {
    api.patch(`/projects/${project().id}`, patch).then(loadProjects).catch(fail)
  }

  async function remove() {
    if (!confirm(t('Projekt "{name}" mit allen Issues, Agenten und Läufen löschen?', { name: project().name }))) return
    await api.del(`/projects/${project().id}`).catch(fail)
    closeProject()
    await loadProjects()
  }

  let page: HTMLDivElement | undefined

  return (
    <div class="page narrow" ref={page}>
      <div class="page-head">
        <h2>{t('Projekt')}</h2>
      </div>
      <SectionRail root={() => page} />
      <div class="form">
        <div class="row">
          <Field label={t('Name')}>
            <input value={project().name} onChange={(e) => save({ name: e.currentTarget.value })} />
          </Field>
          <Field label={t('Gleichzeitige Agenten')} hint={t('Obergrenze für das ganze Projekt')}>
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
            label={t('Arbeitsordner')}
            hint={t('Pro Agent: ein fester Checkout je Agent, Build-Caches (Asset-Import, node_modules) bleiben erhalten.')}
          >
            <Select
              value={project().settings.workspace}
              options={tl(WORKSPACES)}
              onChange={(workspace) => saveSettings((s) => void (s.workspace = workspace))}
            />
          </Field>
          <Field label={t('Änderungsrunden im Review')} hint={t('Danach entscheidet ein Mensch')}>
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
          label={t('Git-Repository auf dem Server')}
          hint={t('Jedes Issue bekommt einen eigenen Worktree und Branch agentdeck/KEY-n.')}
        >
          <input value={project().repo_path} onChange={(e) => save({ repo_path: e.currentTarget.value })} />
        </Field>
        <Field
          label={t('Sprache der Agenten')}
          hint={t('In dieser Sprache bekommen die Agenten ihre Aufträge und schreibt der Server seine Notizen.')}
        >
          <Select
            value={project().settings.language}
            options={AGENT_LANGUAGES}
            onChange={(language) => saveSettings((s) => void (s.language = language))}
          />
        </Field>
        <div class="row">
          <Toggle
            label={t('Verlauf der Läufe aufzeichnen')}
            title={t('Speichert je Lauf Auftrag, Werkzeugaufrufe, Ergebnisse, Antworten und die Änderungen, gekürzt und ohne erkannte Geheimnisse. Zu sehen unter „Verlauf zeigen“ bei jedem Lauf, 30 Tage lang.')}
            checked={project().settings.replay}
            onChange={(on) => saveSettings((s) => void (s.replay = on))}
          />
          <Toggle
            label={t('Große MCP-Verbindungen nur bei Bedarf')}
            title={t('Die Werkzeuge von PixelLab kosten in jedem Schritt etwa 90.000 Tokens. Ein Lauf bekommt sie nur, wenn das Issue PixelLab nennt oder der Agent sie mit „connect“ anfordert. Die API-Keys sind immer gesetzt.')}
            checked={project().settings.mcpOnDemand}
            onChange={(on) => saveSettings((s) => void (s.mcpOnDemand = on))}
          />
        </div>
        <section class="section">
          <div class="section-head">
            <h3>{t('Abnahme')}</h3>
          </div>
          <p class="muted">
            {t('Jedes Issue bekommt eine Checkliste: sein „Done when“ plus die passende Vorlage. Der Agent meldet jeden Punkt mit Nachweis, die Prüfer urteilen nur danach. Fehlt noch etwas, prüft nur der erste Prüfer den Zwischenstand.')}
          </p>
          <div class="row">
            <Toggle
              label={t('Abnahme-Checklisten')}
              checked={project().settings.checklists.enabled}
              onChange={(on) => saveSettings((s) => void (s.checklists.enabled = on))}
            />
            <Toggle
              label={t('Nach Änderungswunsch beim selben Prüfer weitermachen')}
              checked={project().settings.resumeReview}
              onChange={(on) => saveSettings((s) => void (s.resumeReview = on))}
            />
          </div>
          <Show when={project().settings.checklists.enabled}>
            <Field
              label={t('Vorlagen')}
              hint={t('„## Name“ beginnt eine Vorlage. „Agenten:“ und „Titel:“ (kommagetrennt) sagen, wofür sie gilt; die erste passende wird genommen. Eine Vorlage ohne beides gilt für jedes Issue. Punkte beginnen mit „- “.')}
            >
              <textarea
                rows="12"
                class="mono"
                placeholder={templateExample()}
                value={project().settings.checklists.templates}
                onChange={(e) => {
                  const templates = e.currentTarget.value
                  saveSettings((s) => void (s.checklists.templates = templates))
                }}
              />
            </Field>
          </Show>
          <Toggle
            label={t('Vorcheck vor jedem Review')}
            checked={project().settings.precheck.enabled}
            onChange={(on) => saveSettings((s) => void (s.precheck.enabled = on))}
          />
          <Show when={project().settings.precheck.enabled}>
            <p class="muted">
              {t('Bevor ein Prüfer die Arbeit sieht: Nachweis-Dateien vorhanden, alles committet, Basis-Branch konfliktfrei eingemergt, Prüfbefehl grün. Sonst geht das Issue ohne Review-Lauf zurück.')}
            </p>
            <div class="row">
              <Field label={t('Prüfbefehl')} hint={t('Läuft im Checkout des Agenten. Leer = nur Nachweise und Merge.')}>
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
              <Field label={t('Zeitlimit (Minuten)')}>
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
              label={t('Prüfbefehl erst vor dem Landen')}
              checked={project().settings.precheck.commandAt === 'landing'}
              onChange={(on) => saveSettings((s) => void (s.precheck.commandAt = on ? 'landing' : 'review'))}
            />
            <p class="muted">
              {t('An: Die Prüfer sehen die Arbeit sofort. Der Prüfbefehl läuft einmal nach der letzten Freigabe auf dem gemergten Stand, gepusht wird nur bei Grün. Rot geht mit der Ausgabe an den Ersteller zurück. Agenten führen die volle Testsuite dann nicht selbst aus. Nur bei Landung „Merge“.')}
            </p>
          </Show>
        </section>
        <section class="section">
          <div class="section-head">
            <h3>{t('Landung')}</h3>
            <Select
              aria-label={t('Landung')}
              value={project().settings.landing.mode}
              options={tl(LANDING_MODES)}
              onChange={(mode) => saveSettings((s) => void (s.landing.mode = mode))}
            />
          </div>
          <p class="muted">
            {t('Nach der letzten Freigabe bringt AgentDeck den Branch des Issues in den Basis-Branch. Agenten landen nie selbst.')}
          </p>
          <Show when={project().settings.landing.mode !== 'off'}>
            <div class="row">
              <Field label={t('Basis-Branch')} hint={t('Leer = der im Repository ausgecheckte Branch')}>
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
                  label={t('Nach dem Merge pushen')}
                  checked={project().settings.landing.push}
                  onChange={(on) => saveSettings((s) => void (s.landing.push = on))}
                />
              </Show>
              <Show when={project().settings.landing.mode === 'pr'}>
                <Field label={t('Merge-Art')}>
                  <Select
                    value={project().settings.landing.mergeMethod}
                    options={tl(MERGE_METHODS)}
                    onChange={(method) => saveSettings((s) => void (s.landing.mergeMethod = method))}
                  />
                </Field>
              </Show>
            </div>
            <Field
              label={t('Geschützte Pfade')}
              hint={t('Ein Pfad pro Zeile. Ändert ein Branch etwas darunter, landet er nicht automatisch, sondern wartet auf deine Freigabe.')}
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
              label={t('Freigabe vor der Landung')}
              hint={t('Was hier zutrifft, landet nicht automatisch, sondern wartet auf „Landung freigeben“ im Issue. Die Freigabe gilt für genau einen Stand des Branches; ändert er sich danach, braucht er eine neue.')}
            >
              <div class="row">
                <Toggle
                  label={t('Jede Landung')}
                  checked={project().settings.landing.approval.merge}
                  onChange={(on) => saveSettings((s) => void (s.landing.approval.merge = on))}
                />
                <Toggle
                  label={t('Neue Abhängigkeiten')}
                  title={t('package.json, requirements*.txt, pyproject.toml, Cargo.toml, go.mod, Gemfile, composer.json: neue Pakete, nicht reine Versionswechsel')}
                  checked={project().settings.landing.approval.dependencies}
                  onChange={(on) => saveSettings((s) => void (s.landing.approval.dependencies = on))}
                />
                <Toggle
                  label={t('Infrastruktur-Dateien')}
                  checked={project().settings.landing.approval.infra}
                  onChange={(on) => saveSettings((s) => void (s.landing.approval.infra = on))}
                />
              </div>
            </Field>
            <Show when={project().settings.landing.approval.infra}>
              <Field
                label={t('Infrastruktur-Muster')}
                hint={t('Ein Muster pro Zeile. Ohne „/“ gilt es für den Dateinamen in jedem Ordner (*.tf), mit „/“ ab der Wurzel des Repositorys (docker/**). ** umfasst Unterordner.')}
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
                label={t('Nachweis nötig für')}
                hint={t('Pfade, einer pro Zeile. Ändert ein Branch etwas darunter, muss die Zusammenfassung des Agenten einen der Nachweise rechts enthalten, sonst geht das Issue an ihn zurück.')}
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
              <Field label={t('Nachweis-Zeilen')} hint={t('Text, einer pro Zeile, z. B. „Screenshot:“.')}>
                <textarea
                  rows="3"
                  class="mono"
                  placeholder={t('Screenshot:\nOberfläche unverändert')}
                  value={project().settings.landing.evidence.markers.join('\n')}
                  onChange={(e) => {
                    const markers = splitLines(e.currentTarget.value)
                    saveSettings((s) => void (s.landing.evidence.markers = markers))
                  }}
                />
              </Field>
            </div>
            <Field
              label={t('GitHub-Token-Datei')}
              hint={t('Optional. Pfad im Container zu einem Token nur für dieses Projekt, etwa einem GitHub-App-Token, das ein Host-Job erneuert. Die Agenten bekommen es als GH_TOKEN, gelandet wird damit. Leer = GitHub-Verbindung oder gh-Login.')}
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
          label={t('Vollautonom: nichts wartet auf einen Menschen')}
          title={t('Blockierte Issues und offene Prüfungen entscheidet der Agent unten. Was auch er nicht klären kann, wird ins Backlog geparkt und später erneut versucht.')}
          checked={project().settings.autonomous}
          onChange={(on) => saveSettings((s) => void (s.autonomous = on))}
        />

        <Field
          label={t('Blockierte Issues gehen zuerst an')}
          hint={t('Dieser Agent entscheidet einmal, wie es weitergeht. Erst was er nicht klären kann, landet bei dir.')}
        >
          <select
            onChange={(e) => {
              const agentId = Number(e.currentTarget.value)
              saveSettings((s) => void (s.escalationAgentId = agentId))
            }}
          >
            <option value="0">{t('direkt an mich')}</option>
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
          label={t('Gruppen nacheinander öffnen')}
          title={t('Ist nichts mehr offen, wandert das Backlog der nächsten Gruppe (nach Name sortiert) auf To Do')}
          checked={project().settings.openGroupsInOrder}
          onChange={(on) => saveSettings((s) => void (s.openGroupsInOrder = on))}
        />

        <Toggle
          label={t('Mail an mich, wenn ein Issue auf mich wartet')}
          title={t('Postfach und Empfänger stehen unter „Anbieter und Zugänge“')}
          checked={project().settings.notifyOwner}
          onChange={(on) => saveSettings((s) => void (s.notifyOwner = on))}
        />

        <Webhooks projectId={project().id} />

        <section class="section">
          <div class="section-head">
            <h3>{t('Kosten-Deckel pro Issue')}</h3>
          </div>
          <p class="muted">
            {t('Verbraucht ein Issue mehr, wird es nach dem laufenden Lauf geparkt und du bekommst Bescheid. Mit „Weitere Runde freigeben“ darf es noch einmal so viel verbrauchen. 0 = kein Deckel.')}
          </p>
          <div class="row">
            <Field label={t('Dollar')} hint={t('Wie vom Anbieter gemeldet, auch im Abo')}>
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
            <Field label={t('Tausend Tokens')} hint={t('Neue Tokens, ohne Cache')}>
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
            <h3>{t('Vorschau mit Screenshots')}</h3>
          </div>
          <p class="muted">
            {t('Geht Arbeit ins Review, startet AgentDeck die App aus dem Branch, macht einen Desktop- und einen Handy-Screenshot und beendet sie wieder. Die Bilder stehen im Issue, der Prüfer bekommt sie mit.')}
          </p>
          <div class="row">
            <Field label={t('Startbefehl')} hint={t('$PORT wird durch einen freien Port ersetzt. Leer = aus.')}>
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
            <Field label={t('Seite')} hint={t('Pfad, der fotografiert wird')}>
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
            <h3>{t('Schaufenster')}</h3>
            <Toggle
              label={t('Öffentliche Seite')}
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
            {t('Eine Seite ohne Login, die zeigt, welche Agenten gerade arbeiten und was erledigt wurde. Kein Code, keine Kommentare, keine Kosten. Wer den Link kennt, kann sie sehen.')}
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
                title={t('Der alte Link funktioniert danach nicht mehr')}
                onClick={() => saveSettings((s) => void (s.showcase.slug = randomSlug()))}
              >
                {t('Neuer Link')}
              </button>
            </div>
            <Toggle
              label={t('Issue-Titel zeigen')}
              checked={project().settings.showcase.titles}
              onChange={(on) => saveSettings((s) => void (s.showcase.titles = on))}
            />
          </Show>
        </section>

        <GithubIntake />

        <Connect />

        <Lessons projectId={project().id} />

        <Field label={t('Kontext für alle Agenten')}>
          <textarea
            rows="6"
            value={project().description}
            onChange={(e) => save({ description: e.currentTarget.value })}
          />
        </Field>
        <footer>
          <button class="ghost danger" onClick={remove}>
            {t('Projekt löschen')}
          </button>
        </footer>
      </div>
    </div>
  )
}

const INTAKE_STATUSES = [
  ['backlog', 'Backlog: erst ansehen'],
  ['todo', 'To do: Agenten starten sofort'],
] as const

const GITHUB_REPO = /^[\w.-]{1,39}\/[\w.-]{1,100}$/

/** GitHub issues with the project's label are filed on the board (server/intake.ts). */
function GithubIntake() {
  const intake = () => board.project!.settings.intake
  const switchOn = (on: boolean) => {
    if (on && !GITHUB_REPO.test(intake().repo)) return fail(new Error(t('Erst das Repository als owner/name eintragen.')))
    saveSettings((s) => void (s.intake.enabled = on))
  }

  return (
    <section class="section">
      <div class="section-head">
        <h3>{t('GitHub-Issues übernehmen')}</h3>
        <Toggle label={t('Issues mit Label übernehmen')} checked={intake().enabled} onChange={switchOn} />
      </div>
      <p class="muted">
        {t('Bekommt ein Issue im Repository das Label, legt AgentDeck es hier an und die Agenten übernehmen. Ein Label setzen darf auf GitHub nur, wer im Repository mitarbeitet: Fremde können ein Issue schreiben, aber nicht an die Agenten geben. Der Text kommt trotzdem von außen, darum ist das Backlog die Vorgabe.')}
      </p>
      <div class="row">
        <Field label={t('Repository')} hint={t('owner/name, wie in der Adresse auf GitHub')}>
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
        <Field label={t('Label')}>
          <input
            value={intake().label}
            onChange={(e) => saveSettings((s) => void (s.intake.label = e.currentTarget.value.trim() || 'agentdeck'))}
          />
        </Field>
        <Field label={t('Landet in')}>
          <Select
            value={intake().status}
            options={tl(INTAKE_STATUSES)}
            onChange={(status) => saveSettings((s) => void (s.intake.status = status))}
          />
        </Field>
      </div>
      <p class="muted">
        {t('Braucht den GitHub-Webhook dieses Servers (')}
        <span class="mono">{location.origin}/api/github/webhook</span>
        {t(') mit dem Event „Issues“. Einrichtung: README, „Freigaben und GitHub-Webhooks“.')}
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
        <h3>{t('Von außen steuern')}</h3>
      </div>
      <p class="muted">
        {t('AgentDeck ist selbst ein MCP-Server. Claude Code, Codex, Cursor oder eine Chat-App lesen darüber die Boards, legen Issues an, kommentieren, verschieben und stoppen sie, mit den Rechten des verwendeten Tokens. Gilt für alle Projekte.')}
      </p>
      <div class="inline-row">
        <code class="connect-command">{command}</code>
        <button class="ghost" onClick={copy}>
          {copied() ? t('Kopiert') : t('Kopieren')}
        </button>
      </div>
      <p class="muted">
        {t('Zahlen für Prometheus und Grafana (Issues, Läufe, Kosten, Tokens, Kontingente):')}{' '}
        <span class="mono">{location.origin}/api/metrics</span>
        {t(', ebenfalls mit Bearer-Token.')}
      </p>
    </section>
  )
}

const WEBHOOK_EVENTS: readonly (readonly [WebhookEvent, string])[] = [
  ['review', 'Zur Prüfung'],
  ['blocked', 'Blockiert'],
  ['done', 'Erledigt'],
  ['failed', 'Lauf fehlgeschlagen'],
  ['owner', 'Wartet auf dich'],
]

const WEBHOOK_KINDS = [
  ['slack', 'Slack'],
  ['generic', 'Allgemein (JSON, signiert)'],
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
    if (!confirm(t('Webhook an {host} löschen?', { host: hook.host }))) return
    api
      .del(`/projects/${props.projectId}/webhooks/${hook.id}`)
      .then(() => setBoard('project', 'settings', 'webhooks', (list) => list.filter((h) => h.id !== hook.id)))
      .catch(fail)
  }

  function test(hook: Webhook) {
    setResult('')
    api
      .post<{ status: number }>(`/projects/${props.projectId}/webhooks/${hook.id}/test`)
      .then((r) => setResult(t('{host}: angekommen (HTTP {status})', { host: hook.host, status: r.status })))
      .catch(fail)
  }

  return (
    <section class="section">
      <div class="section-head">
        <h3>{t('Webhooks')}</h3>
      </div>
      <p class="muted">
        {t('Meldet Statuswechsel an Slack oder einen eigenen Endpunkt. Nur https, keine Adressen im privaten Netz. Gesendet werden Projekt, Issue-Nummer, Titel und Status, nie Code oder Kommentare. Allgemeine Webhooks sind mit HMAC-SHA256 signiert (Header X-AgentDeck-Signature).')}
      </p>
      <ul class="lessons">
        <For each={hooks()} fallback={<li class="muted">{t('Noch keine Webhooks.')}</li>}>
          {(hook) => (
            <li class="webhook">
              <span>
                <strong>{hook.kind === 'slack' ? 'Slack' : t('Allgemein')}</strong>{' '}
                <span class="mono">{hook.host}</span>
                <span class="webhook-events">
                  <For each={WEBHOOK_EVENTS}>
                    {([event, label]) => (
                      <Toggle
                        label={t(label)}
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
                {t('Testen')}
              </button>
              <button
                class="ghost icon-button"
                title={t('Webhook löschen')}
                aria-label={t('Webhook löschen')}
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
          {t('Signatur-Secret, wird nur jetzt angezeigt:')} <code class="mono">{secret()}</code>{' '}
          <button class="ghost" onClick={() => setSecret('')}>
            {t('Notiert')}
          </button>
        </div>
      </Show>
      <div class="inline-row">
        <input
          class="mono"
          placeholder="https://hooks.slack.com/services/…"
          aria-label={t('Webhook-Adresse')}
          value={url()}
          onInput={(e) => setUrl(e.currentTarget.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()}
        />
        <Select aria-label={t('Art')} value={kind()} options={tl(WEBHOOK_KINDS)} onChange={setKind} />
        <button onClick={add}>{t('Hinzufügen')}</button>
      </div>
      <div class="webhook-events">
        <For each={WEBHOOK_EVENTS}>
          {([event, label]) => (
            <Toggle
              label={t(label)}
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
    if (!s.sandbox) return t('Keine Sandbox: die Einstellung wirkt nur im Container.')
    if (s.mode === 'open') return t('Offen: die Agenten erreichen jeden Host.')
    if (s.firewall === 'active') return t('Firewall aktiv: andere Ziele und DNS sind gesperrt.')
    if (s.firewall === 'unavailable')
      return t('Firewall nicht verfügbar, das Projekt ist offen ({error}). Der Container braucht iptables und NET_ADMIN, siehe README.', {
        error: s.error || t('Fehler||Status'),
      })
    return t('Firewall wird eingerichtet …')
  }

  return (
    <section class="section">
      <div class="section-head">
        <h3>{t('Netzwerk der Agenten')}</h3>
      </div>
      <p class="muted">
        {t('Mit Allowlist erreichen die Agenten dieses Projekts nur die eingetragenen Hosts, über einen Proxy in AgentDeck. Alles andere sperrt die Firewall des Containers, auch DNS. Git über SSH geht dann nicht, Git über HTTPS schon. AgentDeck selbst (Board, API) bleibt erreichbar.')}
      </p>
      <div class="row">
        <Field label={t('Ausgehende Verbindungen')}>
          <Select
            value={egress().mode}
            options={tl(EGRESS_MODES)}
            onChange={(mode) => saveSettings((s) => void (s.egress.mode = mode))?.then(later)}
          />
        </Field>
      </div>
      <Field
        label={t('Erlaubte Hosts')}
        hint={t('Ein Eintrag pro Zeile: github.com, *.example.com (nur Subdomains), host:8443, 192.0.2.7. Ohne Port gelten 80 und 443. Ungültige Einträge fallen weg.')}
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
              <p class="muted">{t('Zuletzt blockiert:')}</p>
              <div class="chips">
                <For each={s().blocked}>
                  {(b) => (
                    <button class="ghost" title={t('Auf die Allowlist setzen')} onClick={() => allow(b.target)}>
                      {t('{target} erlauben', { target: b.target })}
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
        <h3>{t('Gelerntes')}</h3>
      </div>
      <p class="muted">
        {t('Jeder Lauf liest die neuesten 15 Notizen. Agenten schreiben sie selbst, wenn sie etwas herausfinden, das nicht im Repository steht.')}
      </p>
      <ul class="lessons">
        <For each={lessons()} fallback={<li class="muted">{t('Noch nichts gelernt.')}</li>}>
          {(lesson) => (
            <li>
              <span>{lesson.body}</span>
              <small class="muted">{lesson.source}</small>
              <button
                class="ghost icon-button"
                title={t('Notiz löschen')}
                aria-label={t('Notiz löschen')}
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
          placeholder={t('z. B. Tests laufen mit „npm test -- --run“')}
          aria-label={t('Neue Notiz')}
          value={draft()}
          onInput={(e) => setDraft(e.currentTarget.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()}
        />
        <button onClick={add}>{t('Hinzufügen')}</button>
      </div>
    </section>
  )
}
