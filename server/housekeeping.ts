// Housekeeping: what AgentDeck and its agents leave behind is cleared once a day, so the disk and
// the RAM-backed /tmp do not fill up over months. Nothing here touches a checkout an agent works
// in: a checkout that grew too big is only marked, and its build output is removed when the next
// run prepares it (see workspace.ts), the one moment nobody else can use it.
import { existsSync, readdirSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { DATA_DIR, all, get, run } from './db.ts'
import { pruneRunEvents } from './runEvents.ts'
import { pruneTrace } from './landingTrace.ts'
import { execIn, gitIn } from './sandbox.ts'
import { pruneAudit } from './audit.ts'
import { getProject } from './core.ts'
import { baseBranchOf, confirmsStageMerge, originStageRefs, removeRemoteLandedBranch } from './landing.ts'
import { cleanupBase, issueBranch, mergedInto, removeLandedIssueBranch } from './branchCleanup.ts'


const DAY = 86_400_000
const RUN_LOG_DAYS = 30
/** A landed branch is kept a day longer, in case someone wants to look at it. */
const BRANCH_GRACE_DAYS = 1
const SESSION_DAYS = 14
const TMP_DAYS = 2
const CHECKOUT_LIMIT_GB = Number(process.env.AGENTDECK_CHECKOUT_LIMIT_GB ?? 10)

/** Checkouts above the size limit. prepareWorkdir removes their build output before the next run. */
export const oversized = new Set<string>()

const succeeds = (command: Promise<unknown>) =>
  command.then(
    () => true,
    () => false,
  )

const git = (repo: string, ...args: string[]) => gitIn(repo, args)

function pruneRunLog() {
  return Number(run('DELETE FROM run_log WHERE at < ?', Date.now() - RUN_LOG_DAYS * DAY).changes)
}

/** The replay timelines are kept as long as the run log. */
const pruneReplays = () => pruneRunEvents(Date.now() - RUN_LOG_DAYS * DAY) + pruneTrace(Date.now() - RUN_LOG_DAYS * DAY)

/**
 * Issue branches and per-issue worktrees of issues that are done (and landed, if the project
 * lands). A branch that is still checked out somewhere is left alone; git refuses anyway.
 */
export async function removeFinishedBranches() {
  const cutoff = Date.now() - BRANCH_GRACE_DAYS * DAY
  let removed = 0
  for (const project of all<{ id: number; key: string; repo_path: string }>(
    'SELECT id, key, repo_path FROM projects',
  )) {
    const repo = project.repo_path || join(DATA_DIR, 'workspaces', project.key)
    if (!existsSync(join(repo, '.git'))) continue
    const configured = getProject(project.id)
    if (!configured) continue
    const base = await baseBranchOf(configured).catch(() => '')
    if (!base) continue
    const stage = cleanupBase(base)
    const remote = stage && (configured.settings.landing.push || configured.settings.landing.mode === 'pr')

    const refs = await git(
      repo,
      'for-each-ref',
      '--format=%(refname:short)%09%(objectname)',
      `refs/heads/agentdeck/${project.key}-*`,
    )
      .then(({ stdout }) => stdout.split('\n').filter(Boolean))
      .catch(() => [] as string[])

    const local = new Map(refs.map((entry) => entry.split('\t') as [string, string]))
    const upstream = remote ? await originStageRefs(configured, base).catch(() => undefined) : undefined
    const target = remote ? upstream?.target ?? '' : `refs/heads/${base}`
    for (const branch of new Set([...local.keys(), ...(upstream?.issues.keys() ?? [])])) {
      const number = Number(branch.split('-').pop())
      if (!Number.isSafeInteger(number) || number < 1 || branch !== issueBranch(project.key, number)) continue
      const finished = get(
        `SELECT i.id, i.title, i.pr_number, i.pr_sha FROM issues i WHERE i.project_id=? AND i.number=? AND i.status='done'
         AND i.landing='' AND i.done_at < ?
         AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.issue_id=i.id AND r.status='running')`,
        project.id,
        number,
        stage ? Date.now() + 1 : cutoff,
      )
      if (!finished) continue
      if (stage) {
        const localTip = local.get(branch)
        const upstreamTip = upstream?.issues.get(branch)
        const issue = { ...finished, number }
        let proof: Promise<boolean> | undefined
        const verified = async (tip: string) =>
          (await mergedInto(repo, tip, target)) ||
          (configured.settings.landing.mode === 'pr' && tip === finished.pr_sha &&
            await (proof ??= confirmsStageMerge(configured, issue).catch(() => false)))
        if (upstreamTip && await verified(upstreamTip))
          await removeRemoteLandedBranch(configured, issue, upstreamTip)
        if (localTip && await verified(localTip) &&
            await removeLandedIssueBranch(repo, project.key, number, localTip)) removed++
        continue
      }
      const worktree = join(DATA_DIR, 'worktrees', project.key, String(number))
      if (existsSync(worktree)) await succeeds(git(repo, 'worktree', 'remove', '--force', worktree))
      if (await succeeds(git(repo, 'branch', '-D', branch))) removed++
    }
    await succeeds(git(repo, 'worktree', 'prune'))
  }
  return removed
}

/** Deletes files older than `days` below `dir` (only those matching `name`), then empty folders. */
async function deleteOldFiles(dir: string, days: number, name = '*') {
  if (!existsSync(dir)) return 0
  // As the folder's owner: a project's files are deleted by its own user.
  const { stdout } = await execIn(dir, 'find', [
    dir,
    '-xdev',
    '-mindepth',
    '1',
    '-type',
    'f',
    '-name',
    name,
    '-mtime',
    `+${days - 1}`,
    '-print',
    '-delete',
  ]).catch((error) => ({ stdout: error.stdout ?? '' }))
  await succeeds(
    execIn(dir, 'find', [
      dir,
      '-xdev',
      '-mindepth',
      '1',
      '-type',
      'd',
      '-empty',
      '-mtime',
      `+${days - 1}`,
      '-delete',
    ]),
  )
  return stdout.split('\n').filter(Boolean).length
}

/** Measures every checkout and marks those above the limit. Measuring only reads. */
async function markOversizedCheckouts() {
  const root = join(DATA_DIR, 'worktrees')
  if (!existsSync(root)) return []
  const marked: string[] = []
  for (const key of readdirSync(root)) {
    for (const name of readdirSync(join(root, key))) {
      const checkout = join(root, key, name)
      const { stdout } = await execIn(checkout, 'du', ['-sk', checkout]).catch(() => ({ stdout: '0' }))
      const gigabytes = Number(stdout.split('\t')[0]) / 1024 / 1024
      if (gigabytes > CHECKOUT_LIMIT_GB) {
        oversized.add(checkout)
        marked.push(`${key}/${name} ${gigabytes.toFixed(1)} GB`)
      }
    }
  }
  return marked
}

export async function houseKeeping() {
  const logLines = pruneRunLog()
  const auditEntries = pruneAudit()
  const replayEvents = pruneReplays()
  const branches = await removeFinishedBranches()
  // find and du are what the server's container has; on a developer's Windows machine this part rests.
  if (process.platform !== 'linux') {
    console.log(
      `housekeeping: ${logLines} old log lines, ${auditEntries} old audit entries, ${replayEvents} replay events, ${branches} finished branches`,
    )

    return
  }
  const tmpFiles = await deleteOldFiles(tmpdir(), TMP_DAYS)
  // The CLIs keep every session as a file. AgentDeck never resumes one, it only reads the newest.
  // In the sandbox the runs keep their sessions in the homes of the project users.
  const homesDir = join(DATA_DIR, 'homes')
  const homes = [homedir(), ...(existsSync(homesDir) ? readdirSync(homesDir).map((name) => join(homesDir, name)) : [])]
  let sessions = 0
  for (const home of homes) {
    sessions +=
      (await deleteOldFiles(join(home, '.codex', 'sessions'), SESSION_DAYS, '*.jsonl')) +
      (await deleteOldFiles(join(home, '.claude', 'projects'), SESSION_DAYS, '*.jsonl'))
  }
  const marked = await markOversizedCheckouts()
  console.log(
    `housekeeping: ${logLines} old log lines, ${auditEntries} old audit entries, ${replayEvents} replay events, ${branches} finished branches,` +
      ` ${tmpFiles} files in ${tmpdir()},` +

      ` ${sessions} old CLI sessions` +
      (marked.length ? `; emptied before their next run: ${marked.join(', ')}` : ''),
  )
}

export function startHousekeeping() {
  const runSafely = () => houseKeeping().catch((error) => console.error('housekeeping', error))
  // Not right at the start: after a restart the agents come back first.
  setTimeout(runSafely, 10 * 60_000).unref()
  setInterval(runSafely, DAY).unref()
}
