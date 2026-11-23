// Limit resets a provider grants now and then (Codex calls them rate-limit reset credits). AgentDeck
// knows how many are available and redeems one only when the owner switched that on.
import { get, run } from './db.ts'

export type ResetState = { available: number; checkedAt: number }

const known = new Map<string, ResetState>()

/** From this utilisation on a window counts as used up and a reset is worth redeeming. */
export const RESET_WHEN_ABOVE = 0.98
/** A window that resets on its own within this time is not worth a reset. */
export const RESET_ONLY_IF_LONGER_THAN = 60 * 60_000

const settingKey = (provider: string) => `resets.${provider}`

export function resetsEnabled(provider: string) {
  return get('SELECT value FROM settings WHERE key=?', settingKey(provider))?.value === 'on'
}

export function setResetsEnabled(provider: string, enabled: boolean) {
  run(
    'INSERT OR REPLACE INTO settings (key, value) VALUES (?,?)',
    settingKey(provider),
    enabled ? 'on' : 'off',
  )
}

export function rememberResets(provider: string, available: number, now = Date.now()) {
  known.set(provider, { available, checkedAt: now })
}

/** What the usage page shows. Null while the provider has never said anything about resets. */
export function resetsOf(provider: string) {
  const state = known.get(provider)
  return state ? { ...state, enabled: resetsEnabled(provider) } : null
}

type Window = { utilization: number; resets_at: number | null }

/**
 * Whether to redeem a reset now: switched on, one available, and a window that stops every run
 * is used up and would stay so for a while yet.
 */
export function shouldRedeem(o: { enabled: boolean; available: number; windows: Window[]; now: number }) {
  if (!o.enabled || o.available < 1) return false
  return o.windows.some(
    (w) =>
      w.utilization >= RESET_WHEN_ABOVE &&
      (w.resets_at === null || w.resets_at - o.now > RESET_ONLY_IF_LONGER_THAN),
  )
}
