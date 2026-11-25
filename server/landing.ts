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
  settings: {
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
const branchOf = (project: Project, issue: Issue) => `agentdeck/${project.key}-${issue.number}`

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
    if (!token) throw new Error(`The GitHub token file ${file} is missing or empty.`)
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
  return `The branch changes ${touched.slice(0, 3).join(', ')}, but your summary contains no proof (${markers.map((m) => `"${m}"`).join(' or ')}). Please add it and hand in again.`
}

const OWNER_REVIEW = (reasons: string[], tip: string) =>
  `Waits for your approval before landing (${reasons.join('; ')}). "Approve landing" lands exactly the state ${tip.slice(0, 10)}; if the branch changes after that, it needs a new approval.`

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

export function landIssue(project: Project, issue: Issue): Promise<Outcome> {
  const settings = project.settings.landing
  if (settings.mode === 'off') return Promise.resolve({ status: 'done', note: '' })
  const repo = repoOf(project)
  const step = (name: LandingStep['step']) =>
    setLanding(issue.id, { projectId: project.id, number: issue.number, step: name, since: Date.now() })
  step('queued')

  return inTurn(repo, async (): Promise<Outcome> => {
    step('testing')
    const branch = branchOf(project, issue)
    // Everything below works on this one commit, never on the branch name: what the gates looked
    // at and the owner approved is what lands, even if the branch moves in the meantime.
    const tip = await branchTip(project, issue)
    const approved = takeApproval(issue.id, tip)
    if (!tip) return { status: 'done', note: '' } // the issue produced no branch, e.g. a report
    const base = await baseBranchOf(project)
    if ((await git(repo, 'rev-list', '--count', `${base}..${tip}`)) === '0') {
      return { status: 'done', note: '' }
    }

    const forkPoint = await git(repo, 'merge-base', base, tip)
    // -z: names as they are, not quoted; no external diff or textconv the repository configures.
    const { stdout: names } = await gitIn(repo, [
      'diff', '--no-ext-diff', '--no-textconv', '--name-only', '-z', forkPoint, tip,
    ])
    const changed = names.split('\0').filter(Boolean)
    const evidenceNote = missingEvidence(changed, issue, settings)
    if (evidenceNote) return { status: 'todo', note: evidenceNote }
    // Last check before anything is merged or pushed, on the exact commit that would land. An
    // approval does not lift it. A failing scan throws: the landing stops.
    const secrets = await scanBranch(repo, base, tip)
    if (secrets.length) return { status: 'blocked', note: secretsNoteForOwner(secrets), needsOwner: true }
    const reasons = await gateReasons(
      repo,
      forkPoint,
      tip,
      changed,
      settings.approval,
      touchesProtected(changed, settings),
    )
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
        note: `Landing failed: ${error.message}`,
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
      note: `The repository has "${checkedOut}" checked out, but landing targets "${base}".`,
      needsOwner: true,
    }
  }

  if (settings.push) await succeeds(git(repo, 'pull', '--ff-only', 'origin', base))

  const message = `Merge ${project.key}-${issue.number}: ${issue.title}`
  const conflict = {
    status: 'todo' as const,
      note: `The branch does not merge cleanly into ${base}. Please merge ${base} into the branch, resolve the conflicts and hand it in again.`,
  }

  // Reviewed first, tested last: the check runs once, on exactly what would be pushed. It runs in
  // a landing worktree of its own, and the base branch moves only when the check is green. Before,
  // the merge sat on the base branch while the check ran, and every precheck in those minutes
  // merged the untested work into its own branch.
  const check = landingCheck(project)
  if (check) {
    const place = await landingWorktree(repo, project, base)
    if (!(await succeeds(git(place, ...IDENTITY, 'merge', '--no-ff', '-m', message, tip)))) {
      await succeeds(git(place, 'merge', '--abort'))
      return conflict
    }
    const failed = await runCommand(place, check.command, check.timeoutMin)
    if (failed) return { status: 'todo', note: failed.note }
    const tested = await git(place, 'rev-parse', 'HEAD')
    if (!(await succeeds(git(repo, 'merge', '--ff-only', tested)))) {
      return {
        status: 'blocked',
        note: `The state was green, but ${base} moved during the test or the repository has local changes. Nothing was landed.`,
        needsOwner: true,
      }
    }
  } else if (!(await succeeds(git(repo, ...IDENTITY, 'merge', '--no-ff', '-m', message, tip)))) {
    await succeeds(git(repo, 'merge', '--abort'))
    return conflict
  }

  const commit = (await git(repo, 'rev-parse', '--short', 'HEAD')) || '?'
  if (settings.push && !(await succeeds(push(project, 'origin', base)))) {
    return {
      status: 'blocked',
      note: `Merged into ${base} locally (${commit}), but the push failed.`,
      needsOwner: true,
    }
  }
  const tested = check ? `, \`${check.command}\` green` : ''
  return { status: 'done', note: `Landed in ${base} (${commit}${tested}).` }
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
  await push(project, '--force-with-lease', 'origin', `${tip}:refs/heads/${branch}`)

  const open = JSON.parse(
    await gh(project, 'pr', 'list', '--head', branch, '--state', 'open', '--json', 'number'),
  )
  let number: number = open[0]?.number
  if (!number) {
    const title = `${project.key}-${issue.number}: ${issue.title}`
    const url = await gh(
      project,
      'pr',
      'create',
      '--base',
      base,
      '--head',
      branch,
      '--title',
      title,
      '--body',
      pullRequestBody(project, issue),
    )
    number = Number(url.split('/').pop())
  }

  run("UPDATE issues SET pr_number=?, pr_sha=?, landing='waiting' WHERE id=?", number, tip, issue.id)
  return { status: 'review', note: `Pull request #${number} is open and waits for its checks.` }
}

// ---------- pull requests that wait for their checks ----------

type Check = { name?: string; status?: string; conclusion?: string; state?: string }

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
  const repo = repoOf(project)
  const view = JSON.parse(
    await gh(project, 'pr', 'view', String(issue.pr_number), '--json', 'state,headRefOid,statusCheckRollup'),
  )

  if (view.state === 'MERGED')
    return { status: 'done', note: `Pull request #${issue.pr_number} is merged.` }
  if (view.state === 'CLOSED') {
    return {
      status: 'blocked',
      note: `Pull request #${issue.pr_number} was closed without merging.`,
      needsOwner: true,
    }
  }
  // The pull request was opened for one commit, the one the reviews and gates saw. Something
  // pushed on top of it since is nobody's approved work.
  if (issue.pr_sha && view.headRefOid !== issue.pr_sha) {
    return {
      status: 'blocked',
      note: `Pull request #${issue.pr_number} no longer shows the reviewed state ${issue.pr_sha.slice(0, 10)}. Nothing was merged.`,
      needsOwner: true,
    }
  }

  const { verdict, failed } = checksVerdict(view.statusCheckRollup ?? [])
  if (verdict === 'pending') return null
  if (verdict === 'fail') {
    return {
      status: 'todo',
      note: `Checks failed in pull request #${issue.pr_number}: ${failed.join(', ')}.`,
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
    ...(method === 'merge' ? [] : ['--delete-branch']),
    '--match-head-commit',
    view.headRefOid,
  )
  await succeeds(git(repo, 'pull', '--ff-only'))
  return { status: 'done', note: `Pull request #${issue.pr_number} merged.` }
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
        const outcome = await settlePullRequest(project, issue).catch((error) => {
          console.error(`landing ${project.key}-${issue.number}:`, error.message)
          return null
        })
        if (outcome) return onSettled(issue.id, outcome)
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
