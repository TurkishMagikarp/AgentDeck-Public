// Secrets in agent work: an API key, a token or a private key that a maker wrote into a file. Once
// pushed it is out (PR mode pushes the whole branch), so it is looked for before the review in the
// precheck and once more before landing. The added lines of every commit are scanned, not only
// the end state: a key that a later commit deletes is still in the history that gets pushed.
// Findings never repeat the secret; they name the kind, the file, the commit and a masked hint.
import { gitIn } from './sandbox.ts'

export type SecretFinding = { rule: string; file: string; commit: string; hint: string }

type Rule = { id: string; label: string; pattern: RegExp; check?: (value: string) => boolean }

const PLACEHOLDER = /example|placeholder|dummy|changeme|your[_-]?|xxxx|<[^>]*>|\$\{|process\.env|os\.environ|getenv/i

/** Bits per character; random keys are high, words and repeated characters low. */
export function entropy(value: string) {
  const counts = new Map<string, number>()
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1)
  let bits = 0
  for (const count of counts.values()) {
    const p = count / value.length
    bits -= p * Math.log2(p)
  }
  return bits
}

// Ordered: the first rule that matches a line names it.
const RULES: Rule[] = [
  { id: 'private-key', label: 'private key', pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/ },
  { id: 'anthropic', label: 'Anthropic API key', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { id: 'openai', label: 'OpenAI/DeepSeek API key', pattern: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}/ },
  { id: 'github', label: 'GitHub token', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})/ },
  { id: 'aws', label: 'AWS access key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { id: 'google', label: 'Google API key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { id: 'slack', label: 'Slack token', pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/ },
  { id: 'stripe', label: 'Stripe key', pattern: /\b(?:sk|rk)_live_[0-9A-Za-z]{20,}/ },
  { id: 'npm', label: 'npm token', pattern: /\bnpm_[A-Za-z0-9]{36}\b/ },
  { id: 'jwt', label: 'JWT', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{16,}/ },
  {
    id: 'assignment',
    label: 'Password or token in the code',
    pattern: /(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)["']?\s*[:=]\s*["']([^"'\s]{16,200})["']/i,
    check: (value) => entropy(value) >= 3.5 && /\d/.test(value) && /[A-Za-z]/.test(value),
  },
]

const MAX_LINE = 10_000
const MAX_FINDINGS = 20

const mask = (value: string) => `${value.slice(0, 4)}… (${value.length} characters)`

/** The secret a line holds, or null. Documentation values (AWS's ...EXAMPLE keys) do not count. */
export function secretIn(line: string): { rule: Rule; value: string } | null {
  if (line.length > MAX_LINE) return null
  for (const rule of RULES) {
    const match = rule.pattern.exec(line)
    if (!match) continue
    const value = match[1] ?? match[0]
    if (PLACEHOLDER.test(value) || (rule.check && !rule.check(value))) continue
    return { rule, value }
  }
  return null
}

/**
 * The added lines of a patch. A line starting with NUL names the commit of what follows
 * (`git log --format=%x00%h`); a plain diff has none.
 */
export function scanPatch(patch: string, commit = ''): SecretFinding[] {
  const found: SecretFinding[] = []
  let file = ''
  let inHeader = false
  for (const line of patch.split('\n')) {
    if (line.startsWith('\0')) {
      commit = line.slice(1).trim()
      inHeader = false
    } else if (line.startsWith('diff --git ')) {
      inHeader = true
      file = ''
    } else if (inHeader) {
      if (line.startsWith('+++ ')) file = line.slice(4).replace(/^b\//, '')
      else if (line.startsWith('@@')) inHeader = false
    } else if (line.startsWith('+')) {
      const hit = secretIn(line.slice(1))
      if (hit) {
        found.push({ rule: hit.rule.label, file, commit, hint: mask(hit.value) })
        if (found.length >= MAX_FINDINGS) break
      }
    }
  }
  return found
}

// No external diff tools or text conversion: a .gitattributes in the branch must not choose
// what the scan sees, or run anything.
const DIFF = ['--no-color', '--no-ext-diff', '--no-textconv', '-U0']

/** Secrets that commits between base and head add, and the head adds against the base. */
export async function scanBranch(repo: string, base: string, head = 'HEAD'): Promise<SecretFinding[]> {
  const options = { maxBuffer: 64 * 1024 * 1024 }
  const [log, net] = await Promise.all([
    gitIn(repo, ['-c', 'core.quotePath=false', 'log', '--no-merges', '-p', ...DIFF, '--format=%x00%h', `${base}..${head}`], options),
    gitIn(repo, ['-c', 'core.quotePath=false', 'diff', ...DIFF, base, head], options),
  ])
  const seen = new Set<string>()
  const findings: SecretFinding[] = []
  for (const finding of [...scanPatch(String(log.stdout)), ...scanPatch(String(net.stdout), head)]) {
    const key = `${finding.rule}|${finding.file}|${finding.hint}`
    if (seen.has(key)) continue
    seen.add(key)
    findings.push(finding)
  }
  return findings.slice(0, MAX_FINDINGS)
}

export const findingsList = (findings: SecretFinding[]) =>
  findings
    .slice(0, 8)
    .map((f) => `- ${f.rule} in \`${f.file}\`${f.commit ? ` (Commit ${f.commit})` : ''}: ${f.hint}`)
    .join('\n')

/** For the maker: take it out of every commit, not only out of the last one. */
export const secretsNoteForMaker = (findings: SecretFinding[], base: string) =>
  `Your branch contains what looks like a secret (API key, token or private key):\n${findingsList(findings)}\n\nTake it out of the code and out of every commit: a commit that only deletes it again is not enough, the history is pushed too. To do that, branch off ${base} anew and bring your work over without the secret. Values the code needs come from environment variables. For test data use values that are plainly fake (with "example" in them). Then hand in again.`

/** For the owner: nothing lands, and a real key has to be replaced. */
export const secretsNoteForOwner = (findings: SecretFinding[]) =>
  `The branch contains what looks like a secret, so it does not land automatically:\n${findingsList(findings)}\n\nIf it is real: revoke and replace the key at the provider, then hand the issue back. If it is a false alarm: check and merge it yourself.`
