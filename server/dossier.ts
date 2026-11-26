// The dossier of an issue and the live feed of a project: the two views behind "nothing an agent
// does stays unseen". Both are built from what is stored anyway (runs, run_events, comments,
// issue_events), so no new table is needed and older issues have a dossier too.
//
// The dossier answers one question before a merge: what did the agents do for this issue? It
// counts tools, lists the shell commands and the files that were written, and flags what needs a
// second look (errors, redacted secrets, failed runs). Every line carries a stable key, so the UI
// can remember which ones the reviewer has already looked at.
import { all, get } from './db.ts'
import { t, variants } from './i18n.ts'
import { traceOf } from './landingTrace.ts'

/** Tools that change files, by the names the CLIs use (Claude, Codex, API agents). */
const WRITE_TOOLS = /^(write|edit|multiedit|notebookedit|apply_patch|file_change|create_file|str_replace\w*)$/i
const SHELL_TOOLS = /^(bash|shell|command_execution|run_command|powershell)$/i
const NETWORK_TOOLS = /^(webfetch|websearch|web_search|web_fetch|fetch)$/i

export type ToolCount = { name: string; count: number }
export type RunDigest = {
  id: number
  agent: string
  provider: string
  model: string
  status: string
  failure: string
  startedAt: number
  endedAt: number | null
  costUsd: number
  tokens: number
  events: number
  tools: ToolCount[]
  commands: string[]
  files: string[]
  fetches: string[]
  errors: string[]
  redactions: number
  /** The run's own git summary (commits, files, lines): true even when files were written by a shell command. */
  changes: string
}
export type Step = { key: string; at: number; actor: string; kind: string; text: string }
export type Dossier = {
  issue: { id: number; number: number; title: string; status: string; landing: string }
  totals: { runs: number; costUsd: number; tokens: number; seconds: number; toolCalls: number; files: number; commands: number }
  flags: { level: 'bad' | 'warn'; text: string }[]
  runs: RunDigest[]
  steps: Step[]
}

const clip = (text: string, max = 160) => {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}

/** The path or command inside a tool call. Calls are JSON for most CLIs, plain text for some. */
export function target(name: string, payload: string): string {
  const text = payload.trim()
  if (text.startsWith('{')) {
    try {
      const input = JSON.parse(text)
      const found = input.file_path ?? input.path ?? input.notebook_path ?? input.command ?? input.cmd ?? input.url ?? input.query
      if (typeof found === 'string') return clip(found)
    } catch {
      // The payload may be cut at the cap; fall through to the regex.
    }
    const loose = text.match(/"(?:file_path|path|command|cmd|url)"\s*:\s*"((?:[^"\\]|\\.)*)/)
    if (loose) return clip(loose[1].replace(/\\n/g, ' ').replace(/\\"/g, '"'))
  }
  return clip(text.split('\n')[0] ?? '')
}

/** What one run did, from its recorded steps. */
export function digestRun(
  run: any,
  events: { kind: string; name: string; payload: string }[],
): RunDigest {
  const counts = new Map<string, number>()
  const commands: string[] = []
  const files = new Set<string>()
  const fetches: string[] = []
  const errors: string[] = []
  let changes = ''
  let redactions = 0
  // Stored steps keep the language they were recorded in.
  const redacted = variants('[GEHEIM: ')
  for (const e of events) {
    for (const mark of redacted) redactions += e.payload.split(mark).length - 1
    if (e.kind === 'error') errors.push(clip(e.payload, 200))
    if (e.kind === 'changes') changes = e.payload.slice(0, 2000)
    // Codex reports an edit once it is done, as a result and not as a call.
    if (e.kind === 'tool_result' && e.name === 'file_change') {
      try {
        for (const change of JSON.parse(e.payload).changes ?? []) if (change?.path) files.add(clip(String(change.path)))
      } catch {
        // A cut payload: the path is still readable.
        for (const m of e.payload.matchAll(/"path"\s*:\s*"((?:[^"\\]|\\.)*)"/g)) files.add(clip(m[1]))
      }
    }
    if (e.kind !== 'tool_call') continue
    counts.set(e.name, (counts.get(e.name) ?? 0) + 1)
    if (SHELL_TOOLS.test(e.name)) commands.push(target(e.name, e.payload))
    else if (WRITE_TOOLS.test(e.name)) files.add(target(e.name, e.payload))
    else if (NETWORK_TOOLS.test(e.name)) fetches.push(target(e.name, e.payload))
  }
  return {
    id: run.id,
    agent: run.agent_name,
    provider: run.provider,
    model: run.model,
    status: run.status,
    failure: run.failure ?? '',
    startedAt: run.started_at,
    endedAt: run.ended_at,
    costUsd: run.cost_usd,
    tokens: (run.input_tokens ?? 0) + (run.output_tokens ?? 0),
    events: events.length,
    tools: [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
    commands,
    files: [...files],
    fetches,
    errors: errors.slice(0, 20),
    redactions,
    changes,
  }
}

export function buildDossier(issueId: number): Dossier | null {
  const issue = get('SELECT id, number, title, status, landing FROM issues WHERE id=?', issueId)
  if (!issue) return null
  const runs = all('SELECT * FROM runs WHERE issue_id=? ORDER BY id', issueId)
  const digests = runs.map((run) =>
    digestRun(
      run,
      all('SELECT kind, name, payload FROM run_events WHERE run_id=? ORDER BY seq', run.id),
    ),
  )

  const steps: Step[] = []
  for (const run of runs)
    steps.push({
      key: `run:${run.id}`,
      at: run.started_at,
      actor: run.agent_name,
      kind: 'run',
      text:
        t('Lauf #{id} ({model}): {status}', { id: run.id, model: run.model || run.provider, status: run.status }) +
        (run.failure ? `, ${run.failure}` : ''),
    })
  for (const c of all('SELECT id, author, kind, body, created_at FROM comments WHERE issue_id=? ORDER BY id', issueId))
    steps.push({ key: `comment:${c.id}`, at: c.created_at, actor: c.author, kind: c.kind, text: clip(c.body, 260) })
  for (const e of all('SELECT id, at, actor, field, old, new FROM issue_events WHERE issue_id=? ORDER BY id', issueId))
    steps.push({
      key: `event:${e.id}`,
      at: e.at,
      actor: e.actor,
      kind: 'field',
      text: `${e.field}: ${clip(String(e.old ?? '–'), 60)} → ${clip(String(e.new ?? '–'), 60)}`,
    })
  for (const line of traceOf(issueId))
    steps.push({
      key: `landing:${line.id}`,
      at: line.at,
      actor: t('Landung'),
      kind: `landing-${line.level}`,
      text: `${line.step}: ${line.text}`,
    })
  steps.sort((a, b) => a.at - b.at)

  const sum = (pick: (d: RunDigest) => number) => digests.reduce((n, d) => n + pick(d), 0)
  const files = new Set(digests.flatMap((d) => d.files))
  const flags: Dossier['flags'] = []
  const failed = digests.filter((d) => d.failure || d.status === 'failed')
  if (failed.length) flags.push({ level: 'warn', text: t('{n} Lauf/Läufe fehlgeschlagen', { n: failed.length }) })
  const redactions = sum((d) => d.redactions)
  if (redactions)
    flags.push({ level: 'bad', text: t('{n} Geheimnis(se) in der Aufzeichnung geschwärzt', { n: redactions }) })
  const fetches = digests.flatMap((d) => d.fetches)
  if (fetches.length) flags.push({ level: 'warn', text: t('{n} Abruf(e) ins Netz', { n: fetches.length }) })
  const errors = sum((d) => d.errors.length)
  if (errors) flags.push({ level: 'warn', text: t('{n} Fehlerschritt(e) im Verlauf', { n: errors }) })
  const cutMarks = variants('Aufzeichnung gekürzt')
  const cut = digests.filter((d) => d.errors.some((e) => cutMarks.some((mark) => e.startsWith(mark)))).length
  if (cut)
    flags.push({
      level: 'bad',
      text: t('{n} Lauf/Läufe nur teilweise aufgezeichnet (Größenlimit), weitere Schritte fehlen', { n: cut }),
    })
  const unrecorded = digests.filter((d) => d.events === 0 && d.status !== 'running').length
  if (unrecorded) flags.push({ level: 'warn', text: t('{n} Lauf/Läufe ohne Aufzeichnung', { n: unrecorded }) })

  return {
    issue,
    totals: {
      runs: runs.length,
      costUsd: sum((d) => d.costUsd),
      tokens: sum((d) => d.tokens),
      seconds: Math.round(sum((d) => ((d.endedAt ?? d.startedAt) - d.startedAt) / 1000)),
      toolCalls: sum((d) => d.tools.reduce((n, tool) => n + tool.count, 0)),
      files: files.size,
      commands: sum((d) => d.commands.length),
    },
    flags,
    runs: digests,
    steps,
  }
}

export type FeedItem = {
  runId: number
  seq: number
  at: number
  kind: string
  name: string
  text: string
  agent: string
  issue: number
  title: string
}

/**
 * The newest steps of all runs of a project plus what the server itself did (checks, landings,
 * approvals, watchdog, reviews), newest first. `since` is a timestamp to resume from.
 */
export function projectFeed(projectId: number, since = 0, limit = 150): FeedItem[] {
  const size = Math.max(1, Math.min(300, Math.floor(limit) || 150))
  const steps: FeedItem[] = all(
    `SELECT e.run_id AS runId, e.seq, e.at, e.kind, e.name, substr(e.payload, 1, 600) AS text,
            r.agent_name AS agent, i.number AS issue, i.title
       FROM run_events e
       JOIN runs r ON r.id = e.run_id
       JOIN issues i ON i.id = r.issue_id
      WHERE r.project_id=? AND e.at > ? AND e.kind != 'prompt'
      ORDER BY e.at DESC, e.seq DESC LIMIT ?`,
    projectId,
    since,
    size,
  )
  // Server-side actions have no run. runId 0 and the comment id as seq keep the item id unique.
  const server: FeedItem[] = all(
    `SELECT 0 AS runId, c.id AS seq, c.created_at AS at, 'server' AS kind, c.kind AS name,
            substr(c.body, 1, 600) AS text, c.author AS agent, i.number AS issue, i.title
       FROM comments c JOIN issues i ON i.id = c.issue_id
      WHERE i.project_id=? AND c.created_at > ? AND (c.author IN ('System','Vorcheck','Watchdog') OR c.kind='review')
      ORDER BY c.created_at DESC LIMIT ?`,
    projectId,
    since,
    size,
  )
  const landing: FeedItem[] = all(
    `SELECT 0 AS runId, t.id AS seq, t.at, 'landing' AS kind, t.step || ' ' || t.level AS name,
            t.text, ? AS agent, i.number AS issue, i.title
       FROM landing_trace t JOIN issues i ON i.id = t.issue_id
      WHERE i.project_id=? AND t.at > ? ORDER BY t.at DESC LIMIT ?`,
    t('Landung'),
    projectId,
    since,
    size,
  )
  return [...steps, ...server, ...landing].sort((a, b) => b.at - a.at).slice(0, size)
}
