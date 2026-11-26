// The server's own check of finished work, before any reviewer spends a run on it. Everything
// here is mechanical and needs no judgement, so a model should not have to find it:
//   - every file the maker named as proof exists in its commit,
//   - nothing tracked is left uncommitted,
//   - the base branch would merge into the issue branch without conflicts (it is not merged:
//     that happens at the landing, when the issue's turn has come),
//   - no commit of the branch adds an API key, token or private key,
//   - the project's check command passes on the merged state.
import { existsSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { proofPaths, type Report } from './checklist.ts'
import { t } from './i18n.ts'
import { gitIn, runShellIn } from './sandbox.ts'
import { scanBranch, secretsNoteForMaker } from './secretScan.ts'
const IDENTITY = ['-c', 'user.name=AgentDeck', '-c', 'user.email=agentdeck@localhost']
const OUTPUT_TAIL = 2500

export type PrecheckResult = { ok: boolean; note: string }

const git = (cwd: string, ...args: string[]) => gitIn(cwd, args).then((r) => r.stdout.trim())

const succeeds = (command: Promise<unknown>) =>
  command.then(
    () => true,
    () => false,
  )

const tail = (text: string) => (text.length > OUTPUT_TAIL ? `…${text.slice(-OUTPUT_TAIL)}` : text).trim()

async function missingProofFiles(cwd: string, report: Report) {
  const missing: string[] = []
  // A pattern like data/maps/sahilkoy_*.json is found when one committed file matches it.
  // Before, git looked for a file with a star in its name and never found one (SHOP-708).
  let committed: string[] | null = null
  for (const proof of report.proofs.values()) {
    for (const path of proofPaths(proof)) {
      const relative = path.replace(/^\.\//, '')
      let found: boolean
      if (isAbsolute(path)) found = existsSync(path)
      else if (/[*?]/.test(relative)) {
        committed ??= (await git(cwd, 'ls-tree', '-r', '--name-only', 'HEAD')).split('\n')
        const pattern = globPattern(relative)
        found = committed.some((file) => pattern.test(file))
      } else found = await succeeds(git(cwd, 'cat-file', '-e', `HEAD:${relative}`))
      if (!found) missing.push(path)
    }
  }
  return [...new Set(missing)]
}

/** A file pattern as a regular expression: * and ? stay within one folder, ** crosses folders. */
export function globPattern(glob: string) {
  const source = glob
    .split('**')
    .map((part) =>
      part
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '[^/]*')
        .replace(/\?/g, '[^/]'),
    )
    .join('.*')
  return new RegExp(`^${source}$`)
}

/**
 * Other issue branches whose not yet landed commits are in this branch. A maker that merges a
 * neighbour's branch to build on it drags that work into its own review, and the reviewer sends
 * it back (SHOP-706, SHOP-710 on 22 Nov 2026).
 *
 * The maker's own commits lie on the first-parent line of its branch. Commits that came in through
 * a merge and are not in the base yet are someone else's unlanded work; the branches holding them
 * are named. A branch that has landed since is in the base and does not count, and a branch that
 * was started from this one only shares this branch's own commits.
 */
async function foreignWork(cwd: string, base: string, branch: string): Promise<string[]> {
  const lines = (text: string) => text.split('\n').filter(Boolean)
  const all = lines(await git(cwd, 'rev-list', `${base}..HEAD`).catch(() => ''))
  const own = new Set(lines(await git(cwd, 'rev-list', '--first-parent', `${base}..HEAD`).catch(() => '')))
  const mergedIn = new Set(all.filter((commit) => !own.has(commit)))
  if (!mergedIn.size) return []
  const sameIssue = (name: string) => name.split('/').pop() === branch.split('/').pop()
  const others = lines(await git(cwd, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/').catch(() => ''))
    .filter((name) => name !== branch && name !== base && !sameIssue(name))
  const found: string[] = []
  for (const other of others) {
    const theirs = lines(await git(cwd, 'rev-list', `${base}..${other}`).catch(() => ''))
    if (theirs.some((commit) => mergedIn.has(commit))) found.push(other)
  }
  return found.slice(0, 5)
}

/**
 * Would the base branch merge into this branch without conflicts? Asked without touching the
 * branch: the base is merged for real only at the landing, when the issue's turn has come, because
 * until then the base keeps moving and an early merge only adds merge commits.
 */
async function conflictsWithBase(cwd: string, base: string): Promise<PrecheckResult | null> {
  if (await succeeds(git(cwd, 'merge-base', '--is-ancestor', base, 'HEAD'))) return null
  const conflicts = await gitIn(cwd, ['merge-tree', '--write-tree', '--name-only', '--no-messages', 'HEAD', base]).then(
    () => null,
    // Exit code 1: conflicts. The first line is the tree, then one conflicted file per line.
    (error: any) => (error.code === 1 ? String(error.stdout).trim().split('\n').slice(1) : null),
  )
  if (!conflicts) return null
  return {
    ok: false,
    note: conflicts.length
      ? t(
          '{base} lässt sich nicht konfliktfrei in den Branch mergen. Konflikte in: {files}. Merge {base} in deinen Branch, löse die Konflikte so, dass beide Seiten erhalten bleiben, und gib erneut ab.',
          { base, files: conflicts.slice(0, 8).join(', ') },
        )
      : t(
          '{base} lässt sich nicht konfliktfrei in den Branch mergen. Merge {base} in deinen Branch, löse die Konflikte so, dass beide Seiten erhalten bleiben, und gib erneut ab.',
          { base },
        ),
  }
}

/**
 * Runs the check on the branch as it would land: the base merged in for the time of the check,
 * then taken back, so the branch itself stays without that merge.
 */
async function runOnMergedState(cwd: string, base: string, command: string, timeoutMin: number) {
  if (await succeeds(git(cwd, 'merge-base', '--is-ancestor', base, 'HEAD')))
    return runCommand(cwd, command, timeoutMin)
  const before = await git(cwd, 'rev-parse', 'HEAD')
  await git(cwd, ...IDENTITY, 'merge', '--no-edit', '-m', `Check against ${base}`, base)
  try {
    return await runCommand(cwd, command, timeoutMin)
  } finally {
    await git(cwd, 'reset', '--hard', before)
  }
}

export async function runCommand(
  cwd: string,
  command: string,
  timeoutMin: number,
): Promise<PrecheckResult | null> {
  try {
    // Through the system shell, like the preview command: the setting is a command line. It is
    // the project's code, so it runs as the project user, and a timeout ends all it started.
    await runShellIn(cwd, command, { timeout: timeoutMin * 60_000, maxBuffer: 32 * 1024 * 1024 })
    return null
  } catch (error: any) {
    const output = tail(`${error.stdout ?? ''}\n${error.stderr ?? ''}`)
    const what = error.killed
      ? t(
          'Die Projektprüfung `{command}` ist auf dem gemergten Stand nach {minutes} Minuten abgebrochen. Behebe das und gib erneut ab.',
          { command, minutes: timeoutMin },
        )
      : t(
          'Die Projektprüfung `{command}` ist auf dem gemergten Stand fehlgeschlagen (Exit-Code {code}). Behebe das und gib erneut ab.',
          { command, code: String(error.code) },
        )
    return { ok: false, note: `${what}\n\n\`\`\`\n${output}\n\`\`\`` }
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
        note: t(
          'Diese Nachweis-Dateien aus deiner Checkliste fehlen in deinem Commit: {files}. Erzeuge und committe sie (Pfad relativ zum Repo) und gib erneut ab.',
          {
            files: missing
              .slice(0, 8)
              .map((path) => `\`${path}\``)
              .join(', '),
          },
        ),
      }
    }
    const named = new Set([...report.proofs.values()].flatMap(proofPaths)).size
    if (named) done.push(named === 1 ? t('1 Nachweis-Datei vorhanden') : t('{n} Nachweis-Dateien vorhanden', { n: named }))
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
        note: t(
          'Nicht committete Änderungen in {files}. Committe, was zum Issue gehört, verwirf den Rest und gib erneut ab.',
          { files: files.join(', ') },
        ),
      }
    }
    const foreign = await foreignWork(cwd, base, branch)
    if (foreign.length) {
      return {
        ok: false,
        note: t(
          'Dein Branch enthält Arbeit aus anderen Branches, die noch nicht in {base} gelandet ist: {branches}. Nimm sie wieder heraus (neu von {base} abzweigen und nur deine Commits übernehmen). Brauchst du diese Arbeit, merge den Branch nicht, sondern melde <status>blocked</status> mit "wartet auf ..." und dem Issue: dann geht es von selbst weiter, sobald es gelandet ist.',
          { base, branches: foreign.join(', ') },
        ),
      }
    }
    const conflict = await conflictsWithBase(cwd, base)
    if (conflict) return conflict
    done.push(t('mit {base} konfliktfrei', { base }))
    // The landing scans again and stops there; a scan that fails here only loses the early hint.
    const secrets = await scanBranch(cwd, base).catch((error) => {
      console.error('secret scan', error.message)
      return null
    })
    if (secrets?.length) return { ok: false, note: secretsNoteForMaker(secrets, base) }
    if (secrets) done.push(t('keine Geheimnisse'))
  }

  if (command) {
    const failed = branch
      ? await runOnMergedState(cwd, base, command, timeoutMin)
      : await runCommand(cwd, command, timeoutMin)
    if (failed) return failed
    done.push(t('`{command}` grün', { command }))
  }

  return { ok: true, note: done.length ? t('Vorcheck bestanden: {checks}.', { checks: done.join(', ') }) : '' }
}
