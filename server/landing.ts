// Landing: getting an approved issue branch into the base branch. Two ways, chosen per project:
//   merge: merged locally into the base branch right away, optionally pushed.
//   pr:    pushed and opened as a pull request; it is merged once its checks pass.
// Agents never land anything themselves. This runs in the server, after the last approval.
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { apiKeyOfConnection } from './mcp.ts'
import { DATA_DIR, all, run } from './db.ts'

const execFileAsync = promisify(execFile)

export type LandingSettings = {
  mode: 'off' | 'merge' | 'pr'
  /** Empty: the branch that is checked out in the repository. */
  baseBranch: string
  /** merge mode only: push the base branch after merging. */
  push: boolean
  /** Paths (prefixes) only a human may change. A branch touching them is not landed automatically. */
  protectedPaths: string[]
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

/** gh uses the GitHub connection's token when one is stored, otherwise its own login. */
async function gh(repo: string, ...args: string[]) {
  const token = apiKeyOfConnection('github')
  const env = token ? { ...process.env, GH_TOKEN: token } : process.env
  const { stdout } = await execFileAsync('gh', args, { cwd: repo, env, maxBuffer: 16 * 1024 * 1024 })
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
  if (settings.push && !(await succeeds(git(repo, 'push', 'origin', base)))) {
    return {
      status: 'blocked',
      note: `Merged into ${base} locally (${commit}), but the push failed.`,
      needsOwner: true,
    }
  }
  return { status: 'done', note: `Landed in ${base} (${commit}).` }
}

async function openPullRequest(
  repo: string,
  base: string,
  branch: string,
  project: Project,
  issue: Issue,
): Promise<Outcome> {
  await git(repo, 'push', '--force-with-lease', 'origin', `${branch}:${branch}`)

  const open = JSON.parse(
    await gh(repo, 'pr', 'list', '--head', branch, '--state', 'open', '--json', 'number'),
  )
  let number: number = open[0]?.number
  if (!number) {
    const title = `${project.key}-${issue.number}: ${issue.title}`
    const url = await gh(
      repo,
      'pr',
      'create',
      '--base',
      base,
      '--head',
      branch,
      '--title',
      title,
      '--body',
      'Opened by AgentDeck after review.',
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
    await gh(repo, 'pr', 'view', String(issue.pr_number), '--json', 'state,headRefOid,statusCheckRollup'),
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
  await gh(repo, 'pr', 'merge', String(issue.pr_number), '--merge', '--match-head-commit', view.headRefOid)
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
