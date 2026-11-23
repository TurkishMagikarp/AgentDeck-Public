// Self-healing: a failed run is sorted into a kind of failure, and each kind gets its own way out.
// A rate limit is not the issue's fault, so it does not count as a failed attempt and the provider
// rests until its limit resets. A missing tool or an overfull context gets a hint for the next run.
import { all } from './db.ts'
import { limitingWindows } from './pacing.ts'

export type FailureKind = 'limit' | 'access' | 'network' | 'toolchain' | 'context' | 'unknown'

export type Failure = {
  kind: FailureKind
  /** What went wrong, in one short line for the comment. */
  cause: string
  /** For "limit": when the provider may be asked again, if the message says so. */
  until?: number
  /** For "toolchain": the missing command or module. */
  missing?: string
}

const MINUTE = 60_000

/** Failures that are the provider's fault, not the issue's. They do not count as attempts. */
export const PROVIDER_FAILURES: FailureKind[] = ['limit', 'access']

// A false match rests the provider for every project, so these only take what is unmistakable.
const LIMIT_RE =
  /usage limit|rate[ _-]?limit|too many requests|\b429\b|quota exceeded|limit reached|hit your limit|overloaded_error|\b529\b|insufficient[_ ]credit|credit balance is too low/i
const ACCESS_RE =
  /not logged in|please run \/login|invalid (x-)?api[ _-]?key|authentication_error|oauth token (has )?expired|failed to start/i
const NETWORK_RE =
  /econnreset|etimedout|econnrefused|eai_again|enotfound|socket hang up|network error|fetch failed|\b50[234]\b|bad gateway|service unavailable|gateway time-?out|stream (was )?(closed|ended|disconnected)/i
const CONTEXT_RE =
  /prompt is too long|context[_ ]length|context window|maximum context|too many tokens|input is too long|context_length_exceeded/i
const MISSING_COMMAND_RE = /(?:^|\s|:)([\w.+-]+): (?:command not found|not found)\b/im
const MISSING_MODULE_RE =
  /(?:No module named|ModuleNotFoundError: No module named|Cannot find module|cannot find package) '([^']+)'/i

/** The last lines the agent printed, where a missing tool usually shows up before the run dies. */
function logTail(runId: number) {
  return all('SELECT text FROM run_log WHERE run_id=? ORDER BY id DESC LIMIT 15', runId)
    .reverse()
    .map((row) => row.text)
    .join('\n')
}

/** Reads a reset time out of the limit messages Claude Code, Codex and the APIs print. */
function resetTime(message: string, now = Date.now()): number | undefined {
  const epoch = message.match(/\|(\d{10})\b/)?.[1]
  if (epoch) return Number(epoch) * 1000

  const relative = message.match(/(?:try again|retry|resets?) (?:in|after) ([^.\n]+)/i)?.[1]
  if (relative) {
    const amount = (unit: string) => Number(relative.match(new RegExp(`(\\d+)\\s*${unit}`, 'i'))?.[1] ?? 0)
    const ms = amount('h') * 60 * MINUTE + amount('m(?!s)') * MINUTE + amount('s') * 1000
    if (ms > 0) return now + ms
  }

  const retryAfter = message.match(/retry-after:?\s*(\d+)/i)?.[1]
  if (retryAfter) return now + Number(retryAfter) * 1000
  return undefined
}

/** The provider's own quota window, as the CLI reported it, when it is used up. */
function quotaReset(provider: string, now = Date.now()) {
  // A single model's limit (Fable) must not rest the whole provider until it resets.
  const full = limitingWindows(provider, now)
    .filter((row) => row.utilization >= 0.98)
    .map((row) => row.resets_at as number)
    .filter((at) => at && at > now)
  return full.length ? Math.min(...full) : undefined
}

export function classifyFailure(runId: number, provider: string, error: string): Failure {
  const text = `${error}\n${logTail(runId)}`
  const firstLine = error.split('\n')[0].slice(0, 200) || 'unknown error'

  if (ACCESS_RE.test(error)) return { kind: 'access', cause: firstLine }
  if (LIMIT_RE.test(error)) {
    const until = resetTime(error) ?? quotaReset(provider)
    return { kind: 'limit', cause: firstLine, until }
  }
  if (CONTEXT_RE.test(text)) return { kind: 'context', cause: firstLine }

  const missing = text.match(MISSING_MODULE_RE)?.[1] ?? text.match(MISSING_COMMAND_RE)?.[1]
  if (missing) return { kind: 'toolchain', cause: firstLine, missing }

  if (NETWORK_RE.test(error)) return { kind: 'network', cause: firstLine }
  return { kind: 'unknown', cause: firstLine }
}

// ---------- providers that rest ----------

type Rest = { until: number; reason: string }
const resting = new Map<string, Rest>()

/** How long a provider rests when the message gives no reset time. */
const DEFAULT_REST: Partial<Record<FailureKind, number>> = { limit: 10 * MINUTE, access: 30 * MINUTE }
/** Never longer than this, so a misread reset time cannot switch a provider off for days. */
const MAX_REST = 6 * 60 * MINUTE

export function restProvider(provider: string, failure: Failure) {
  const now = Date.now()
  const wanted = failure.until ?? now + (DEFAULT_REST[failure.kind] ?? 10 * MINUTE)
  const until = Math.min(Math.max(wanted, now + MINUTE), now + MAX_REST)
  resting.set(provider, { until, reason: failure.kind === 'limit' ? 'limit reached' : 'no access' })
  return until
}

export function restOf(provider: string): Rest | undefined {
  const rest = resting.get(provider)
  if (rest && rest.until <= Date.now()) resting.delete(provider)
  return resting.get(provider)
}

/** A fixed provider (new login, new key) may be asked again at once. */
export function wakeProvider(provider: string) {
  resting.delete(provider)
}

export const clock = (at: number) =>
  new Date(at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })

/** "02:30 PM" today, "Mon 02:16 AM" on another day: a bare time three days ahead reads like tonight. */
export function when(at: number) {
  const day = (time: number) => new Date(time).toLocaleDateString('en-US')
  if (day(at) === day(Date.now())) return clock(at)
  const weekday = new Date(at).toLocaleDateString('en-US', { weekday: 'short' })
  return `${weekday.replace('.', '')} ${clock(at)}`
}

// ---------- what the next run is told ----------

/** The hint lands as a comment the next agent reads with its prompt. Empty when there is nothing to say. */
export function hintFor(failure: Failure, providerLabel: string, until?: number): string {
  switch (failure.kind) {
    case 'limit':
      return `${providerLabel} has reached its limit (${failure.cause}). The provider pauses until ${clock(until!)}; meanwhile a fallback provider takes over, if one is set up. Does not count as a failed attempt.`
    case 'access':
      return `${providerLabel} is not reachable or not logged in (${failure.cause}). The provider pauses until ${clock(until!)}. Does not count as a failed attempt.`
    case 'network':
      return `Network error (${failure.cause}). Next attempt in one minute.`
    case 'toolchain':
      return `The last run failed because \`${failure.missing}\` is missing. Install it first (e.g. \`sudo apt-get install -y …\`, \`uv pip install …\` or \`npm install …\`), check that it works, and then carry on. Note the command in the handoff so the next agents know it.`
    case 'context':
      return 'The last run overflowed the context window. Read big files and logs only in parts (head, tail, grep) and work in smaller steps. If the issue is too big, split it into smaller issues with the board commands and close this one with `done`.'
    case 'unknown':
      return ''
  }
}

/** Retry delay for the issue after a failure of this kind. Undefined means: the usual backoff. */
export function retryDelay(failure: Failure): number | undefined {
  if (failure.kind === 'network') return MINUTE
  if (failure.kind === 'toolchain' || failure.kind === 'context') return 15_000
  return undefined
}
