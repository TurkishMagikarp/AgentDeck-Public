// Asks Anthropic itself how full the Claude subscription is. Claude Code reports its windows in
// rate_limit_event only now and then (never with some logins), so the display and the routing
// would otherwise go by readings that are days old. This is the same source as /usage in the CLI.
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { saveQuota } from './adapters.ts'
import { getAccess, getSecret, SUBSCRIPTION_TOKEN } from './auth.ts'
import { all, run } from './db.ts'

const PROVIDER = 'anthropic'
const EVERY = 5 * 60_000
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'

type Limit = {
  kind: string
  group: string
  percent: number
  resets_at: string | null
  scope: { model?: { display_name?: string | null } | null } | null
}

/** The token the CLI itself uses: the stored long-lived one, else the login in its config folder. */
function subscriptionToken() {
  const stored = getSecret(SUBSCRIPTION_TOKEN)
  if (stored) return stored
  const file = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), '.credentials.json')
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8')).claudeAiOauth?.accessToken ?? null
  } catch {
    return null
  }
}

/**
 * Window names as Claude Code uses them in rate_limit_event, so both sources fill the same rows:
 * the weekly limit for all models is "seven_day", the one for a single model "seven_day_fable".
 */
export function windowName(limit: Limit) {
  const model = limit.scope?.model?.display_name?.toLowerCase().replace(/\W+/g, '_')
  const base = limit.group === 'weekly' ? 'seven_day' : limit.group === 'session' ? 'five_hour' : limit.group
  return model ? `${base}_${model}` : base
}

export async function readClaudeUsage() {
  if (getAccess(PROVIDER).mode !== 'subscription') return
  const token = subscriptionToken()
  if (!token) return

  const response = await fetch(USAGE_URL, {
    headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' },
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) return
  saveClaudeWindows(claudeWindows(await response.json()))
}

type ClaudeWindow = { window: string; utilization: number; resetsAt: number | null }

/** The windows in an answer of the usage endpoint. */
export function claudeWindows(usage: any): ClaudeWindow[] {
  const windows: ClaudeWindow[] = []
  const add = (window: string, percent: number, resetsAt: string | null) =>
    windows.push({ window, utilization: percent / 100, resetsAt: resetsAt ? Date.parse(resetsAt) : null })
  for (const limit of (usage?.limits ?? []) as Limit[])
    if (typeof limit.percent === 'number') add(windowName(limit), limit.percent, limit.resets_at)
  const fiveHour = usage?.five_hour
  if (typeof fiveHour?.utilization === 'number' && !windows.some((w) => w.window === 'five_hour'))
    add('five_hour', fiveHour.utilization, fiveHour.resets_at)
  return windows
}

export function saveClaudeWindows(windows: ClaudeWindow[]) {
  if (!windows.length) return
  for (const w of windows) saveQuota(PROVIDER, w.window, w.utilization, w.resetsAt)
  // Windows Anthropic no longer reports (extra usage, an ended promotion) would otherwise stay forever.
  const seen = new Set(windows.map((w) => w.window))
  for (const row of all('SELECT window FROM quota WHERE provider=?', PROVIDER))
    if (!seen.has(row.window)) run('DELETE FROM quota WHERE provider=? AND window=?', PROVIDER, row.window)
}

export function startClaudeUsage() {
  const read = () => readClaudeUsage().catch(() => {})
  read()
  setInterval(read, EVERY).unref()
}
