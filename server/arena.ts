// Arena: several agents work on the same issue at once, each on a branch of its own, and a jury
// picks the best result. Only the winner goes on to review and landing; the others are closed.
//
// Each contestant is an issue of its own ("entry") that names the original in `arena_of`, so it
// gets its own branch, runs, cost and log like any other issue. The original waits in the backlog,
// blocked by its entries. An entry that finishes is held (`landing = 'arena'`) instead of being
// reviewed or landed. Once no entry is still at work, the jury compares what was handed in without
// knowing which agent wrote what, and names a winner. The engine (engine.ts) calls in here; this
// file holds the bookkeeping and the jury's question, not the scheduling.
import { addComment, createIssue, getIssue, getProject, mapIssue, patchIssue } from './core.ts'
import { all, get, tx } from './db.ts'
import type { FileChange } from './diff.ts'
import { currentLang, langOf, t, tIn, withLang } from './i18n.ts'
import { prompts } from './prompts/index.ts'

export const MIN_ENTRIES = 2
export const MAX_ENTRIES = 4
/** How much of each entry's diff the jury reads. */
const DIFF_CHARS = 24_000
const LABELS = ['A', 'B', 'C', 'D']

/** Comments on an issue are written in its project's language, whoever triggers them. */
const langOfIssue = (issue: { project_id: number }) => langOf(getProject(issue.project_id))

export type EntryState = 'working' | 'handed-in' | 'out' | 'winner' | 'lost'

export type ArenaEntry = {
  id: number
  number: number
  agent: string
  agentId: number | null
  status: string
  state: EntryState
  costUsd: number
  minutes: number
}

export type ArenaView = {
  parent: { id: number; number: number; title: string; status: string }
  entries: ArenaEntry[]
  winnerId: number
  /** 'waiting': entries still at work. 'judge': ready for the jury. 'empty': nobody handed in. 'closed': decided. */
  phase: 'waiting' | 'judge' | 'empty' | 'closed'
}

const entriesOf = (parentId: number) =>
  all('SELECT * FROM issues WHERE arena_of=? ORDER BY number', parentId).map(mapIssue)

function stateOf(entry: any, winnerId: number): EntryState {
  if (winnerId) return entry.id === winnerId ? 'winner' : 'lost'
  if (entry.landing === 'arena') return 'handed-in'
  if (entry.status === 'todo' || entry.status === 'in_progress') return 'working'
  return 'out'
}

/** The arena an issue belongs to, as original or as entry. Undefined when it has none. */
export function arenaOf(issue: { id: number; arena_of?: number }): ArenaView | undefined {
  const parent = getIssue(issue.arena_of || issue.id)
  if (!parent) return undefined
  const rows = entriesOf(parent.id)
  if (!rows.length) return undefined

  const spent = new Map<number, { cost: number; ms: number }>()
  for (const row of all(
    `SELECT issue_id, SUM(cost_usd) AS cost, SUM(COALESCE(ended_at, started_at) - started_at) AS ms
     FROM runs WHERE issue_id IN (${rows.map(() => '?').join(',')}) GROUP BY issue_id`,
    ...rows.map((entry) => entry.id),
  ))
    spent.set(row.issue_id, { cost: row.cost ?? 0, ms: row.ms ?? 0 })

  const entries = rows.map((entry) => {
    const agentId = entry.maker_id ?? entry.assignee_id
    return {
      id: entry.id,
      number: entry.number,
      agent: get('SELECT name FROM agents WHERE id=?', agentId)?.name ?? t('entfernt'),
      agentId,
      status: entry.status,
      state: stateOf(entry, parent.arena_winner),
      costUsd: Math.round((spent.get(entry.id)?.cost ?? 0) * 100) / 100,
      minutes: Math.round((spent.get(entry.id)?.ms ?? 0) / 60_000),
    }
  })

  let phase: ArenaView['phase'] = 'closed'
  if (!parent.arena_winner) {
    if (entries.some((entry) => entry.state === 'working')) phase = 'waiting'
    else phase = entries.some((entry) => entry.state === 'handed-in') ? 'judge' : 'empty'
  }
  return {
    parent: { id: parent.id, number: parent.number, title: parent.title, status: parent.status },
    entries,
    winnerId: parent.arena_winner,
    phase,
  }
}

/** Originals whose arena is not decided yet, or whose winner has not landed yet. */
export const openArenas = (projectId: number): number[] =>
  all(
    `SELECT DISTINCT parent.id FROM issues parent JOIN issues entry ON entry.arena_of = parent.id
     WHERE parent.project_id=? AND parent.status != 'done'`,
    projectId,
  ).map((row) => row.id)

/**
 * Opens an arena on an issue: one entry per agent, started at once. The original goes to the
 * backlog and waits for its entries. Throws with a message for the owner when it cannot start.
 */
export function startArena(issueId: number, agentIds: unknown, actor = 'Owner') {
  const parent = getIssue(issueId)
  if (!parent) throw new Error(t('Issue nicht gefunden'))
  if (parent.arena_of) throw new Error(t('Ein Arena-Beitrag kann keine eigene Arena bekommen.'))
  if (entriesOf(parent.id).length) throw new Error(t('Für dieses Issue läuft schon eine Arena.'))
  if (!['backlog', 'todo'].includes(parent.status))
    throw new Error(t('Eine Arena startet nur aus Backlog oder To Do, bevor jemand am Issue arbeitet.'))

  const wanted = [...new Set((Array.isArray(agentIds) ? agentIds : []).map(Number))]
  const agents = wanted
    .map((id) =>
      get('SELECT id, name, enabled FROM agents WHERE id=? AND project_id=?', id, parent.project_id),
    )
    .filter((agent) => agent?.enabled)
  if (agents.length !== wanted.length)
    throw new Error(t('Unbekannter oder abgeschalteter Agent in der Auswahl.'))
  if (agents.length < MIN_ENTRIES || agents.length > MAX_ENTRIES)
    throw new Error(
      t('Eine Arena braucht {min} bis {max} verschiedene Agenten.', { min: MIN_ENTRIES, max: MAX_ENTRIES }),
    )

  return tx(() => {
    const entries = agents.map((agent) => {
      const entry = createIssue(parent.project_id, {
        title: `${parent.title} (Arena: ${agent.name})`.slice(0, 300),
        description: parent.description,
        status: 'todo',
        priority: parent.priority,
        assignee_id: agent.id,
        // Entries wait for what the original waits for, and the winner goes through its reviewers.
        blocked_by: parent.blocked_by,
        reviewers: parent.reviewers,
        grp: parent.grp,
        model: parent.model,
        checklist: parent.checklist,
        created_by: 'Arena',
        arena_of: parent.id,
      })
      return { ...entry, agent: agent.name }
    })
    patchIssue(
      parent.id,
      {
        status: 'backlog',
        blocked_by: [...new Set([...parent.blocked_by, ...entries.map((entry) => entry.number)])],
      },
      actor,
    )
    addComment(
      parent.id,
      'Arena',
      'system',
      tIn(
        langOfIssue(parent),
        'Arena gestartet: {entries} arbeiten parallel an dieser Aufgabe. Die Jury wählt den besten Beitrag, nur der geht in Prüfung und Landung.',
        { entries: entries.map((entry) => `${entry.agent} (#${entry.number})`).join(', ') },
      ),
    )
    return entries
  })
}

/** Holds a finished entry for the jury instead of sending it on. */
export function holdEntry(entryId: number, patch: Record<string, unknown>) {
  patchIssue(entryId, { ...patch, status: 'review', review_index: -1, landing: 'arena' })
  const held = getIssue(entryId)
  if (!held) return
  const lang = langOfIssue(held)
  addComment(
    entryId,
    'Arena',
    'system',
    tIn(lang, 'Beitrag abgegeben. Er wartet auf die Entscheidung der Jury.'),
  )
}

export type JuryEntry = {
  label: string
  entryId: number
  summary: string
  files: FileChange[]
  costUsd: number
}

/** Pairs the handed-in entries with neutral labels: the jury must not know who wrote what. */
export function labelled<T extends { id: number }>(entries: T[]) {
  return entries.slice(0, LABELS.length).map((entry, index) => ({ label: LABELS[index], entry }))
}

function diffText(files: FileChange[]) {
  if (!files.length) return prompts().noChanges
  const stat = files.map((file) => `${file.path} (+${file.added} −${file.removed})`).join('\n')
  let patches = ''
  for (const file of files) {
    if (file.binary || !file.patch) continue
    if (patches.length + file.patch.length > DIFF_CHARS) {
      patches += `\n${prompts().changesCut}`
      break
    }
    patches += `\n${file.patch}`
  }
  return `${stat}\n${patches}`
}

/** The jury is asked in the language of the issue's project, and gives its reason in it. */
export function juryPrompt(
  parent: { title: string; description: string; checklist?: string[]; project_id?: number },
  entries: JuryEntry[],
) {
  const lang = parent.project_id ? langOf(getProject(parent.project_id)) : currentLang()
  return withLang(lang, () => {
    const text = prompts()
    const labels = entries.map((entry) => entry.label).join(', ')
    return [
      text.juryIntro,
      text.juryCriteria,
      `${text.juryTask}\n${parent.title}\n\n${parent.description}`,
      parent.checklist?.length
        ? `${text.juryChecklist}\n${parent.checklist.map((item) => `- ${item}`).join('\n')}`
        : '',
      ...entries.map((entry) => text.juryEntry(entry.label, entry.summary, diffText(entry.files))),
      text.juryReply(labels),
    ]
      .filter(Boolean)
      .join('\n\n')
  })
}

/** The jury's choice, or undefined when the answer names no entry that took part. */
export function parseVerdict(text: string, labels: string[]) {
  const named = text.match(/<winner>\s*(?:(?:entry|beitrag)\s*)?([A-D])\s*<\/winner>/i)?.[1]?.toUpperCase()
  if (!named || !labels.includes(named)) return undefined
  const reason = text.match(/<reason>([\s\S]*?)<\/reason>/i)?.[1]?.trim() ?? ''
  return { label: named, reason: reason.slice(0, 2000) }
}

/**
 * Writes the decision down: the winner is named on the original, which now waits only for it; the
 * other entries are closed. Returns the winner as it was held. The engine sends it on.
 */
export function closeArena(parentId: number, winnerId: number, reason: string, by: string) {
  return tx(() => {
    const parent = getIssue(parentId)
    const entries = entriesOf(parentId)
    const winner = entries.find((entry) => entry.id === winnerId)
    if (!parent || !winner) throw new Error(t('Beitrag gehört nicht zu dieser Arena.'))
    if (parent.arena_winner) throw new Error(t('Die Arena ist schon entschieden.'))
    if (winner.landing !== 'arena') throw new Error(t('Dieser Beitrag wurde nicht abgegeben.'))

    const others = entries.filter((entry) => entry.id !== winnerId)
    const numbers = new Set(entries.map((entry) => entry.number))
    patchIssue(parentId, {
      arena_winner: winnerId,
      // Back from wherever a waiting original was moved to: it now waits for the winner only.
      status: 'backlog',
      blocked_by: [...parent.blocked_by.filter((number: number) => !numbers.has(number)), winner.number],
    })
    const lang = langOfIssue(parent)
    const why = reason ? ' ' + tIn(lang, 'Begründung: {reason}', { reason }) : ''
    addComment(
      parentId,
      'Arena',
      'system',
      tIn(lang, '{by} hat entschieden: Beitrag #{number} gewinnt.', { by, number: winner.number }) + why,
    )
    addComment(
      winner.id,
      'Arena',
      'system',
      tIn(lang, 'Dieser Beitrag hat die Arena gewonnen ({by}).', { by }) + why,
    )
    for (const entry of others) {
      patchIssue(entry.id, { status: 'done', landing: '', review_index: -1 })
      addComment(
        entry.id,
        'Arena',
        'system',
        tIn(
          lang,
          'Die Arena ging an Beitrag #{number}. Dieser Beitrag wird nicht gelandet; sein Branch bleibt vorerst zum Vergleich.',
          { number: winner.number },
        ),
      )
    }
    return { winner, losers: others.map((entry) => entry.id) }
  })
}

/** Nobody handed in: the original stops waiting for its entries and goes its normal way again. */
export function dissolveArena(parentId: number) {
  const parent = getIssue(parentId)
  if (!parent) return
  const lang = langOfIssue(parent)
  const numbers = new Set(entriesOf(parentId).map((entry) => entry.number))
  for (const entry of entriesOf(parentId)) {
    if (entry.status === 'done') continue
    patchIssue(entry.id, { status: 'done', landing: '', review_index: -1 })
    addComment(
      entry.id,
      'Arena',
      'system',
      tIn(lang, 'Die Arena wurde ohne Ergebnis beendet; dieser Beitrag ist geschlossen.'),
    )
  }
  // -1 marks an arena that ended without a winner, so it is not opened or judged again.
  patchIssue(parentId, {
    arena_winner: -1,
    blocked_by: parent.blocked_by.filter((number: number) => !numbers.has(number)),
  })
  addComment(
    parentId,
    'Arena',
    'system',
    tIn(
      lang,
      'Arena ohne Ergebnis: Kein Beitrag wurde abgegeben. Das Issue geht wieder seinen normalen Weg.',
    ),
  )
}
