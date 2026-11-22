// Housekeeping: what AgentDeck and its agents leave behind is cleared once a day, so the disk and
// the RAM-backed /tmp do not fill up over months. Nothing here touches a checkout an agent works
// in: a checkout that grew too big is only marked, and its build output is removed when the next
// run prepares it (see workspace.ts), the one moment nobody else can use it.
import { execFile } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { DATA_DIR, all, get, run } from './db.ts'

const execFileAsync = promisify(execFile)

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

const git = (repo: string, ...args: string[]) =>
  execFileAsync('git', ['-C', repo, ...args], { maxBuffer: 16 * 1024 * 1024 })

function pruneRunLog() {
  return Number(run('DELETE FROM run_log WHERE at < ?', Date.now() - RUN_LOG_DAYS * DAY).changes)
}

/**
 * Issue branches and per-issue worktrees of issues that are done (and landed, if the project
 * lands). A branch that is still checked out somewhere is left alone; git refuses anyway.
 */
async function removeFinishedBranches() {
  const cutoff = Date.now() - BRANCH_GRACE_DAYS * DAY
  let removed = 0
  for (const project of all<{ id: number; key: string; repo_path: string }>(
    'SELECT id, key, repo_path FROM projects',
  )) {
    const repo = project.repo_path || join(DATA_DIR, 'workspaces', project.key)
    if (!existsSync(join(repo, '.git'))) continue

    const refs = await git(
      repo,
      'for-each-ref',
      '--format=%(refname:short)',
      `refs/heads/agentdeck/${project.key}-*`,
    )
      .then(({ stdout }) => stdout.split('\n').filter(Boolean))
      .catch(() => [] as string[])

    for (const branch of refs) {
      const number = Number(branch.split('-').pop())
      const finished = get(
        "SELECT 1 FROM issues WHERE project_id=? AND number=? AND status='done' AND landing='' AND done_at < ?",
        project.id,
        number,
        cutoff,
      )
      if (!finished) continue
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
  const { stdout } = await execFileAsync('find', [
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
    execFileAsync('find', [
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
      const { stdout } = await execFileAsync('du', ['-sk', checkout]).catch(() => ({ stdout: '0' }))
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
  const branches = await removeFinishedBranches()
  // find and du are what the server's container has; on a developer's Windows machine this part rests.
  if (process.platform !== 'linux') {
    console.log(`housekeeping: ${logLines} old log lines, ${branches} finished branches`)
    return
  }
  const tmpFiles = await deleteOldFiles(tmpdir(), TMP_DAYS)
  // The CLIs keep every session as a file. AgentDeck never resumes one, it only reads the newest.
  const sessions =
    (await deleteOldFiles(join(homedir(), '.codex', 'sessions'), SESSION_DAYS, '*.jsonl')) +
    (await deleteOldFiles(join(homedir(), '.claude', 'projects'), SESSION_DAYS, '*.jsonl'))
  const marked = await markOversizedCheckouts()
  console.log(
    `housekeeping: ${logLines} old log lines, ${branches} finished branches, ${tmpFiles} files in ${tmpdir()},` +
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
