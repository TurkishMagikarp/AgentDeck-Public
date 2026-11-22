// What an issue changed in the code: the commits of its branch and the diff against the base
// branch, file by file. While an agent still works in a per-issue worktree, its uncommitted
// changes show up too, so the owner can watch the code grow without a terminal.
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { DATA_DIR } from './db.ts'

const execFileAsync = promisify(execFile)

/** Above this a file's patch is cut, the file list stays complete. */
const MAX_PATCH_CHARS = 60_000
const MAX_TOTAL_CHARS = 400_000

type Project = { key: string; repo_path: string; settings: { landing: { baseBranch: string } } }

export type FileChange = {
  path: string
  added: number
  removed: number
  binary: boolean
  patch: string
  cut: boolean
}

async function git(repo: string, ...args: string[]) {
  const { stdout } = await execFileAsync('git', ['-C', repo, ...args], { maxBuffer: 64 * 1024 * 1024 })
  return stdout
}

const succeeds = (command: Promise<unknown>) =>
  command.then(
    () => true,
    () => false,
  )

/** "12\t3\tpath" lines; binary files have "-" for both counts. */
function parseNumstat(text: string) {
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [added, removed, ...rest] = line.split('\t')
      return {
        path: rest.join('\t'),
        added: Number(added) || 0,
        removed: Number(removed) || 0,
        binary: added === '-',
      }
    })
}

/** Splits a unified diff into the patch of each file, keyed by the file's new path. */
function patchesByFile(diff: string) {
  const patches = new Map<string, string>()
  for (const chunk of diff.split(/^(?=diff --git )/m)) {
    const path = chunk.match(/^\+\+\+ b\/(.+)$/m)?.[1] ?? chunk.match(/^diff --git a\/.+ b\/(.+)$/m)?.[1]
    if (path) patches.set(path, chunk.slice(chunk.indexOf('@@') >= 0 ? chunk.indexOf('@@') : 0))
  }
  return patches
}

function combine(numstat: string, diff: string): FileChange[] {
  const patches = patchesByFile(diff)
  let budget = MAX_TOTAL_CHARS
  return parseNumstat(numstat).map((file) => {
    const full = file.binary ? '' : (patches.get(file.path) ?? '')
    const limit = Math.min(MAX_PATCH_CHARS, Math.max(0, budget))
    const patch = full.slice(0, limit)
    budget -= patch.length
    return { ...file, patch, cut: patch.length < full.length }
  })
}

export async function issueChanges(project: Project, issueNumber: number) {
  const repo = project.repo_path || join(DATA_DIR, 'workspaces', project.key)
  const branch = `agentdeck/${project.key}-${issueNumber}`
  if (!existsSync(repo) || !(await succeeds(git(repo, 'rev-parse', '--verify', 'HEAD')))) {
    return { state: 'no-repo' as const, branch, base: '', commits: [], files: [], uncommitted: [] }
  }

  const base =
    project.settings.landing.baseBranch || (await git(repo, 'symbolic-ref', '--short', 'HEAD')).trim()
  const hasBranch = await succeeds(git(repo, 'rev-parse', '--verify', `refs/heads/${branch}`))

  let commits: { hash: string; subject: string; at: number }[] = []
  let files: FileChange[] = []
  if (hasBranch) {
    // Three dots: what the branch changed since it left the base, not what the base did meanwhile.
    const range = `${base}...${branch}`
    const [log, numstat, diff] = await Promise.all([
      git(repo, 'log', '--format=%h%x09%ct%x09%s', `${base}..${branch}`),
      git(repo, 'diff', '--numstat', range),
      git(repo, 'diff', '--no-color', range),
    ])
    commits = log
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [hash, at, ...subject] = line.split('\t')
        return { hash, at: Number(at) * 1000, subject: subject.join('\t') }
      })
    files = combine(numstat, diff)
  }

  // Work in progress of the per-issue layout. The agent layout shares checkouts between issues.
  const worktree = join(DATA_DIR, 'worktrees', project.key, String(issueNumber))
  let uncommitted: FileChange[] = []
  if (existsSync(worktree) && (await succeeds(git(worktree, 'rev-parse', '--verify', 'HEAD')))) {
    const [numstat, diff] = await Promise.all([
      git(worktree, 'diff', '--numstat', 'HEAD'),
      git(worktree, 'diff', '--no-color', 'HEAD'),
    ])
    uncommitted = combine(numstat, diff)
  }

  const state = !hasBranch ? 'no-branch' : commits.length || files.length ? 'changes' : 'landed-or-empty'
  return { state, branch, base, commits, files, uncommitted }
}
