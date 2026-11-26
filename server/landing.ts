// Landing: getting an approved issue branch into the base branch. Two ways, chosen per project:
//   merge: merged locally into the base branch right away, optionally pushed.
//   pr:    pushed and opened as a pull request; it is merged once its checks pass.
// Agents never land anything themselves. This runs in the server, after the last approval.
import { existsSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { apiKeyOfConnection } from './mcp.ts'
import { execIn, gitIn, loginsIn, SANDBOX } from './sandbox.ts'
import { runCommand } from './precheck.ts'
import { scanBranch, secretsNoteForOwner } from './secretScan.ts'
import { DATA_DIR, all, get, run } from './db.ts'
import { gateReasons, type ApprovalSettings } from './gates.ts'
import { trace } from './landingTrace.ts'
import { forgejoLandingFor, type ForgejoLanding } from './forgejoLanding.ts'
import { cleanupBase, issueBranch, mergedInto, removeLandedIssueBranch } from './branchCleanup.ts'
import { forProject, t } from './i18n.ts'


export type LandingSettings = {
  mode: 'off' | 'merge' | 'pr'
  /** Empty: the branch that is checked out in the repository. */
  baseBranch: string
  /** merge mode only: push the base branch after merging. */
  push: boolean
  /** Paths (prefixes) only a human may change. A branch touching them is not landed automatically. */
  protectedPaths: string[]
  /**
   * A file that holds this project's own GitHub token, e.g. a short-lived GitHub App token for one
   * repository that a host job keeps fresh. Empty: the GitHub connection or the gh login.
   */
  githubTokenFile: string
  /** pr mode only: how GitHub merges the pull request. */
  mergeMethod: 'merge' | 'squash' | 'rebase'
  /**
   * Proof the maker has to give before a branch lands, e.g. screenshots for a visible change:
   * when the branch touches one of the paths, the maker's last summary must contain one of the
   * markers. Otherwise the issue goes back to the maker. Empty paths: no such rule.
   */
  evidence: { paths: string[]; markers: string[] }
  /** What waits for the owner's approval before it lands, see gates.ts. */
  approval: ApprovalSettings
}

export type Outcome = {
  status: 'done' | 'review' | 'todo' | 'blocked'
  note: string
  /** The issue now waits for a human. */
  needsOwner?: boolean
  /** Held at an approval gate: the owner may let exactly this commit land. */
  gate?: { sha: string }
}

type Project = {
  id: number
  key: string
  repo_path: string
  paused?: boolean
  settings: {
    language?: string
    landing: LandingSettings
    precheck?: { enabled: boolean; command: string; timeoutMin: number; commandAt: 'review' | 'landing' }
  }
}

/** The check command that runs on the merged state before it is pushed, or null. */
function landingCheck(project: Project) {
  const check = project.settings.precheck
  return check?.enabled && check.command && check.commandAt === 'landing' ? check : null
}

type Issue = { id: number; number: number; title: string }

const IDENTITY = ['-c', 'user.name=AgentDeck', '-c', 'user.email=agentdeck@localhost']

const repoOf = (project: Project) => project.repo_path || join(DATA_DIR, 'workspaces', project.key)
const branchOf = (project: Project, issue: Issue) => issueBranch(project.key, issue.number)

async function git(repo: string, ...args: string[]) {
  const { stdout } = await gitIn(repo, args)
  return stdout.trim()
}

const succeeds = (command: Promise<unknown>) =>
  command.then(
    () => true,
    () => false,
  )

/**
 * The project's own token file wins, then the GitHub connection. Null: gh uses its own login.
 * The file is read every time because the host job replaces it before the token expires.
 */
export function githubTokenOf(project: { settings: { landing: LandingSettings } }): string | null {
  const file = project.settings.landing.githubTokenFile
  if (file) {
    // A missing or empty file must not fall back to a login with wider rights.
    let token = ''
    try {
      token = readFileSync(file, 'utf8').trim()
    } catch {}
    if (!token) throw new Error(t('Die GitHub-Token-Datei {file} fehlt oder ist leer.', { file }))
    return token
  }
  return apiKeyOfConnection('github')
}

async function gh(project: Project, ...args: string[]) {
  const token = githubTokenOf(project)
  const env = token ? { ...process.env, GH_TOKEN: token } : process.env
  const { stdout } = await execIn(repoOf(project), 'gh', args, {
    cwd: repoOf(project),
    env,
    maxBuffer: 16 * 1024 * 1024,
  })
  return stdout.trim()
}

/** Pushes with the project's token through gh's credential helper; without a token git decides. */
async function push(project: Project, ...args: string[]) {
  const token = githubTokenOf(project)
  if (!token) {
    // In the sandbox git runs as the project user and finds gh's login in its home.
    await loginsIn(repoOf(project), { run: false })
    return git(repoOf(project), 'push', ...args)
  }
  const helper = ['-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential']
  const { stdout } = await gitIn(repoOf(project), [...helper, 'push', ...args], {
    env: { ...process.env, GH_TOKEN: token },
  })
  return stdout.trim()
}

async function readOrigin(project: Project, ...args: string[]) {
  const repo = repoOf(project)
  const token = githubTokenOf(project)
  if (!token) await loginsIn(repo, { run: false })
  const helper = token ? ['-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential'] : []
  return gitIn(repo, [...helper, ...args], {
    env: token ? { ...process.env, GH_TOKEN: token } : process.env,
  })
}

/** Origin's actual refs, never possibly stale remote-tracking refs. */
async function originRefs(project: Project, ...patterns: string[]) {
  const repo = repoOf(project)
  // Fetch and push may point at different repositories. Do not use the first as proof for the second.
  if (await git(repo, 'remote', 'get-url', 'origin') !== await git(repo, 'remote', 'get-url', '--push', 'origin')) return new Map<string, string>()
  const { stdout } = await readOrigin(project, 'ls-remote', '--refs', 'origin', ...patterns)
  const refs = new Map<string, string>()
  for (const line of stdout.trim().split(/\r?\n/)) {
    const [tip, ref] = line.split('\t')
    if (ref && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(tip)) refs.set(ref, tip)
  }
  return refs
}

export async function originStageRefs(project: Project, base: string) {
  if (!cleanupBase(base)) return { target: '', issues: new Map<string, string>() }
  const ref = `refs/heads/${base}`
  const refs = await originRefs(project, ref, `refs/heads/agentdeck/${project.key}-*`)
  const target = refs.get(ref) ?? ''
  refs.delete(ref)
  // A human may have merged elsewhere. Fetch just the target's objects without moving any refs.
  if (target && !(await succeeds(git(repoOf(project), 'cat-file', '-e', `${target}^{commit}`))))
    await succeeds(readOrigin(project, 'fetch', '--no-tags', '--no-write-fetch-head', '--refmap=', 'origin', ref))
  return { target, issues: new Map([...refs].map(([key, tip]) => [key.replace(/^refs\/heads\//, ''), tip])) }
}

/** Never delete a remote issue branch that acquired a new commit after landing. */
export async function removeRemoteLandedBranch(project: Project, issue: Issue, tip: string) {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(tip)) return false
  const ref = `refs/heads/${branchOf(project, issue)}`
  return succeeds(push(project, `--force-with-lease=${ref}:${tip}`, 'origin', `:${ref}`))
}

async function cleanupDirectLanding(project: Project, issue: Issue, base: string, tip: string) {
  if (!cleanupBase(base)) return
  const repo = repoOf(project)
  const ref = `refs/heads/${base}`
  const target = project.settings.landing.push ? (await originRefs(project, ref).catch(() => new Map())).get(ref) ?? '' : ref
  if (!(await mergedInto(repo, tip, target))) return
  // Remote cleanup is independent of retaining a dirty local checkout.
  if (project.settings.landing.push) await removeRemoteLandedBranch(project, issue, tip)
  await removeLandedIssueBranch(repo, project.key, issue.number, tip)
}

// Two landings in the same repository must not overlap: both would move the base branch.
const queues = new Map<string, Promise<unknown>>()

/**
 * Approved issues on their way into the base branch, for the board: waiting in line or being
 * tested. In order of arrival, so the place in line is the position among the waiting ones.
 */
export type LandingStep = { projectId: number; number: number; step: 'queued' | 'testing'; since: number }
export const landings = new Map<number, LandingStep>()
let landingsChanged: (projectId: number) => void = () => {}
export function onLandingsChange(listener: (projectId: number) => void) {
  landingsChanged = listener
}
function setLanding(issueId: number, step: LandingStep | null) {
  const projectId = step?.projectId ?? landings.get(issueId)?.projectId
  if (step) landings.set(issueId, step)
  else landings.delete(issueId)
  if (projectId !== undefined) landingsChanged(projectId)
}

function inTurn<T>(repo: string, work: () => Promise<T>): Promise<T> {
  const next = (queues.get(repo) ?? Promise.resolve()).then(work, work)
  queues.set(
    repo,
    next.catch(() => {}),
  )
  return next
}

/**
 * The worktree where landings are merged and tested, set to the current base. It stays between
 * landings, so files the check leaves ignored (e.g. Godot's import cache) need not be rebuilt.
 */
async function landingWorktree(repo: string, project: Project, base: string) {
  // In the sandbox the project user creates it, in the landing folder the helper handed it.
  const place = SANDBOX
    ? join(DATA_DIR, 'landing', project.key, String(project.id))
    : join(DATA_DIR, 'landing', `${project.id}-${project.key}`)
  // A worktree left from another repository (the project's path changed) is replaced.
  const ownedBy = async (dir: string) =>
    realpathSync(resolve(dir, await git(dir, 'rev-parse', '--git-common-dir')))
  if (existsSync(join(place, '.git')) && (await ownedBy(place).catch(() => '')) !== (await ownedBy(repo))) {
    rmSync(place, { recursive: true, force: true })
  }
  if (!existsSync(join(place, '.git'))) {
    await succeeds(git(repo, 'worktree', 'prune'))
    await git(repo, 'worktree', 'add', '--detach', '--force', place, base)
  }
  await succeeds(git(place, 'merge', '--abort'))
  await git(place, 'checkout', '--detach', '--force', base)
  await git(place, 'reset', '--hard', base)
  await git(place, 'clean', '-fd')
  return place
}

/** The branch approved work lands on: the setting, or what the repository has checked out. */
export async function baseBranchOf(project: Project) {
  return (
    project.settings.landing.baseBranch || (await git(repoOf(project), 'symbolic-ref', '--short', 'HEAD'))
  )
}

const touchesProtected = (files: string[], settings: LandingSettings) =>
  files.filter((file) => settings.protectedPaths.some((path) => path && file.startsWith(path)))

/** What the maker wrote at the end of its last run on this issue. */
function makerSummary(issue: Issue): string {
  const row = get(
    `SELECT c.body FROM comments c JOIN issues i ON i.id = c.issue_id
       JOIN agents a ON a.id = COALESCE(i.maker_id, i.assignee_id)
     WHERE c.issue_id = ? AND c.kind = 'agent' AND c.author = a.name
     ORDER BY c.id DESC LIMIT 1`,
    issue.id,
  )
  return row?.body ?? ''
}

function missingEvidence(files: string[], issue: Issue, settings: LandingSettings): string | null {
  const { paths, markers } = settings.evidence
  const touched = files.filter((file) => paths.some((path) => path && file.startsWith(path)))
  if (!touched.length || !markers.length) return null
  const summary = makerSummary(issue)
  if (markers.some((marker) => summary.includes(marker))) return null
  return t(
    'Der Branch ändert {files}, aber deine Zusammenfassung enthält keinen Nachweis ({markers}). Bitte nachholen und erneut abgeben.',
    { files: touched.slice(0, 3).join(', '), markers: markers.map((m) => `"${m}"`).join(t(' oder ')) },
  )
}

const OWNER_REVIEW = (reasons: string[], tip: string) =>
  t(
    'Wartet auf deine Freigabe vor der Landung ({reasons}). Mit „Landung freigeben“ landet genau der Stand {tip}; ändert sich der Branch danach, braucht er eine neue Freigabe.',
    { reasons: reasons.join('; '), tip: tip.slice(0, 10) },
  )

/**
 * The owner's approval of this issue, used up by the landing that reads it: it lets exactly the
 * approved commit land once. An approval for another commit (the branch moved) is void.
 */
function takeApproval(issueId: number, tip: string) {
  const approved = get('SELECT approved_sha FROM issues WHERE id=?', issueId)?.approved_sha ?? ''
  if (approved) run("UPDATE issues SET approved_sha='' WHERE id=?", issueId)
  return !!approved && approved === tip
}

/** The commit the issue's branch points at, '' when there is no branch. */
export async function branchTip(project: Project, issue: { number: number }) {
  const ref = `refs/heads/${branchOf(project, issue as Issue)}^{commit}`
  return git(repoOf(project), 'rev-parse', '--verify', '--quiet', ref).catch(() => '')
}

// Notes, trace lines and pull request texts are written in the project's language, also when the
// landing waits in the queue and runs much later.
export const landIssue = (project: Project, issue: Issue): Promise<Outcome> =>
  forProject(project, () => land(project, issue))

function land(project: Project, issue: Issue): Promise<Outcome> {
  const settings = project.settings.landing
  if (settings.mode === 'off') return Promise.resolve({ status: 'done', note: '' })
  const repo = repoOf(project)
  const step = (name: LandingStep['step']) =>
    setLanding(issue.id, { projectId: project.id, number: issue.number, step: name, since: Date.now() })
  step('queued')
  trace(issue.id, 'queued', t('Landung eingereiht (Modus {mode}).', { mode: settings.mode }))

  return inTurn(repo, async (): Promise<Outcome> => {
    step('testing')
    const branch = branchOf(project, issue)
    // Everything below works on this one commit, never on the branch name: what the gates looked
    // at and the owner approved is what lands, even if the branch moves in the meantime.
    const tip = await branchTip(project, issue)
    const approved = takeApproval(issue.id, tip)
    if (!tip) {
      trace(issue.id, 'branch', t('Der Issue hat keinen Branch (z. B. ein Bericht): nichts zu landen.'))
      return { status: 'done', note: '' } // the issue produced no branch, e.g. a report
    }
    const base = await baseBranchOf(project)
    const short = tip.slice(0, 10)
    trace(
      issue.id,
      'start',
      approved
        ? t('Prüfe Stand {tip} gegen {base}. Eine Freigabe für genau diesen Stand liegt vor.', { tip: short, base })
        : t('Prüfe Stand {tip} gegen {base}.', { tip: short, base }),
    )
    if ((await git(repo, 'rev-list', '--count', `${base}..${tip}`)) === '0') {
      trace(issue.id, 'start', t('Keine neuen Commits gegenüber {base}: schon gelandet.', { base }), 'ok')
      if (settings.mode === 'merge') await cleanupDirectLanding(project, issue, base, tip)
      return { status: 'done', note: '' }
    }
    // A squash merge leaves no ancestry behind, so the count above still sees new commits.
    const landedAs = settings.mode === 'pr' ? await mergedPullRequestOf(project, issue, tip, base) : 0
    if (landedAs) {
      trace(
        issue.id,
        'pr',
        t('Pull Request #{number} hat genau den Stand {tip} schon in {base} gemergt.', { number: landedAs, tip: short, base }),
        'ok',
      )
      return { status: 'done', note: t('Pull Request #{number} ist schon gemergt.', { number: landedAs }) }
    }

    const forkPoint = await git(repo, 'merge-base', base, tip)
    // -z: names as they are, not quoted; no external diff or textconv the repository configures.
    const { stdout: names } = await gitIn(repo, [
      'diff', '--no-ext-diff', '--no-textconv', '--name-only', '-z', forkPoint, tip,
    ])
    const changed = names.split('\0').filter(Boolean)
    trace(
      issue.id,
      'files',
      t('{n} geänderte Datei(en): {files}', {
        n: changed.length,
        files: `${changed.slice(0, 12).join(', ')}${changed.length > 12 ? ', …' : ''}`,
      }),
    )
    const evidenceNote = missingEvidence(changed, issue, settings)
    if (evidenceNote) {
      trace(issue.id, 'evidence', t('Nachweise fehlen, zurück an den Maker.'), 'warn')
      return { status: 'todo', note: evidenceNote }
    }
    // Last check before anything is merged or pushed, on the exact commit that would land. An
    // approval does not lift it. A failing scan throws: the landing stops.
    const secrets = await scanBranch(repo, base, tip)
    if (secrets.length) {
      trace(issue.id, 'secrets', t('Geheimnis-Scan: {n} Fund(e), Landung gestoppt.', { n: secrets.length }), 'bad')
      return { status: 'blocked', note: secretsNoteForOwner(secrets), needsOwner: true }
    }
    trace(issue.id, 'secrets', t('Geheimnis-Scan: nichts gefunden.'), 'ok')
    const reasons = await gateReasons(
      repo,
      forkPoint,
      tip,
      changed,
      settings.approval,
      touchesProtected(changed, settings),
    )
    if (reasons.length) {
      trace(
        issue.id,
        'gate',
        approved
          ? t('Freigabe-Gate ({n}) mit Freigabe des Owners überschritten.', { n: reasons.length })
          : t('Freigabe-Gate hält die Landung an: {reasons}', { reasons: reasons.join(' | ') }),
        approved ? 'warn' : 'bad',
      )
    }
    if (reasons.length && !approved) {
      return { status: 'blocked', note: OWNER_REVIEW(reasons, tip), needsOwner: true, gate: { sha: tip } }
    }


    return settings.mode === 'merge'
      ? mergeLocally(repo, base, tip, project, issue, settings)
      : openPullRequest(repo, base, branch, tip, project, issue)
  })
    .catch(
      (error): Outcome => ({
        status: 'blocked',
        note: t('Landung fehlgeschlagen: {error}', { error: error.message }),
        needsOwner: true,
      }),
    )
    .finally(() => setLanding(issue.id, null))
}

async function mergeLocally(
  repo: string,
  base: string,
  tip: string,
  project: Project,
  issue: Issue,
  settings: LandingSettings,
): Promise<Outcome> {
  const checkedOut = await git(repo, 'symbolic-ref', '--short', 'HEAD')
  if (checkedOut !== base) {
    return {
      status: 'blocked',
      note: t('Im Repository ist "{checkedOut}" ausgecheckt, gelandet wird aber auf "{base}".', { checkedOut, base }),
      needsOwner: true,
    }
  }

  if (settings.push) {
    const pulled = await succeeds(git(repo, 'pull', '--ff-only', 'origin', base))
    trace(
      issue.id,
      'pull',
      pulled
        ? t('{base} von origin aktualisiert.', { base })
        : t('Pull von origin/{base} nicht möglich, weiter mit dem lokalen Stand.', { base }),
      pulled ? 'ok' : 'warn',
    )
  }

  const message = `Merge ${project.key}-${issue.number}: ${issue.title}`
  const conflict = {
    status: 'todo' as const,
    note: t(
      'Der Branch lässt sich nicht konfliktfrei in {base} mergen. Bitte {base} in den Branch mergen, die Konflikte lösen und erneut abgeben.',
      { base },
    ),
  }
  const short = tip.slice(0, 10)

  // Reviewed first, tested last: the check runs once, on exactly what would be pushed. It runs in
  // a landing worktree of its own, and the base branch moves only when the check is green. Before,
  // the merge sat on the base branch while the check ran, and every precheck in those minutes
  // merged the untested work into its own branch (SHOP-712 into SHOP-842 and SHOP-804, 22 Nov 2026).
  const check = landingCheck(project)
  if (check) {
    const place = await landingWorktree(repo, project, base)
    if (!(await succeeds(git(place, ...IDENTITY, 'merge', '--no-ff', '-m', message, tip)))) {
      await succeeds(git(place, 'merge', '--abort'))
      trace(issue.id, 'merge', t('Merge von {tip} in {base} (Test-Arbeitsbaum) hat Konflikte.', { tip: short, base }), 'bad')
      return conflict
    }
    trace(
      issue.id,
      'merge',
      t('{tip} in {base} gemergt, im Test-Arbeitsbaum ({base} selbst unberührt).', { tip: short, base }),
      'ok',
    )
    trace(
      issue.id,
      'check',
      t('Starte Projektprüfung "{command}" (max. {minutes} min).', { command: check.command, minutes: check.timeoutMin }),
    )
    const checkStarted = Date.now()
    const failed = await runCommand(place, check.command, check.timeoutMin)
    const took = Math.round((Date.now() - checkStarted) / 1000)
    if (failed) {
      const lines = failed.note.split('\n')
      trace(
        issue.id,
        'check',
        t('Projektprüfung rot nach {seconds} s: {line}', {
          seconds: took,
          line: lines.find((l) => l.startsWith('FAIL ')) ?? lines[0],
        }),
        'bad',
      )
      return { status: 'todo', note: failed.note }
    }
    trace(issue.id, 'check', t('Projektprüfung grün nach {seconds} s.', { seconds: took }), 'ok')
    const tested = await git(place, 'rev-parse', 'HEAD')
    if (!(await succeeds(git(repo, 'merge', '--ff-only', tested)))) {
      trace(
        issue.id,
        'advance',
        t('{base} ließ sich nicht auf {tip} vorrücken (hat sich bewegt oder lokale Änderungen). Nichts gelandet.', {
          base,
          tip: tested.slice(0, 10),
        }),
        'bad',
      )
      return {
        status: 'blocked',
        note: t(
          'Der Stand war grün, aber {base} hat sich während des Tests bewegt oder das Repository hat lokale Änderungen. Nichts wurde gelandet.',
          { base },
        ),
        needsOwner: true,
      }
    }
    trace(
      issue.id,
      'advance',
      t('{base} auf {tip} vorgerückt (fast-forward, nur der getestete Stand).', { base, tip: tested.slice(0, 10) }),
      'ok',
    )
  } else if (!(await succeeds(git(repo, ...IDENTITY, 'merge', '--no-ff', '-m', message, tip)))) {
    await succeeds(git(repo, 'merge', '--abort'))
    trace(issue.id, 'merge', t('Merge von {tip} in {base} hat Konflikte.', { tip: short, base }), 'bad')
    return conflict
  } else {
    trace(issue.id, 'merge', t('{tip} direkt in {base} gemergt (keine Projektprüfung eingestellt).', { tip: short, base }), 'warn')
  }

  const commit = (await git(repo, 'rev-parse', '--short', 'HEAD')) || '?'
  if (settings.push && !(await succeeds(push(project, 'origin', base)))) {
    trace(issue.id, 'push', t('Push nach origin/{base} fehlgeschlagen. Lokal gelandet ({commit}).', { base, commit }), 'bad')
    return {
      status: 'blocked',
      note: t('Lokal in {base} gemergt ({commit}), aber der Push ist fehlgeschlagen.', { base, commit }),
      needsOwner: true,
    }
  }
  if (settings.push) trace(issue.id, 'push', t('Nach origin/{base} gepusht.', { base }), 'ok')
  trace(issue.id, 'done', t('In {base} gelandet ({commit}).', { base, commit }), 'ok')
  await cleanupDirectLanding(project, issue, base, tip)
  return {
    status: 'done',
    note: check
      ? t('In {base} gelandet ({commit}, `{command}` grün).', { base, commit, command: check.command })
      : t('In {base} gelandet ({commit}).', { base, commit }),
  }
}

function pullRequestBody(project: Project, issue: Issue) {
  const summary = makerSummary(issue).trim()
  const head = `${project.key}-${issue.number}, opened by AgentDeck after review.`
  // GitHub refuses bodies above 65536 characters.
  return summary
    ? `${head}

${summary}`.slice(0, 60_000)
    : head
}

async function openPullRequest(
  repo: string,
  base: string,
  branch: string,
  tip: string,
  project: Project,
  issue: Issue,
): Promise<Outcome> {
  const forgejo = forgejoLandingFor(project.key)
  const title = `${project.key}-${issue.number}: ${issue.title}`
  const body = pullRequestBody(project, issue)

  let number: number
  if (forgejo) {
    await checkForgejoOrigin(repo, forgejo)
    await forgetGoneBranch(repo, branch)
    await git(repo, 'push', '--force-with-lease', 'origin', `${tip}:refs/heads/${branch}`)
    trace(
      issue.id,
      'push',
      t('Branch {branch} auf Stand {tip} nach origin (Forgejo) gepusht.', { branch, tip: tip.slice(0, 10) }),
      'ok',
    )
    number = await forgejo.open(branch, base, tip, title, body)
  } else {
    await push(project, '--force-with-lease', 'origin', `${tip}:refs/heads/${branch}`)
    trace(issue.id, 'push', t('Branch {branch} auf Stand {tip} nach origin gepusht.', { branch, tip: tip.slice(0, 10) }), 'ok')
    const open = JSON.parse(
      await gh(project, 'pr', 'list', '--head', branch, '--state', 'open', '--json', 'number'),
    )
    number = open[0]?.number
    if (!number) {
      const url = await gh(project, 'pr', 'create', '--base', base, '--head', branch, '--title', title, '--body', body)
      number = Number(url.split('/').pop())
    }
  }

  run("UPDATE issues SET pr_number=?, pr_sha=?, landing='waiting' WHERE id=?", number, tip, issue.id)
  trace(
    issue.id,
    'pr',
    t('Pull Request #{number} ist offen und wartet auf Checks (Stand {tip}).', { number, tip: tip.slice(0, 10) }),
    'ok',
  )
  return { status: 'review', note: t('Pull Request #{number} ist offen und wartet auf seine Checks.', { number }) }
}

async function checkForgejoOrigin(repo: string, forgejo: ForgejoLanding) {
  const fetchUrl = await git(repo, 'remote', 'get-url', '--all', 'origin')
  const pushUrl = await git(repo, 'remote', 'get-url', '--push', '--all', 'origin')
  if (fetchUrl !== forgejo.origin || pushUrl !== forgejo.origin) {
    throw new Error(t('Der Git-Remote origin stimmt nicht mit der Forgejo-Landing-Konfiguration überein.'))
  }
}

/**
 * Forgejo deletes a branch after a squash merge, but the repository keeps its tracking ref.
 * --force-with-lease compares against that ref and then refuses every push ("stale info"),
 * forever. A branch origin no longer has is forgotten; one that still exists keeps its lease.
 */
async function forgetGoneBranch(repo: string, branch: string) {
  const onOrigin = await git(repo, 'ls-remote', '--heads', 'origin', `refs/heads/${branch}`)
  if (!onOrigin) await succeeds(git(repo, 'update-ref', '-d', `refs/remotes/origin/${branch}`))
}

/**
 * The number of the issue's own pull request if it already merged exactly this commit into the
 * base, else 0. Without this an issue that comes back after its merge (a restart, a status moved
 * by hand) is pushed and reviewed again and again although nothing is left to land.
 */
async function mergedPullRequestOf(project: Project, issue: Issue, tip: string, base: string): Promise<number> {
  const known = get('SELECT pr_number, pr_sha FROM issues WHERE id=?', issue.id)
  if (!known?.pr_number || known.pr_sha !== tip) return 0
  // Not knowing is not a reason to stop: the landing then goes its normal way.
  const merged = async () => {
    const forgejo = forgejoLandingFor(project.key)
    if (forgejo) return forgejo.merged(known.pr_number, tip, base)
    const view = JSON.parse(
      await gh(project, 'pr', 'view', String(known.pr_number), '--json', 'state,headRefOid,baseRefName'),
    )
    return view.state === 'MERGED' && view.headRefOid === tip && view.baseRefName === base
  }
  return (await merged().catch(() => false)) ? known.pr_number : 0
}

// ---------- pull requests that wait for their checks ----------

type Check = { name?: string; status?: string; conclusion?: string; state?: string }
type PullRequest = {
  state: string
  url: string
  headRefOid: string
  headRefName: string
  baseRefName: string
  isCrossRepository: boolean
  statusCheckRollup?: Check[]
}
const PR_FIELDS = 'state,url,headRefOid,headRefName,baseRefName,isCrossRepository,statusCheckRollup'

function repositoryIdentity(address: string) {
  const scp = !address.includes('://') && address.match(/^(?:[^/@:]+@)?([^/:]+):([^:]+)$/)
  try {
    const url = new URL(scp ? `ssh://${scp[1]}/${scp[2]}` : address)
    if (!['https:', 'http:', 'ssh:'].includes(url.protocol)) return ''
    const path = url.pathname.replace(/\/pull\/\d+\/?$/, '').replace(/\/$/, '').replace(/\.git$/, '')
    if (!/^\/[^/]+\/[^/]+$/.test(path)) return ''
    return `${url.hostname.toLowerCase()}${url.protocol === 'ssh:' || !url.port ? '' : `:${url.port}`}${path.toLowerCase()}`
  } catch {
    return ''
  }
}

/** A merged PR proves a squash/rebase, but only for its recorded head in the actual push repository. */
export function isMergedStagePullRequest(pr: PullRequest, branch: string, tip: string, origin: string) {
  const repository = repositoryIdentity(origin)
  return !!repository && pr.state === 'MERGED' && cleanupBase(pr.baseRefName) && pr.headRefName === branch &&
    pr.isCrossRepository === false && !!tip && pr.headRefOid === tip && repositoryIdentity(pr.url) === repository
}

export async function confirmsStageMerge(project: Project, issue: Issue & { pr_number: number; pr_sha: string }) {
  if (!issue.pr_number || !issue.pr_sha) return false
  const repo = repoOf(project)
  const origin = await git(repo, 'remote', 'get-url', '--push', 'origin').catch(() => '')
  if (!repositoryIdentity(origin)) return false
  const view: PullRequest = JSON.parse(await gh(project, 'pr', 'view', String(issue.pr_number), '--json', PR_FIELDS))
  return isMergedStagePullRequest(view, branchOf(project, issue), issue.pr_sha, origin)
}

/** GitHub reports workflow runs (status/conclusion) and commit statuses (state) in one list. */
export function checksVerdict(checks: Check[]): { verdict: 'pass' | 'pending' | 'fail'; failed: string[] } {
  const failed = checks
    .filter((check) =>
      ['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ERROR', 'ACTION_REQUIRED'].includes(
        check.conclusion ?? check.state ?? '',
      ),
    )
    .map((check) => check.name ?? 'check')
  if (failed.length) return { verdict: 'fail', failed }

  const pending = checks.some((check) =>
    check.state ? check.state === 'PENDING' || check.state === 'EXPECTED' : check.status !== 'COMPLETED',
  )
  return { verdict: pending ? 'pending' : 'pass', failed: [] }
}

async function settlePullRequest(
  project: Project,
  issue: Issue & { pr_number: number; pr_sha?: string },
): Promise<Outcome | null> {
  const forgejo = forgejoLandingFor(project.key)
  if (forgejo) return settleForgejoPullRequest(project, issue, forgejo)

  const repo = repoOf(project)
  const view: PullRequest = JSON.parse(
    await gh(project, 'pr', 'view', String(issue.pr_number), '--json', PR_FIELDS),
  )

  const cleanupMerged = async (merged: PullRequest) => {
    // An exact merged PR is also proof for squash/rebase, whose head is not a Git ancestor.
    if (!issue.pr_sha || !cleanupBase(merged.baseRefName)) return
    const origin = await git(repo, 'remote', 'get-url', '--push', 'origin').catch(() => '')
    if (!isMergedStagePullRequest(merged, branchOf(project, issue), issue.pr_sha, origin)) return
    await removeRemoteLandedBranch(project, issue, issue.pr_sha)
    await removeLandedIssueBranch(repo, project.key, issue.number, issue.pr_sha)
  }
  const number = issue.pr_number
  if (view.state === 'MERGED') {
    await cleanupMerged(view)
    trace(issue.id, 'pr', t('Pull Request #{number} ist gemergt.', { number }), 'ok')
    return { status: 'done', note: t('Pull Request #{number} ist gemergt.', { number }) }
  }
  if (view.state === 'CLOSED') {
    trace(issue.id, 'pr', t('Pull Request #{number} wurde ohne Merge geschlossen.', { number }), 'bad')
    return {
      status: 'blocked',
      note: t('Pull Request #{number} wurde geschlossen, ohne zu mergen.', { number }),
      needsOwner: true,
    }
  }
  // The pull request was opened for one commit, the one the reviews and gates saw. Something
  // pushed on top of it since is nobody's approved work.
  if (issue.pr_sha && view.headRefOid !== issue.pr_sha) {
    trace(
      issue.id,
      'pr',
      t('Pull Request #{number} zeigt {head} statt des geprüften Stands {tip}. Nichts gemergt.', {
        number,
        head: String(view.headRefOid).slice(0, 10),
        tip: issue.pr_sha.slice(0, 10),
      }),
      'bad',
    )
    return {
      status: 'blocked',
      note: t('Pull Request #{number} zeigt nicht mehr den geprüften Stand {tip}. Nichts wurde gemergt.', {
        number,
        tip: issue.pr_sha.slice(0, 10),
      }),
      needsOwner: true,
    }
  }

  const { verdict, failed } = checksVerdict(view.statusCheckRollup ?? [])
  if (verdict === 'pending') return null
  if (verdict === 'fail') {
    trace(issue.id, 'pr', t('Checks im Pull Request #{number} rot: {failed}.', { number, failed: failed.join(', ') }), 'bad')
    return {
      status: 'todo',
      note: t('Checks im Pull Request #{number} sind fehlgeschlagen: {failed}.', { number, failed: failed.join(', ') }),
    }
  }

  // Merge exactly the commit that was reviewed and checked, never something pushed in between.
  const method = project.settings.landing.mergeMethod
  await gh(
    project,
    'pr',
    'merge',
    String(issue.pr_number),
    `--${method}`,
    ...(method === 'merge' || cleanupBase(view.baseRefName) ? [] : ['--delete-branch']),
    '--match-head-commit',
    view.headRefOid,
  )
  if (cleanupBase(view.baseRefName)) {
    const merged = JSON.parse(await gh(project, 'pr', 'view', String(issue.pr_number), '--json', PR_FIELDS))
    if (merged.state !== 'MERGED') return null
    await cleanupMerged(merged)
  }
  await succeeds(git(repo, 'pull', '--ff-only'))
  trace(
    issue.id,
    'pr',
    t('Checks grün; Pull Request #{number} per {method} gemergt (nur Commit {commit}).', {
      number,
      method,
      commit: String(view.headRefOid).slice(0, 10),
    }),
    'ok',
  )
  return { status: 'done', note: t('Pull Request #{number} gemergt.', { number }) }
}

async function settleForgejoPullRequest(
  project: Project,
  issue: Issue & { pr_number: number; pr_sha?: string },
  forgejo: ForgejoLanding,
): Promise<Outcome | null> {
  if (project.paused) return null
  const number = issue.pr_number
  const blocked = (note: string): Outcome => {
    trace(issue.id, 'pr', note, 'bad')
    return { status: 'blocked', note, needsOwner: true }
  }
  if (!issue.pr_sha) {
    return blocked(t('Für den übernommenen PR #{number} fehlt ein geprüfter Commit. Bitte neu prüfen und abgeben.', { number }))
  }
  const repo = repoOf(project)
  const base = await baseBranchOf(project)
  await checkForgejoOrigin(repo, forgejo)
  // First: a merged pull request no longer carries its branch name (see ForgejoLanding.merged).
  if (await forgejo.merged(number, issue.pr_sha, base)) {
    await succeeds(git(repo, 'pull', '--ff-only'))
    trace(issue.id, 'pr', t('Forgejo-PR #{number} ist gemergt.', { number }), 'ok')
    return { status: 'done', note: t('Forgejo-PR #{number} ist gemergt.', { number }) }
  }
  const pull = await forgejo.view(number)
  if (pull.number !== number || !forgejo.matches(pull, branchOf(project, issue), base)) {
    return blocked(t('Forgejo-PR #{number} gehört nicht zum erwarteten Branch und Ziel.', { number }))
  }
  if (pull.head.sha !== issue.pr_sha) {
    return blocked(t('Forgejo-PR #{number} zeigt nicht mehr den geprüften Commit. Nichts wurde gemergt.', { number }))
  }
  if (pull.state !== 'open') return blocked(t('Forgejo-PR #{number} wurde geschlossen, ohne zu mergen.', { number }))

  const { verdict, failed } = await forgejo.checks(issue.pr_sha)
  if (verdict === 'pending') return null
  if (verdict === 'fail') {
    trace(issue.id, 'pr', t('Checks im Forgejo-PR #{number} rot: {failed}.', { number, failed: failed.join(', ') }), 'bad')
    return {
      status: 'todo',
      note: t('Checks im Forgejo-PR #{number} sind fehlgeschlagen: {failed}.', { number, failed: failed.join(', ') }),
    }
  }
  const method = project.settings.landing.mergeMethod
  await forgejo.merge(number, issue.pr_sha, method)
  await succeeds(git(repo, 'pull', '--ff-only'))
  trace(
    issue.id,
    'pr',
    t('Checks grün; Forgejo-PR #{number} per {method} gemergt (nur Commit {commit}).', {
      number,
      method,
      commit: issue.pr_sha.slice(0, 10),
    }),
    'ok',
  )
  return { status: 'done', note: t('Forgejo-PR #{number} gemergt.', { number }) }
}

// ---------- webhooks and the polling fallback ----------

/** When the last signed GitHub webhook arrived. While they arrive, polling is only a fallback. */
let lastWebhookAt = 0
export function webhookArrived(at = Date.now()) {
  lastWebhookAt = at
}

const POLL_FAST = 60_000
const POLL_SLOW = 10 * 60_000
/** Webhooks of a quiet repository are rare, so "recent" is generous; a lost one costs 10 minutes. */
const WEBHOOKS_RECENT = 24 * 3_600_000

/** How long the poll waits between looks at the waiting pull requests. */
export function pollInterval(now: number, lastWebhook = lastWebhookAt) {
  return lastWebhook && now - lastWebhook < WEBHOOKS_RECENT ? POLL_SLOW : POLL_FAST
}

/** Branches look like agentdeck/KEY-12; the key may itself contain a dash. */
const ISSUE_BRANCH = /^agentdeck\/(.+)-(\d+)$/

/**
 * The issues with a waiting pull request that a webhook speaks about. The payload only says where
 * to look: what happens is decided by asking GitHub again, so a forged target costs one look.
 */
export function waitingIssuesFor(targets: { branch: string; pr?: number }[]): number[] {
  const ids = new Set<number>()
  for (const target of targets) {
    const match = ISSUE_BRANCH.exec(target.branch)
    if (!match) continue
    const row = get(
      `SELECT i.id, i.pr_number FROM issues i JOIN projects p ON p.id = i.project_id
       WHERE p.key=? AND i.number=? AND i.landing='waiting'`,
      match[1],
      Number(match[2]),
    )
    if (row && (!target.pr || target.pr === row.pr_number)) ids.add(row.id)
  }
  return [...ids]
}

let settleNow: (issueIds: number[]) => void = () => {}
/** A webhook says something happened to these pull requests: look at them now. */
export function nudgePullRequests(issueIds: number[]) {
  settleNow(issueIds)
}

/**
 * Settles waiting pull requests: right away when a webhook names one, and in a slow poll for
 * everything a webhook may have missed (fast while no webhooks arrive).
 */
export function watchPullRequests(
  projectOf: (id: number) => Project | undefined,
  onSettled: (issueId: number, outcome: Outcome) => void,
) {
  // GitHub sends a burst of events per push (every check run). One look per issue at a time; an
  // event during a look asks for one more afterwards, so the last state is never missed.
  const busy = new Set<number>()
  const again = new Set<number>()

  async function settleOne(issueId: number) {
    if (busy.has(issueId)) return void again.add(issueId)
    busy.add(issueId)
    try {
      do {
        again.delete(issueId)
        const issue = get(
          "SELECT id, project_id, number, title, pr_number, pr_sha FROM issues WHERE id=? AND landing='waiting'",
          issueId,
        )
        const project = issue && projectOf(issue.project_id)
        if (!project) return
        const outcome = await forProject(project, () => settlePullRequest(project, issue)).catch((error) => {
          console.error(`landing ${project.key}-${issue.number}:`, error.message)
          return null
        })
        if (outcome) return forProject(project, () => onSettled(issue.id, outcome))
      } while (again.has(issueId))
    } finally {
      busy.delete(issueId)
    }
  }
  settleNow = (issueIds) => {
    for (const id of issueIds) void settleOne(id)
  }

  let lastPoll = 0
  let polling = false
  setInterval(async () => {
    const now = Date.now()
    if (polling || now - lastPoll < pollInterval(now) - 1000) return
    polling = true
    lastPoll = now
    try {
      for (const { id } of all("SELECT id FROM issues WHERE landing='waiting'")) await settleOne(id)
    } finally {
      polling = false
    }
  }, POLL_FAST).unref()
}
