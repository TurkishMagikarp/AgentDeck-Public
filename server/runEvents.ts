// The replay of a run: what the agent was asked, which tools it called with what, what came back,
// what it said, and what the run changed in the end. The adapters already parse every line the
// CLIs print; they hand the parsed steps here as TraceEvents. Events are buffered and written in
// one transaction a second, so a chatty agent costs one write per batch, not one per line.
// Everything is redacted with the secret scanner before it is stored: tool output often holds
// env dumps, config files or tokens, and the timeline is shown in the UI.
import { createHash } from 'node:crypto'
import { all, db, get, run } from './db.ts'
import { currentLang, t, withLang } from './i18n.ts'
import { gitIn } from './sandbox.ts'
import { secretIn } from './secretScan.ts'

export const RUN_EVENT_KINDS = ['prompt', 'assistant', 'tool_call', 'tool_result', 'error', 'changes', 'end'] as const
export type RunEventKind = (typeof RUN_EVENT_KINDS)[number]

/** One parsed step of a run, as an adapter sees it. name: the tool, for calls and results. */
export type TraceEvent = { kind: RunEventKind; name?: string; text: string }

export type StoredEvent = { seq: number; at: number; kind: RunEventKind; name: string; payload: string; size: number }

/** Per event. Tool results of a build can be megabytes; the start says what happened. */
export const EVENT_CAP = 8 * 1024
/** The prompt is the one event worth more room: it is what the run is about. */
export const PROMPT_CAP = 32 * 1024
/** Per run. A run that loops for hours stops being recorded, apart from its end. */
export const RUN_CAP = 2 * 1024 * 1024
/** Redaction looks a bit past the cut, so a secret across the cut is still found as a whole. */
const LOOKAHEAD = 1024
const FLUSH_MS = 1000
const FLUSH_EVENTS = 64
/** secretIn skips longer lines; those are checked in overlapping windows. */
const SCAN_LINE = 10_000
const WINDOW = 8_000
const WINDOW_STEP = 6_000

// The scanner only names the header of a private key; the key itself follows on the next lines.
const PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----|$)/g
const MAX_HITS_PER_LINE = 50

const marker = (rule: string) => t('[GEHEIM: {rule}]', { rule })

/** Values in one line the scanner calls secrets. Long lines in overlapping windows. */
function secretsInLine(line: string): { rule: string; value: string }[] {
  const found: { rule: string; value: string }[] = []
  const windows =
    line.length <= SCAN_LINE
      ? [line]
      : Array.from({ length: Math.ceil((line.length - WINDOW) / WINDOW_STEP) + 1 }, (_, i) =>
          line.slice(i * WINDOW_STEP, i * WINDOW_STEP + WINDOW),
        )
  for (let part of windows) {
    // secretIn names the first secret of a line; it is masked and the line searched again.
    for (let i = 0; i < MAX_HITS_PER_LINE; i++) {
      const hit = secretIn(part)
      if (!hit || !hit.value) break
      found.push({ rule: hit.rule.id, value: hit.value })
      part = part.split(hit.value).join(marker(hit.rule.id))
    }
  }
  return found
}

/**
 * Text without secrets: what the scanner finds, private keys with their body, and the literal
 * values in `known` (the run's own tokens, which the scanner cannot recognise by their shape).
 */
export function redact(text: string, known: string[] = []): string {
  let out = text
  for (const value of known) if (value && out.includes(value)) out = out.split(value).join(marker(t('Token des Laufs')))
  out = out.replace(PRIVATE_KEY, marker('private-key'))
  const lines = out.split('\n')
  let changed = false
  for (let i = 0; i < lines.length; i++) {
    const hits = secretsInLine(lines[i])
    if (!hits.length) continue
    changed = true
    // Longest first, so a value that contains another is replaced whole.
    for (const hit of hits.sort((a, b) => b.value.length - a.value.length))
      lines[i] = lines[i].split(hit.value).join(marker(hit.rule))
  }
  return changed ? lines.join('\n') : out
}

/** Redacted and cut to `cap` characters. size: the length the agent produced. */
export function clean(text: string, cap: number, known: string[] = []) {
  const size = text.length
  const redacted = redact(text.length > cap + LOOKAHEAD ? text.slice(0, cap + LOOKAHEAD) : text, known)
  return { payload: redacted.length > cap ? redacted.slice(0, cap) : redacted, size }
}

/** Values in a run's env that must never show up in its timeline, whatever their shape. */
export function knownSecrets(env: Record<string, string | undefined>) {
  return Object.entries(env)
    .filter(([name, value]) => /(?:^|_)(?:TOKEN|SECRET|PASSWORD|API_?KEY)$/i.test(name) && value && value.length >= 8)
    .map(([, value]) => value!)
}

export const promptHash = (prompt: string) => createHash('sha256').update(prompt).digest('hex').slice(0, 16)

type Row = StoredEvent & { runId: number }

export type Recorder = {
  add(event: TraceEvent): void
  /** Writes what is buffered now. */
  flush(): void
  /** Last flush; later events are dropped. */
  close(): void
  readonly bytes: number
}

const recorders = new Map<number, Recorder & { pending(): StoredEvent[] }>()

function insertAll(rows: Row[]) {
  if (!rows.length) return
  const write = () => {
    for (const r of rows)
      run(
        'INSERT OR IGNORE INTO run_events (run_id, seq, at, kind, name, payload, size) VALUES (?,?,?,?,?,?,?)',
        r.runId,
        r.seq,
        r.at,
        r.kind,
        r.name,
        r.payload,
        r.size,
      )
  }
  // A transaction for the batch: one commit instead of one per row. Inside someone else's
  // transaction the rows simply join it.
  if ((db as any).isTransaction) return write()
  db.exec('BEGIN IMMEDIATE')
  try {
    write()
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

/**
 * Starts the recording of a run. `known`: literal secrets of this run (see knownSecrets).
 * Events beyond the run's cap are dropped, except the end of the run (changes, end): those
 * say how it ended and are capped one by one.
 */
export function recordRun(runId: number, known: string[] = []): Recorder {
  let seq = (get<{ seq: number }>('SELECT MAX(seq) AS seq FROM run_events WHERE run_id=?', runId)?.seq ?? 0)
  let bytes = 0
  let buffer: Row[] = []
  let timer: NodeJS.Timeout | undefined
  let closed = false
  let overCap = false
  // Events arrive from the CLI's callbacks; what is written about them keeps the run's language.
  const lang = currentLang()

  const flush = () => {
    if (timer) clearTimeout(timer)
    timer = undefined
    const rows = buffer
    buffer = []
    try {
      insertAll(rows)
    } catch (err: any) {
      // The run goes on without its replay; it must never fail because of it.
      console.error('run events', runId, err.message)
    }
  }

  const push = (kind: RunEventKind, name: string, payload: string, size: number) => {
    buffer.push({ runId, seq: ++seq, at: Date.now(), kind, name, payload, size })
    bytes += payload.length + name.length
    if (buffer.length >= FLUSH_EVENTS) flush()
    else if (!timer) timer = setTimeout(flush, FLUSH_MS).unref()
  }

  const record = (event: TraceEvent) => {
    if (closed || !RUN_EVENT_KINDS.includes(event.kind)) return
    const final = event.kind === 'changes' || event.kind === 'end'
    if (overCap && !final) return
    const cap = event.kind === 'prompt' ? PROMPT_CAP : EVENT_CAP
    const { payload, size } = clean(String(event.text ?? ''), cap, known)
    const name = redact(String(event.name ?? '').slice(0, 200), known)
    if (!final && bytes + payload.length + name.length > RUN_CAP) {
      overCap = true
      const cut = t('Aufzeichnung gekürzt: Der Lauf hat mehr als {mb} MB erzeugt, weitere Schritte fehlen.', {
        mb: RUN_CAP / 1024 / 1024,
      })
      push('error', '', cut, 0)
      return
    }
    push(event.kind, name, payload, size)
  }

  const recorder = {
    add: (event: TraceEvent) => withLang(lang, () => record(event)),
    flush,
    close() {
      if (closed) return
      closed = true
      flush()
      recorders.delete(runId)
    },
    pending: () => buffer.map(({ runId: _, ...row }) => row),
    get bytes() {
      return bytes
    },
  }
  recorders.set(runId, recorder)
  return recorder
}

/** HEAD of a checkout, '' when there is none. */
export const headOf = (cwd: string) =>
  gitIn(cwd, ['rev-parse', '--verify', 'HEAD']).then(
    (r) => r.stdout.trim(),
    () => '',
  )

// The checkout is the agent's: no fsmonitor, external diff or text conversion it may have set.
const SAFE_GIT = ['-c', 'core.fsmonitor=false', '-c', 'core.quotePath=false']

/**
 * What a run changed in its checkout since `base` (HEAD when it started): its commits, the
 * files against the start including uncommitted work, and new untracked files. As text for the
 * timeline; the full diff is in the changes tab of the issue.
 */
export async function runChanges(cwd: string, base: string): Promise<string> {
  if (!/^[0-9a-f]{7,64}$/.test(base)) return ''
  const options = { maxBuffer: 1024 * 1024 }
  const [head, log, stat, status] = await Promise.all([
    headOf(cwd),
    gitIn(cwd, [...SAFE_GIT, 'log', '--no-color', '--format=%h %s', '-n', '50', `${base}..HEAD`], options),
    gitIn(cwd, [...SAFE_GIT, 'diff', '--no-color', '--no-ext-diff', '--no-textconv', '--stat=200', base], options),
    gitIn(cwd, [...SAFE_GIT, 'status', '--porcelain', '--untracked-files=normal'], options),
  ])
  const commits = log.stdout.trim()
  const files = stat.stdout.trimEnd()
  const untracked = status.stdout
    .split('\n')
    .filter((line) => line.startsWith('?? '))
    .map((line) => ` ${line.slice(3)}`)
    .slice(0, 50)
    .join('\n')
  if (!commits && !files && !untracked) return t('Keine Änderungen (HEAD {head}).', { head: head.slice(0, 10) })
  return [
    `HEAD ${base.slice(0, 10)} → ${head.slice(0, 10)}`,
    commits && `Commits:\n${commits}`,
    files && `${t('Dateien seit Laufbeginn (inkl. nicht committeter Änderungen):')}\n${files}`,
    untracked && `${t('Neue, nicht versionierte Dateien:')}\n${untracked}`,
  ]
    .filter(Boolean)
    .join('\n\n')
}

/** The timeline of a run, oldest first; for a live run including what is still buffered. */
export function runEvents(runId: number, kind?: RunEventKind): StoredEvent[] {
  const stored = kind
    ? all<StoredEvent>(
        'SELECT seq, at, kind, name, payload, size FROM run_events WHERE run_id=? AND kind=? ORDER BY seq',
        runId,
        kind,
      )
    : all<StoredEvent>('SELECT seq, at, kind, name, payload, size FROM run_events WHERE run_id=? ORDER BY seq', runId)
  const pending = recorders.get(runId)?.pending() ?? []
  return [...stored, ...pending.filter((e) => !kind || e.kind === kind)]
}

/**
 * Removes the timelines of runs started before `cutoff`. Run ids grow with time, so this is a
 * range on the primary key, not a scan of the table.
 */
export function pruneRunEvents(cutoff: number) {
  const first = get<{ id: number | null }>(
    'SELECT COALESCE((SELECT MIN(id) FROM runs WHERE started_at >= ?), (SELECT COALESCE(MAX(id), 0) + 1 FROM runs)) AS id',
    cutoff,
  )?.id
  if (!first) return 0
  return Number(run('DELETE FROM run_events WHERE run_id < ?', first).changes)
}
