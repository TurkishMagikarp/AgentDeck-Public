// A note from the owner that every agent of every project reads at the top of its prompt:
// the place for a rule that changed for all of them at once ("we push to Forgejo now, not GitHub").
import { get, run } from './db.ts'

const KEY = 'agents.note'
export const MAX_OWNER_NOTE = 2000

export const ownerNote = (): string => get('SELECT value FROM settings WHERE key=?', KEY)?.value ?? ''

export function saveOwnerNote(input: { note?: unknown }) {
  const note = String(input.note ?? '').trim().slice(0, MAX_OWNER_NOTE)
  run('INSERT OR REPLACE INTO settings (key, value) VALUES (?,?)', KEY, note)
  return { note }
}
