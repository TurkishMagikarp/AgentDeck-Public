// Issue search across all projects, for the search box. A key ("ABC-439") or a bare number finds
// that issue first; words find issues whose title or description contains all of them, title
// hits first and open work before finished work.
import { all } from './db.ts'

const LIMIT = 20

export type SearchHit = {
  id: number
  key: string
  number: number
  title: string
  status: string
  project: string
  projectKey: string
  assignee: string | null
  /** A few words around the first match in the description, when the title did not match. */
  excerpt: string
}

const SELECT = `SELECT i.id, i.number, i.title, i.status, i.description, p.name AS project, p.key AS projectKey,
  a.name AS assignee
  FROM issues i JOIN projects p ON p.id = i.project_id LEFT JOIN agents a ON a.id = i.assignee_id`

/** LIKE treats % and _ as wildcards; a search for "100%" means the text. */
const literal = (word: string) => `%${word.replace(/[\\%_]/g, (char) => `\\${char}`)}%`

function excerptOf(description: string, words: string[]) {
  const lower = description.toLowerCase()
  const at = Math.min(...words.map((word) => lower.indexOf(word.toLowerCase())).filter((index) => index >= 0))
  if (!Number.isFinite(at)) return ''
  const start = Math.max(0, at - 40)
  const text = description
    .slice(start, at + 100)
    .replace(/\s+/g, ' ')
    .trim()
  return `${start > 0 ? '…' : ''}${text}…`
}

export function searchIssues(query: string): SearchHit[] {
  const text = query.trim().slice(0, 200)
  if (!text) return []

  const exact: any[] = []
  const byKey = text.match(/^([A-Za-z][A-Za-z0-9]*)-(\d+)$/)
  if (byKey) {
    exact.push(...all(`${SELECT} WHERE p.key = ? AND i.number = ?`, byKey[1].toUpperCase(), Number(byKey[2])))
  } else if (/^\d+$/.test(text)) {
    exact.push(...all(`${SELECT} WHERE i.number = ? ORDER BY p.key`, Number(text)))
  }

  const words = text
    .split(/\s+/)
    .filter((word) => word.length > 1 || /\d/.test(word))
    .slice(0, 6)
  const found = words.length
    ? all(
        `${SELECT} WHERE ${words.map(() => "(i.title || ' ' || i.description) LIKE ? ESCAPE '\\'").join(' AND ')}
         ORDER BY ${words.map(() => "i.title LIKE ? ESCAPE '\\'").join(' + ')} DESC,
           i.status = 'done', i.updated_at DESC
         LIMIT ?`,
        ...words.map(literal),
        ...words.map(literal),
        LIMIT,
      )
    : []

  const seen = new Set<number>()
  return [...exact, ...found]
    .filter((row) => !seen.has(row.id) && seen.add(row.id))
    .slice(0, LIMIT)
    .map((row) => {
      const inTitle = words.every((word) => row.title.toLowerCase().includes(word.toLowerCase()))
      return {
        id: row.id,
        key: `${row.projectKey}-${row.number}`,
        number: row.number,
        title: row.title,
        status: row.status,
        project: row.project,
        projectKey: row.projectKey,
        assignee: row.assignee,
        excerpt: inTitle ? '' : excerptOf(row.description ?? '', words),
      }
    })
}
