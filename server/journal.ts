// The project journal: what happened, in one line each, newest first. Built from what is stored
// anyway (the server's own comments, review verdicts, failed runs), so nothing new is recorded and
// older history shows up too. The rules that turn a comment into a line are pure functions.
import { all } from './db.ts'
import { t, variants } from './i18n.ts'

export type JournalKind =
  | 'landed' // in the base branch
  | 'landingRed' // the check failed at landing, back to the maker
  | 'precheckRed' // the server check failed before the review
  | 'approved' // the last reviewer approved
  | 'changes' // a reviewer asked for changes
  | 'partial' // handed in with checklist items open
  | 'waits' // waits for another issue
  | 'escalated' // handed to the deputy or a human
  | 'watchdog' // the watchdog stepped in
  | 'runFailed' // a run ended with an error

export type JournalEntry = { at: number; issue: number; title: string; kind: JournalKind; text: string }

type Comment = { author: string; kind: string; body: string }

/** The first sentence of a text, without code blocks, short enough for one line. */
export function firstSentence(text: string, max = 140) {
  const plain = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const sentence = plain.match(/^.+?[.!?](?=\s|$)/)?.[0] ?? plain
  return sentence.length > max ? `${sentence.slice(0, max - 1)}…` : sentence
}

/** The first failing test in a check's output, e.g. "test_maps.gd test_exits…: …". */
function firstFailure(text: string) {
  const line = text.split('\n').find((l) => l.startsWith('FAIL '))
  return line ? firstSentence(line.replace(/^FAIL\s+/, ''), 110) : ''
}

const starts = (body: string, text: string) => variants(text).some((form) => body.startsWith(form))
const has = (body: string, text: string) => variants(text).some((form) => body.includes(form))

/**
 * Finds a server comment written from `text`, in the language the project had back then.
 * Each {placeholder} becomes a named group that takes `value`.
 */
function written(body: string, text: string, value: string, anchor = '') {
  for (const form of variants(text)) {
    const pattern = form.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\{(\w+)\}/g, `(?<$1>${value})`)
    const match = body.match(new RegExp(anchor + pattern))
    if (match) return match.groups ?? {}
  }
  return null
}

/** One journal line for a comment, or null when the comment is not worth one. */
export function journalLine(comment: Comment): { kind: JournalKind; text: string } | null {
  const { author, body } = comment
  if (comment.kind === 'review') {
    if (/^\s*(ändern|changes?)\s*:/i.test(body)) {
      const reason = firstSentence(body.replace(/^\s*\S+\s*:\s*/, ''))
      return { kind: 'changes', text: t('{author} verlangt Änderungen: {reason}', { author, reason }) }
    }
    return null
  }
  if (author === 'Watchdog') return { kind: 'watchdog', text: firstSentence(body) }
  if (author === 'Vorcheck') {
    if (starts(body, 'Vorcheck bestanden')) return null
    const failure = firstFailure(body) || firstSentence(body)
    return { kind: 'precheckRed', text: t('Vorcheck rot: {failure}', { failure }) }
  }
  if (author !== 'System') return null

  const landed = body.match(/^In (\S+) gelandet \((\w+)/) ?? body.match(/^Landed in (\S+) \((\w+)/)
  if (landed) return { kind: 'landed', text: t('Gelandet in {base} ({commit})', { base: landed[1], commit: landed[2] }) }
  if (/auf dem gemergten Stand (fehlgeschlagen|nach)|on the merged state/.test(body) && !has(body, 'zur Entscheidung')) {
    const failure = firstFailure(body)
    return {
      kind: 'landingRed',
      text: failure ? t('Landung rot: {failure}', { failure }) : t('Landung rot, zurück an den Maker'),
    }
  }
  if (has(body, 'zur Entscheidung') || has(body, 'Wartet auf Mensch') || has(body, 'Geparkt'))
    return { kind: 'escalated', text: firstSentence(body.replace(/\n[\s\S]*$/, '')) }
  const waits = written(body, 'Wartet jetzt auf {issues} und geht', '[^.]+?')
  if (waits) return { kind: 'waits', text: t('Wartet auf {issues}', waits) }
  if (starts(body, 'Teilabgabe')) return { kind: 'partial', text: firstSentence(body) }
  const approved = written(body, '{name} hat freigegeben.', '\\S+', '^')
  if (approved) return { kind: 'approved', text: t('Freigegeben von {name}', approved) }
  return null
}

/** The journal of a project, newest first, before a point in time (for paging). */
export function journal(projectId: number, before = Number.MAX_SAFE_INTEGER, limit = 200): JournalEntry[] {
  const comments = all(
    `SELECT c.created_at AS at, c.author, c.kind, c.body, i.number, i.title FROM comments c
     JOIN issues i ON i.id = c.issue_id
     WHERE i.project_id=? AND c.created_at < ?
       AND (c.author IN ('System','Vorcheck','Watchdog') OR c.kind='review')
     ORDER BY c.created_at DESC LIMIT ?`,
    projectId,
    before,
    limit * 3,
  )
  const failedRuns = all(
    `SELECT r.ended_at AS at, r.agent_name, r.failure, r.note, i.number, i.title FROM runs r
     JOIN issues i ON i.id = r.issue_id
     WHERE r.project_id=? AND r.failure != '' AND r.ended_at < ?
     ORDER BY r.ended_at DESC LIMIT ?`,
    projectId,
    before,
    limit,
  )

  const entries: JournalEntry[] = []
  for (const c of comments) {
    const line = journalLine(c)
    if (line) entries.push({ at: c.at, issue: c.number, title: c.title, ...line })
  }
  for (const r of failedRuns) {
    const why = r.note ? `: ${firstSentence(r.note, 100)}` : ''
    entries.push({
      at: r.at,
      issue: r.number,
      title: r.title,
      kind: 'runFailed',
      text: t('Lauf von {agent} fehlgeschlagen ({failure})', { agent: r.agent_name, failure: r.failure }) + why,
    })
  }
  return entries.sort((a, b) => b.at - a.at).slice(0, limit)
}
