// Where an agent works. Two layouts, chosen per project:
//   issue: every issue has its own worktree. Nothing is shared, nothing has to be switched.
//   agent: every agent keeps one checkout and switches to the issue's branch. Build caches that
//          are expensive to recreate (an engine's asset import, node_modules) survive between issues.
import { existsSync, realpathSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { DATA_DIR } from './db.ts'
import { oversized } from './housekeeping.ts'
import { t } from './i18n.ts'
import type { EgressSettings } from './egress.ts'
import { ensureEgress, ensureProject, gitIn, SANDBOX } from './sandbox.ts'
import { egressStatus } from './egress.ts'

export type Workdir = { cwd: string; branch?: string }

type Request = {
  project: { key: string; repo_path: string; settings: { workspace: 'issue' | 'agent'; egress?: EgressSettings } }
  issueNumber: number
  agentId: number
  /** Which parallel copy of the agent this is, starting at 0. */
  slot: number
  /** Reviewers look at the maker's branch but must not hold it, or the maker could not continue. */
  readOnly: boolean
}

const git = (repo: string, ...args: string[]) => gitIn(repo, args)
const succeeds = (command: Promise<unknown>) =>
  command.then(
    () => true,
    () => false,
  )

// Asking git on every run start is slow on Windows, and the answer rarely changes.
const repoChecks = new Map<string, { isRepo: boolean; at: number }>()

async function hasCommits(base: string) {
  const cached = repoChecks.get(base)
  if (cached && Date.now() - cached.at < 60_000) return cached.isRepo
  const isRepo = (await isRepoRoot(base)) && (await succeeds(git(base, 'rev-parse', '--verify', 'HEAD')))
  repoChecks.set(base, { isRepo, at: Date.now() })
  return isRepo
}

/**
 * The one spelling of a path. Git prints the long form of a Windows path while a temp folder often
 * comes in its short form ("RUNNER~1"), and a link can stand for a folder: compared as text, the
 * same place would look like two.
 */
function realPath(path: string) {
  try {
    return realpathSync.native(path)
  } catch {
    return resolve(path)
  }
}

/**
 * A plain folder that merely sits inside some other repository is not a repo of its own. Without
 * this check git would answer for the surrounding repository, and branches would land there.
 */
async function isRepoRoot(base: string) {
  try {
    const { stdout } = await git(base, 'rev-parse', '--show-toplevel')
    return relative(realPath(stdout.trim()), realPath(base)) === ''
  } catch {
    return false
  }
}

// Other people push to the remote too. New issue branches should start from what is there now.
const lastPull = new Map<string, number>()

async function pullIfRemote(base: string) {
  if (Date.now() - (lastPull.get(base) ?? 0) < 60_000) return
  lastPull.set(base, Date.now())
  if (await succeeds(git(base, 'remote', 'get-url', 'origin'))) await succeeds(git(base, 'pull', '--ff-only'))
}

export async function prepareWorkdir(request: Request): Promise<Workdir> {
  const { project } = request
  const base = project.repo_path || join(DATA_DIR, 'workspaces', project.key)
  await mkdir(base, { recursive: true })
  // In the sandbox the project user takes over the repo before anything runs in it.
  await ensureProject(project)
  // An allowlist project starts no run before its firewall rules are in place, and none at all
  // while they cannot be set: the proxy env alone is no barrier, an agent can unset it.
  await ensureEgress(project)
  if (SANDBOX && project.settings.egress?.mode === 'allowlist' && egressStatus(project.key).firewall !== 'active') {
    const { error } = egressStatus(project.key)
    throw new Error(
      error
        ? t('Netzwerk-Allowlist ohne Firewall, kein Lauf gestartet: {error}', { error })
        : t('Netzwerk-Allowlist ohne Firewall, kein Lauf gestartet'),
    )
  }
  if (!(await hasCommits(base))) return { cwd: base } // no git repo or no commit yet: work in place
  await pullIfRemote(base)

  const branch = `agentdeck/${project.key}-${request.issueNumber}`
  return project.settings.workspace === 'agent'
    ? agentCheckout(base, branch, request)
    : issueWorktree(base, branch, request)
}

async function issueWorktree(base: string, branch: string, request: Request): Promise<Workdir> {
  const worktree = join(DATA_DIR, 'worktrees', request.project.key, String(request.issueNumber))
  if (!existsSync(worktree)) {
    const branchExists = await succeeds(git(base, 'rev-parse', '--verify', `refs/heads/${branch}`))
    await git(base, 'worktree', 'add', ...(branchExists ? [worktree, branch] : ['-b', branch, worktree]))
  }
  return { cwd: worktree, branch }
}

async function agentCheckout(base: string, branch: string, request: Request): Promise<Workdir> {
  const name = `agent-${request.agentId}-${request.slot}`
  const worktree = join(DATA_DIR, 'worktrees', request.project.key, name)
  if (!existsSync(worktree)) await git(base, 'worktree', 'add', '--detach', worktree)
  if (oversized.delete(worktree)) {
    // Housekeeping found this checkout too big. Only what git ignores goes (node_modules, build
    // output, import caches); work that is not committed yet stays.
    await succeeds(git(worktree, 'clean', '-fdXq'))
    console.log(`housekeeping: emptied the build output of ${worktree}`)
  }

  const branchExists = await succeeds(git(base, 'rev-parse', '--verify', `refs/heads/${branch}`))
  if (branchExists && !request.readOnly) await takeBranchBack(base, branch, worktree)
  const checkout = request.readOnly
    ? ['checkout', '--detach', branchExists ? branch : 'HEAD']
    : branchExists
      ? ['checkout', branch]
      : ['checkout', '-b', branch, (await git(base, 'rev-parse', 'HEAD')).stdout.trim()]

  if (!(await succeeds(git(worktree, ...checkout)))) {
    // Leftovers of an aborted run block the switch. They are kept in a stash, not thrown away.
    await git(worktree, 'stash', 'push', '--include-untracked', '-m', `agentdeck: before ${branch}`)
    await git(worktree, ...checkout)
  }
  return { cwd: worktree, branch }
}

/**
 * A branch can be checked out in one worktree only. If another agent checkout still holds it (its
 * release failed, or the server stopped mid-run), it lets go of it here. Only one run works on an
 * issue at a time and reviewers never hold the branch, so the other checkout is not in use.
 * Without this every run of the issue fails at the checkout, on 2026-11-23 for eleven hours.
 * Uncommitted leftovers there go to a stash, as in agentCheckout.
 */
async function takeBranchBack(base: string, branch: string, worktree: string) {
  const { stdout } = await git(base, 'worktree', 'list', '--porcelain')
  for (const entry of stdout.split(/\r?\n\r?\n/)) {
    const lines = entry.split(/\r?\n/)
    if (!lines.includes(`branch refs/heads/${branch}`)) continue
    const holder = realPath(lines[0].replace(/^worktree /, ''))
    const isOtherAgentCheckout =
      holder !== realPath(worktree) &&
      dirname(holder) === realPath(dirname(worktree)) &&
      basename(holder).startsWith('agent-')
    if (!isOtherAgentCheckout) continue
    await succeeds(git(holder, 'stash', 'push', '--include-untracked', '-m', `agentdeck: before releasing ${branch}`))
    await git(holder, 'checkout', '--detach')
    console.log(`workspace: ${basename(holder)} let go of ${branch} for ${basename(worktree)}`)
  }
}

/**
 * In the agent layout a branch can be checked out in one place only. Letting go of it after
 * the run frees it for the next agent, usually the reviewer or the maker of the next round.
 */
export async function releaseWorkdir(project: Request['project'], workdir: Workdir) {
  if (project.settings.workspace !== 'agent' || !workdir.branch) return
  // A branch that stays held makes the next run of the issue fail elsewhere, so say it.
  await git(workdir.cwd, 'checkout', '--detach').catch((e) =>
    console.error(`workspace: ${workdir.cwd} could not let go of ${workdir.branch}: ${e.message}`),
  )
}
