import { join } from 'node:path'
import { DATA_DIR } from './db.ts'
import { gitIn } from './sandbox.ts'
import { realPath } from './workspace.ts'

export const cleanupBase = (base: string) => base === 'dev' || base === 'pre-dev'
export const issueBranch = (key: string, number: number) => `agentdeck/${key}-${number}`
const commitId = (value: string) => /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)

export async function mergedInto(repo: string, tip: string, base: string) {
  if (!commitId(tip) || (!commitId(base) && !/^refs\/heads\/(?:dev|pre-dev)$/.test(base))) return false
  return gitIn(repo, ['merge-base', '--is-ancestor', tip, base]).then(() => true, () => false)
}

/**
 * Delete only the exact issue tip whose landing has already been verified by the caller.
 * Do not force-remove worktrees. Git inspects the managed issue checkout for local changes;
 * an externally held branch, dirty checkout, or ref that moved is retained.
 */
export async function removeLandedIssueBranch(repo: string, key: string, number: number, tip: string) {
  if (!commitId(tip) || !/^[A-Z][A-Z0-9-]*$/.test(key) || !Number.isSafeInteger(number) || number < 1) return false
  const ref = `refs/heads/${issueBranch(key, number)}`
  const worktree = realPath(join(DATA_DIR, 'worktrees', key, String(number)))
  try {
    const { stdout: current } = await gitIn(repo, ['rev-parse', '--verify', ref])
    if (current.trim() !== tip) return false
    const holders = async () => {
      const { stdout } = await gitIn(repo, ['worktree', 'list', '--porcelain', '-z'])
      return stdout.split('\0\0').map((row) => row.split('\0')).filter((row) => row.includes(`branch ${ref}`))
    }
    for (const [path] of await holders()) {
      if (!path.startsWith('worktree ') || realPath(path.slice(9)) !== worktree) return false
      const { stdout: dirty } = await gitIn(worktree, ['status', '--porcelain', '--untracked-files=all', '--ignored=matching'])
      if (dirty) return false
      await gitIn(repo, ['worktree', 'remove', worktree])
    }
    if ((await holders()).length) return false
    // A compare-and-delete prevents deleting commits pushed to the local ref after verification.
    await gitIn(repo, ['update-ref', '--no-deref', '-d', ref, tip])
    return true
  } catch {
    return false
  }
}
