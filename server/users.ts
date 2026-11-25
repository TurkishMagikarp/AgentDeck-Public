// People with their own login besides the owner's board token. Each gets a random token, shown
// once; the server keeps only hashes of it: one to check a Bearer token, one to recognise the
// session cookie the login form sets (the cookie holds that hash, never the token).
import { createHash, randomBytes } from 'node:crypto'
import { all, get, run } from './db.ts'
import { isRole, type Role } from './roles.ts'

export type User = { id: number; name: string; role: Role }

const sha = (text: string) => createHash('sha256').update(text).digest('hex')
export const tokenHash = (token: string) => sha(`agentdeck-token:${token}`)
export const sessionHash = (token: string) => sha(`agentdeck-session:${token}`)

// Looked up on every request: kept in RAM, rebuilt after each change.
let byToken: Map<string, User> | null = null
let bySession: Map<string, User> | null = null
let byName: Map<string, User> | null = null

function load() {
  byToken = new Map()
  bySession = new Map()
  byName = new Map()
  for (const row of all('SELECT id, name, role, token_hash, session_hash FROM users')) {
    const user: User = { id: row.id, name: row.name, role: isRole(row.role) ? row.role : 'viewer' }
    byToken.set(row.token_hash, user)
    bySession.set(row.session_hash, user)
    byName.set(row.name.toLowerCase(), user)
  }
}
const forget = () => (byToken = bySession = byName = null)

export function userByToken(token: string) {
  if (!token) return undefined
  if (!byToken) load()
  return byToken!.get(tokenHash(token))
}
export function userBySession(cookie: string) {
  if (!cookie) return undefined
  if (!bySession) load()
  return bySession!.get(cookie)
}
export function userByName(name: string) {
  if (!byName) load()
  return byName!.get(name.toLowerCase())
}

export const listUsers = () =>
  all('SELECT id, name, role, created_at, last_used_at FROM users ORDER BY name COLLATE NOCASE')

const NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._@-]{0,59}$/u

export function createUser(name: string, role: unknown) {
  const clean = name.trim()
  if (!NAME.test(clean)) throw new Error('Name: 1–60 characters, letters, digits, spaces, . _ @ -')
  if (!isRole(role)) throw new Error('Unknown role')
  // These names label actions of the owner and the system in comments and the audit log.
  if (/^(owner|watchdog|system|spend limit)$/i.test(clean)) throw new Error('This name is reserved for the system')
  if (userByName(clean)) throw new Error('This name already exists')
  const token = 'adu_' + randomBytes(32).toString('base64url')
  const result = run(
    'INSERT INTO users (name, role, token_hash, session_hash, created_at) VALUES (?,?,?,?,?)',
    clean,
    role,
    tokenHash(token),
    sessionHash(token),
    Date.now(),
  )
  forget()
  return { user: { id: Number(result.lastInsertRowid), name: clean, role }, token }
}

export function setUserRole(id: number, role: unknown) {
  if (!isRole(role)) throw new Error('Unknown role')
  const result = run('UPDATE users SET role=? WHERE id=?', role, id)
  forget()
  return result.changes > 0
}

export function deleteUser(id: number) {
  const result = run('DELETE FROM users WHERE id=?', id)
  forget()
  return result.changes > 0
}

// last_used_at is for the owner's overview; written at most once a minute per user.
const touched = new Map<number, number>()
export function noteUse(user: User) {
  const now = Date.now()
  if (now - (touched.get(user.id) ?? 0) < 60_000) return
  touched.set(user.id, now)
  run('UPDATE users SET last_used_at=? WHERE id=?', now, user.id)
}

export const userById = (id: number) => get('SELECT id, name, role FROM users WHERE id=?', id) as User | undefined
