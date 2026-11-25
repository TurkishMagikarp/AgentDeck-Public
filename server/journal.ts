// The project journal: what happened, in one line each, newest first. Built from what is stored
// anyway (the server's own comments, review verdicts, failed runs), so nothing new is recorded and
// older history shows up too. The rules that turn a comment into a line are pure functions.
import { all } from './db.ts'

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

/** One journal line for a comment, or null when the comment is not worth one. */
export function journalLine(comment: Comment): { kind: JournalKind; text: string } | null {
  const { author, body } = comment
  if (comment.kind === 'review') {
    if (/^\s*changes\s*:/i.test(body))
      return { kind: 'changes', text: `${author} asks for changes: ${firstSentence(body.replace(/^\s*\S+\s*:\s*/, ''))}` }
    return null
  }
  if (author === 'Watchdog') return { kind: 'watchdog', text: firstSentence(body) }
  if (author === 'Precheck') {
    if (/^Precheck passed/.test(body)) return null
    const failure = firstFailure(body)
    return { kind: 'precheckRed', text: failure ? `Precheck red: ${failure}` : `Precheck red: ${firstSentence(body)}` }
  }
  if (author !== 'System') return null

  const landed = body.match(/^Landed in (\S+) \((\w+)/)
  if (landed) return { kind: 'landed', text: `Landed in ${landed[1]} (${landed[2]})` }
  if (/(failed \(exit code [^)]*\)|was stopped after \d+ minutes) on the merged state/.test(body) && !/ to decide:/.test(body)) {
    const failure = firstFailure(body)
    return { kind: 'landingRed', text: failure ? `Landing red: ${failure}` : 'Landing red, back to the maker' }
  }
  if (/ to decide:|Waits for a human|Parked/.test(body))
    return { kind: 'escalated', text: firstSentence(body.replace(/\n[\s\S]*$/, '')) }
  const waits = body.match(/Now waits for ([^.]+?) and carries on/)
  if (waits) return { kind: 'waits', text: `Waits for ${waits[1]}` }
  if (/^Partial handoff/.test(body)) return { kind: 'partial', text: firstSentence(body) }
  const approved = body.match(/^(\S+) approved\./)
  if (approved) return { kind: 'approved', text: `Approved by ${approved[1]}` }
  return null
}

/** The journal of a project, newest first, before a point in time (for paging). */
export function journal(projectId: number, before = Number.MAX_SAFE_INTEGER, limit = 200): JournalEntry[] {
  const comments = all(
    `SELECT c.created_at AS at, c.author, c.kind, c.body, i.number, i.title FROM comments c
     JOIN issues i ON i.id = c.issue_id
     WHERE i.project_id=? AND c.created_at < ?
       AND (c.author IN ('System','Precheck','Watchdog') OR c.kind='review')
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
      text: `Run of ${r.agent_name} failed (${r.failure})${why}`,
    })
  }
  return entries.sort((a, b) => b.at - a.at).slice(0, limit)
}
