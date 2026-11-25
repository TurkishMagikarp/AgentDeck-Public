// Audit log: who changed what in the owner's settings, so a change nobody remembers can be traced.
// Secret values (API keys, tokens) never reach this table: callers pass only whether a secret
// changed, and `scrub` drops anything under a secret-looking name in case a caller forgets.
import { all, run } from './db.ts'

const DAY = 86_400_000
export const AUDIT_DAYS = 180

export type AuditEntry = { id: number; at: number; actor: string; action: string; target: string; detail: any }

const SECRET_NAME = /key|token|secret|passw|credential/i

/** Copies `value` without fields whose name looks like a secret; their presence becomes `true`. */
export function scrub(value: unknown, depth = 0): unknown {
  if (depth > 4) return null
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => scrub(item, depth + 1))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [name, inner] of Object.entries(value).slice(0, 50))
      out[name] = SECRET_NAME.test(name) ? true : scrub(inner, depth + 1)
    return out
  }
  return typeof value === 'string' ? value.slice(0, 300) : value
}

export function audit(actor: string, action: string, target = '', detail: Record<string, unknown> = {}) {
  run(
    'INSERT INTO audit_log (at, actor, action, target, detail) VALUES (?,?,?,?,?)',
    Date.now(),
    String(actor).slice(0, 120) || 'Owner',
    action,
    String(target).slice(0, 200),
    JSON.stringify(scrub(detail)),
  )
}

/** Newest first. `before` is the id of the last entry of the previous page. */
export function listAudit(limit?: unknown, before?: unknown): AuditEntry[] {
  const size = Math.max(1, Math.min(200, Math.floor(Number(limit)) || 50))
  const cursor = Math.floor(Number(before))
  const rows =
    cursor > 0
      ? all('SELECT * FROM audit_log WHERE id < ? ORDER BY id DESC LIMIT ?', cursor, size)
      : all('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?', size)
  return rows.map((row) => ({ ...row, detail: JSON.parse(row.detail || '{}') }))
}

export function pruneAudit(now = Date.now()) {
  return Number(run('DELETE FROM audit_log WHERE at < ?', now - AUDIT_DAYS * DAY).changes)
}

/**
 * The setting paths that differ between two settings objects. Numbers and booleans keep their old
 * and new value; text only counts as changed, because a command line or a path may carry a secret.
 */
export function settingsChanges(before: any, after: any) {
  const changes: Record<string, unknown> = {}
  const walk = (a: any, b: any, path: string) => {
    if (JSON.stringify(a) === JSON.stringify(b)) return
    const plain = (v: any) => v && typeof v === 'object' && !Array.isArray(v)
    if (plain(a) && plain(b)) {
      for (const name of new Set([...Object.keys(a), ...Object.keys(b)]))
        walk(a[name], b[name], path ? `${path}.${name}` : name)
      return
    }
    const shown = (v: any) => typeof v === 'number' || typeof v === 'boolean'
    changes[path] = shown(a) && shown(b) ? { from: a, to: b } : 'changed'
  }
  walk(before ?? {}, after ?? {}, '')
  return changes
}
