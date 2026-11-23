// The server's own check of finished work, before any reviewer spends a run on it. Everything
// here is mechanical and needs no judgement, so a model should not have to find it:
//   - every file the maker named as proof exists in its commit,
//   - nothing tracked is left uncommitted,
//   - the base branch merges into the issue branch without conflicts (and is merged, so the
//     review and the landing see the branch as it will land),
//   - the project's check command passes on the merged state.
import { exec, execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { promisify } from 'node:util'
import { proofPaths, type Report } from './checklist.ts'

const execAsync = promisify(exec)
const execFileAsync = promisify(execFile)
const IDENTITY = ['-c', 'user.name=AgentDeck', '-c', 'user.email=agentdeck@localhost']
const OUTPUT_TAIL = 2500

export type PrecheckResult = { ok: boolean; note: string }

const git = (cwd: string, ...args: string[]) =>
  execFileAsync('git', ['-C', cwd, ...args], { maxBuffer: 16 * 1024 * 1024 }).then((r) => r.stdout.trim())

const succeeds = (command: Promise<unknown>) =>
  command.then(
    () => true,
    () => false,
  )

const tail = (text: string) => (text.length > OUTPUT_TAIL ? `…${text.slice(-OUTPUT_TAIL)}` : text).trim()

async function missingProofFiles(cwd: string, report: Report) {
  const missing: string[] = []
  for (const proof of report.proofs.values()) {
    for (const path of proofPaths(proof)) {
      const found = isAbsolute(path)
        ? existsSync(path)
        : await succeeds(git(cwd, 'cat-file', '-e', `HEAD:${path.replace(/^\.\//, '')}`))
      if (!found) missing.push(path)
    }
  }
  return [...new Set(missing)]
}

async function mergeBase(cwd: string, base: string, branch: string): Promise<PrecheckResult | null> {
  if (await succeeds(git(cwd, 'merge-base', '--is-ancestor', base, 'HEAD'))) return null
  const merged = await succeeds(
    git(cwd, ...IDENTITY, 'merge', '--no-edit', '-m', `Merge ${base} into ${branch}`, base),
  )
  if (merged) return null
  const conflicts = (await git(cwd, 'diff', '--name-only', '--diff-filter=U').catch(() => ''))
    .split('\n')
    .filter(Boolean)
  await succeeds(git(cwd, 'merge', '--abort'))
  return {
    ok: false,
    note: `${base} does not merge into the branch without conflicts${conflicts.length ? `. Conflicts in: ${conflicts.slice(0, 8).join(', ')}` : ''}. Merge ${base} into your branch, resolve the conflicts so that both sides are kept, and hand in again.`,
  }
}

export async function runCommand(
  cwd: string,
  command: string,
  timeoutMin: number,
): Promise<PrecheckResult | null> {
  try {
    // Through the system shell, like the preview command: the setting is a command line.
    await execAsync(command, {
      cwd,
      timeout: timeoutMin * 60_000,
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
    })
    return null
  } catch (error: any) {
    const output = tail(`${error.stdout ?? ''}\n${error.stderr ?? ''}`)
    const why = error.killed ? `was stopped after ${timeoutMin} minutes` : `failed (exit code ${error.code})`
    return {
      ok: false,
      note: `The project check \`${command}\` ${why} on the merged state. Fix that and hand in again.\n\n\`\`\`\n${output}\n\`\`\``,
    }
  }
}

export async function precheck(input: {
  cwd: string
  branch?: string
  base: string
  command: string
  timeoutMin: number
  report: Report | null
}): Promise<PrecheckResult> {
  const { cwd, branch, base, command, timeoutMin, report } = input
  const done: string[] = []

  if (report) {
    const missing = await missingProofFiles(cwd, report)
    if (missing.length) {
      return {
        ok: false,
        note: `These proof files from your checklist are missing from your commit: ${missing
          .slice(0, 8)
          .map((path) => `\`${path}\``)
          .join(', ')}. Create and commit them (path relative to the repo) and hand in again.`,
      }
    }
    const named = new Set([...report.proofs.values()].flatMap(proofPaths)).size
    if (named) done.push(named === 1 ? '1 proof file present' : `${named} proof files present`)
  }

  if (branch) {
    const dirty = await git(cwd, 'status', '--porcelain', '--untracked-files=no').catch(() => '')
    if (dirty) {
      const files = dirty
        .split('\n')
        .map((line) => line.slice(3))
        .slice(0, 8)
      return {
        ok: false,
        note: `Uncommitted changes in ${files.join(', ')}. Commit what belongs to the issue, discard the rest and hand in again.`,
      }
    }
    const conflict = await mergeBase(cwd, base, branch)
    if (conflict) return conflict
    done.push(`${base} eingemergt`)
  }

  if (command) {
    const failed = await runCommand(cwd, command, timeoutMin)
    if (failed) return failed
    done.push(`\`${command}\` green`)
  }

  return { ok: true, note: done.length ? `Precheck passed: ${done.join(', ')}.` : '' }
}
