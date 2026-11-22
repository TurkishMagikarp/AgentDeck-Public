// Landing: getting an approved issue branch into the base branch. Two ways, chosen per project:
//   merge: merged locally into the base branch right away, optionally pushed.
//   pr:    pushed and opened as a pull request; it is merged once its checks pass.
// Agents never land anything themselves. This runs in the server, after the last approval.
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { apiKeyOfConnection } from './mcp.ts'
import { DATA_DIR, all, get, run } from './db.ts'

const execFileAsync = promisify(execFile)

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
}

export type Outcome = {
  status: 'done' | 'review' | 'todo' | 'blocked'
  note: string
  /** The issue now waits for a human. */
  needsOwner?: boolean
}

type Project = { id: number; key: string; repo_path: string; settings: { landing: LandingSettings } }
type Issue = { id: number; number: number; title: string }

const IDENTITY = ['-c', 'user.name=AgentDeck', '-c', 'user.email=agentdeck@localhost']

const repoOf = (project: Project) => project.repo_path || join(DATA_DIR, 'workspaces', project.key)
const branchOf = (project: Project, issue: Issue) => `agentdeck/${project.key}-${issue.number}`

async function git(repo: string, ...args: string[]) {
  const { stdout } = await execFileAsync('git', ['-C', repo, ...args], { maxBuffer: 16 * 1024 * 1024 })
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
  const { stdout } = await execFileAsync('gh', args, {
    cwd: repoOf(project),
    env,
    maxBuffer: 16 * 1024 * 1024,
  })
  return stdout.trim()
}

/** Pushes with the project's token through gh's credential helper; without a token git decides. */
async function push(project: Project, ...args: string[]) {
  const token = githubTokenOf(project)
  if (!token) return git(repoOf(project), 'push', ...args)
  const helper = ['-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential']
  const { stdout } = await execFileAsync('git', ['-C', repoOf(project), ...helper, 'push', ...args], {
    env: { ...process.env, GH_TOKEN: token },
    maxBuffer: 16 * 1024 * 1024,
  })
  return stdout.trim()
}

// Two landings in the same repository must not overlap: both would move the base branch.
const queues = new Map<string, Promise<unknown>>()

function inTurn<T>(repo: string, work: () => Promise<T>): Promise<T> {
  const next = (queues.get(repo) ?? Promise.resolve()).then(work, work)
  queues.set(
    repo,
    next.catch(() => {}),
  )
  return next
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

const OWNER_REVIEW = (files: string[]) =>
  `The branch changes protected files (${files.slice(0, 5).join(', ')}). It does not land automatically, please review and merge it yourself.`

export function landIssue(project: Project, issue: Issue): Promise<Outcome> {
  const settings = project.settings.landing
  if (settings.mode === 'off') return Promise.resolve({ status: 'done', note: '' })
  const repo = repoOf(project)

  return inTurn(repo, async (): Promise<Outcome> => {
    const branch = branchOf(project, issue)
    if (!(await succeeds(git(repo, 'rev-parse', '--verify', `refs/heads/${branch}`)))) {
      return { status: 'done', note: '' } // the issue produced no branch, e.g. a report
    }
    const base = settings.baseBranch || (await git(repo, 'symbolic-ref', '--short', 'HEAD'))
    if ((await git(repo, 'rev-list', '--count', `${base}..${branch}`)) === '0') {
      return { status: 'done', note: '' }
    }

    const changed = (await git(repo, 'diff', '--name-only', `${base}...${branch}`))
      .split('\n')
      .filter(Boolean)
    const guarded = touchesProtected(changed, settings)
    if (guarded.length) return { status: 'blocked', note: OWNER_REVIEW(guarded), needsOwner: true }
    const evidenceNote = missingEvidence(changed, issue, settings)
    if (evidenceNote) return { status: 'todo', note: evidenceNote }

    return settings.mode === 'merge'
      ? mergeLocally(repo, base, branch, project, issue, settings)
      : openPullRequest(repo, base, branch, project, issue)
  }).catch((error): Outcome => ({
    status: 'blocked',
    note: `Landing failed: ${error.message}`,
    needsOwner: true,
  }))
}

async function mergeLocally(
  repo: string,
  base: string,
  branch: string,
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
  if (!(await succeeds(git(repo, ...IDENTITY, 'merge', '--no-ff', '-m', message, branch)))) {
    await succeeds(git(repo, 'merge', '--abort'))
    return {
      status: 'todo',
      note: `The branch does not merge cleanly into ${base}. Please merge ${base} into the branch, resolve the conflicts and hand it in again.`,
    }
  }

  const commit = (await git(repo, 'rev-parse', '--short', 'HEAD')) || '?'
  if (settings.push && !(await succeeds(push(project, 'origin', base)))) {
    return {
      status: 'blocked',
      note: `Merged into ${base} locally (${commit}), but the push failed.`,
      needsOwner: true,
    }
  }
  return { status: 'done', note: `Landed in ${base} (${commit}).` }
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
  project: Project,
  issue: Issue,
): Promise<Outcome> {
  await push(project, '--force-with-lease', 'origin', `${branch}:${branch}`)

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

  run("UPDATE issues SET pr_number=?, landing='waiting' WHERE id=?", number, issue.id)
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
  issue: Issue & { pr_number: number },
): Promise<Outcome | null> {
  const repo = repoOf(project)
  const view = JSON.parse(
    await gh(project, 'pr', 'view', String(issue.pr_number), '--json', 'state,headRefOid,statusCheckRollup'),
  )

  if (view.state === 'MERGED') return { status: 'done', note: `Pull request #${issue.pr_number} was merged.` }
  if (view.state === 'CLOSED') {
    return {
      status: 'blocked',
      note: `Pull request #${issue.pr_number} was closed without merging.`,
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
  return { status: 'done', note: `Merged pull request #${issue.pr_number}.` }
}

/** Looks at every pull request that is waiting and reports the ones that reached a result. */
export function watchPullRequests(
  projectOf: (id: number) => Project | undefined,
  onSettled: (issueId: number, outcome: Outcome) => void,
) {
  let busy = false
  setInterval(async () => {
    if (busy) return
    busy = true
    try {
      const waiting = all(
        "SELECT id, project_id, number, title, pr_number FROM issues WHERE landing='waiting'",
      )
      for (const issue of waiting) {
        const project = projectOf(issue.project_id)
        if (!project) continue
        const outcome = await settlePullRequest(project, issue).catch((error) => {
          console.error(`landing ${project.key}-${issue.number}:`, error.message)
          return null
        })
        if (outcome) onSettled(issue.id, outcome)
      }
    } finally {
      busy = false
    }
  }, 60_000).unref()
}
