// Re-authentication for settings the server runs as shell commands. A session cookie alone (a
// browser left open, a forged request) must not be enough to plant a command line that runs in
// the project on the next review or landing: such a change needs the board token in the same
// request, either as `confirmToken` in the body or as the Bearer header of a script.
//
// Behind the trusted proxy without a board token there is no secret the server could check: the
// proxy proves who is logged in, not that the person is at the keyboard right now. Changes to
// commands are refused then, until AGENTDECK_TOKEN is set as well (proxy and token work together).
import { timingSafeEqual } from 'node:crypto'
import { mergeSettings, type Settings } from './core.ts'

/** Every setting that ends up in runShellIn or spawnShellIn (precheck.ts, landing.ts, preview.ts). */
export const SHELL_SETTINGS = ['precheck.command', 'precheck.quickCommand', 'preview.command'] as const

export type ConfirmMode = 'open' | 'token' | 'refused'

/** open: no login at all (local, mock), nothing to confirm with. */
export const confirmMode = (token: string, trustProxy: boolean): ConfirmMode =>
  token ? 'token' : trustProxy ? 'refused' : 'open'

const valueAt = (settings: any, path: string) =>
  String(path.split('.').reduce((node, name) => node?.[name], settings) ?? '')

/**
 * The shell settings that differ between the stored settings and the incoming raw ones, after the
 * same normalisation the server applies when it saves. `before` is null for a new project.
 */
export function changedShellSettings(before: Settings | null, raw: unknown): string[] {
  const after = mergeSettings(raw)
  const old = before ?? mergeSettings({})
  return SHELL_SETTINGS.filter((path) => valueAt(old, path) !== valueAt(after, path))
}

export function sameSecret(given: string, wanted: string) {
  const a = Buffer.from(given)
  const b = Buffer.from(wanted)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** True when the request carries the board token. Never true without one: '' must not match ''. */
export function confirmedBy(token: string, confirmToken: unknown, authorization: string | undefined) {
  if (!token) return false
  if (typeof confirmToken === 'string' && sameSecret(confirmToken, token)) return true
  const header = authorization ?? ''
  return header.startsWith('Bearer ') && sameSecret(header.slice(7), token)
}
