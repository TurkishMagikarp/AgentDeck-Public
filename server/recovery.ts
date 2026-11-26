// Self-healing: a failed run is sorted into a kind of failure, and each kind gets its own way out.
// A rate limit is not the issue's fault, so it does not count as a failed attempt and the provider
// rests until its limit resets. A missing tool or an overfull context gets a hint for the next run.
import { all, get } from './db.ts'
import { currentLang, t, variants } from './i18n.ts'
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
  /not logged in|please run \/login|invalid (x-)?api[ _-]?key|authentication_error|failed to authenticate|oauth (?:token|session) (?:has )?expired|konnte nicht gestartet werden|could not be started/i
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
  const firstLine = error.split('\n')[0].slice(0, 200) || t('unbekannter Fehler')

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
// The kind is kept, not a text: the reason is read later, in the language of whoever asks.
const resting = new Map<string, { until: number; kind: FailureKind }>()

/** How long a provider rests when the message gives no reset time. */
const DEFAULT_REST: Partial<Record<FailureKind, number>> = { limit: 10 * MINUTE, access: 30 * MINUTE }
/** Never longer than this, so a misread reset time cannot switch a provider off for days. */
const MAX_REST = 6 * 60 * MINUTE

export function restProvider(provider: string, failure: Failure) {
  const now = Date.now()
  const wanted = failure.until ?? now + (DEFAULT_REST[failure.kind] ?? 10 * MINUTE)
  const until = Math.min(Math.max(wanted, now + MINUTE), now + MAX_REST)
  resting.set(provider, { until, kind: failure.kind })
  return until
}

export function restOf(provider: string): Rest | undefined {
  const rest = resting.get(provider)
  if (!rest) return undefined
  if (rest.until <= Date.now()) return void resting.delete(provider)
  return { until: rest.until, reason: rest.kind === 'limit' ? t('Limit erreicht') : t('Zugang fehlt') }
}

/** A fixed provider (new login, new key) may be asked again at once. */
export function wakeProvider(provider: string) {
  resting.delete(provider)
  onWake()
}

let onWake = () => {}
/** The scheduler sleeps between events; a provider that may work again is one. */
export function whenProviderWakes(fn: () => void) {
  onWake = fn
}

const locale = () => (currentLang() === 'en' ? 'en-US' : 'de-DE')

export const clock = (at: number) =>
  new Date(at).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })

/** "14:30" today, "Mo 02:16" ("Mon 02:16") on another day: a bare time three days ahead reads like tonight. */
export function when(at: number) {
  const day = (time: number) => new Date(time).toLocaleDateString('de-DE')
  if (day(at) === day(Date.now())) return clock(at)
  const weekday = new Date(at).toLocaleDateString(locale(), { weekday: 'short' })
  return `${weekday.replace('.', '')} ${clock(at)}`
}

// ---------- what the next run is told ----------

/** The hint lands as a comment the next agent reads with its prompt. Empty when there is nothing to say. */
export function hintFor(failure: Failure, providerLabel: string, until?: number): string {
  switch (failure.kind) {
    case 'limit':
      return t(
        '{provider} hat sein Limit erreicht ({cause}). Der Anbieter pausiert bis {until}, solange übernimmt ein Ersatzanbieter, falls einer eingerichtet ist. Zählt nicht als Fehlversuch.',
        { provider: providerLabel, cause: failure.cause, until: clock(until!) },
      )
    case 'access':
      return t(
        '{provider} ist nicht erreichbar oder nicht angemeldet ({cause}). Der Anbieter pausiert bis {until}. Zählt nicht als Fehlversuch.',
        { provider: providerLabel, cause: failure.cause, until: clock(until!) },
      )
    case 'network':
      return t('Netzwerkfehler ({cause}). Neuer Versuch in einer Minute.', { cause: failure.cause })
    case 'toolchain':
      return t(
        'Der letzte Lauf scheiterte, weil `{missing}` fehlt. Installiere es zuerst (z. B. `sudo apt-get install -y …`, `uv pip install …` oder `npm install …`), prüfe, dass es läuft, und arbeite dann weiter. Notiere den Befehl in der Übergabe, damit die nächsten Agenten ihn kennen.',
        { missing: failure.missing ?? '' },
      )
    case 'context':
      return t(
        'Der letzte Lauf hat das Kontextfenster gesprengt. Lies große Dateien und Logs nur ausschnittsweise (head, tail, grep) und arbeite in kleineren Schritten. Ist das Issue zu groß, teile es mit den Board-Befehlen in kleinere Issues auf und schließe dieses mit `done`.',
      )
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

// ---------- parked issues that rest ----------

/** Rest of a parked issue: 30 minutes the first time, doubled with every park, at most a day. */
const PARK_REST = 30 * MINUTE
const MAX_PARK_REST = 24 * 60 * MINUTE
/** Verdicts of a finished run that moved the issue on. "blocked", "partial" and "todo" did not. */
const PROGRESS_VERDICTS = ['review', 'done', 'approve', 'changes', 'handoff', 'precheck']

/**
 * Only the parks since the issue last moved on count. Without that an issue parked often for
 * a fault that is long fixed (a broken login, a checkout git refused) rests for hours the next
 * time it is parked for something else.
 */
export function parkedRest(issueId: number) {
  const marks = PROGRESS_VERDICTS.map(() => '?').join(',')
  const progress = get(
    `SELECT MAX(ended_at) AS at FROM runs WHERE issue_id=? AND status='done' AND verdict IN (${marks})`,
    issueId,
    ...PROGRESS_VERDICTS,
  )?.at
  const parks = parksSince(issueId, progress ?? 0)
  return Math.min(MAX_PARK_REST, PARK_REST * 2 ** Math.min(parks, 10))
}

/** Park notes of the issue after a point in time. They start the same way in either language. */
export function parksSince(issueId: number, since = 0) {
  const starts = variants('Geparkt:')
  return get(
    `SELECT COUNT(*) AS n FROM comments WHERE issue_id=? AND kind='watchdog' AND created_at>?
     AND (${starts.map(() => 'body LIKE ?').join(' OR ')})`,
    issueId,
    since,
    ...starts.map((start) => `${start}%`),
  )!.n as number
}
