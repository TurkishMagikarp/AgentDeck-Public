import { run } from '../server/db.ts'

export const HOUR = 3_600_000

export function setQuota(
  provider: string,
  window: string,
  utilization: number,
  o: { resetsIn?: number | null; age?: number; now?: number } = {},
) {
  const now = o.now ?? Date.now()
  const resetsAt = o.resetsIn === null ? null : now + (o.resetsIn ?? 48 * HOUR)
  run(
    'INSERT OR REPLACE INTO quota (provider, window, utilization, resets_at, updated_at) VALUES (?,?,?,?,?)',
    provider,
    window,
    utilization,
    resetsAt,
    now - (o.age ?? 0),
  )
}

export function clearQuota() {
  run('DELETE FROM quota')
}

export function setMode(provider: string, mode: 'subscription' | 'apikey') {
  run(
    'INSERT OR REPLACE INTO provider_auth (provider, mode, secret, updated_at) VALUES (?,?,NULL,?)',
    provider,
    mode,
    Date.now(),
  )
}
