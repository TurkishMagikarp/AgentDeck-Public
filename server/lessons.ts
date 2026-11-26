// What a project has learned the hard way: build commands, pitfalls, tools that had to be installed.
// Agents record lessons with the board command "learn", the self-healing records missing tools,
// and the owner can add or delete them. Every run of the project reads the newest ones.
import { all, get, run } from './db.ts'
import { t } from './i18n.ts'
import { prompts } from './prompts/index.ts'

/** Only the newest lessons go into a prompt; older ones stay visible in the settings. */
const IN_PROMPT = 15
const MAX_LENGTH = 400

export function listLessons(projectId: number) {
  return all(
    'SELECT id, body, source, created_at FROM lessons WHERE project_id=? ORDER BY id DESC',
    projectId,
  )
}

export function addLesson(projectId: number, body: string, source: string) {
  const text = body.trim().replace(/\s+/g, ' ').slice(0, MAX_LENGTH)
  if (!text) throw new Error(t('Notiz leer'))
  // The same lesson twice only costs prompt space.
  const known = get('SELECT id FROM lessons WHERE project_id=? AND lower(body)=lower(?)', projectId, text)
  if (known) return known.id as number
  const inserted = run(
    'INSERT INTO lessons (project_id, body, source, created_at) VALUES (?,?,?,?)',
    projectId,
    text,
    source.slice(0, 80),
    Date.now(),
  )
  return Number(inserted.lastInsertRowid)
}

export function deleteLesson(projectId: number, id: number) {
  run('DELETE FROM lessons WHERE project_id=? AND id=?', projectId, id)
}

export function lessonsForPrompt(projectId: number) {
  const lessons = all(
    'SELECT body FROM lessons WHERE project_id=? ORDER BY id DESC LIMIT ?',
    projectId,
    IN_PROMPT,
  )
  if (!lessons.length) return ''
  return `${prompts().lessons}\n${lessons
    .reverse()
    .map((lesson) => `- ${lesson.body}`)
    .join('\n')}`
}
