// Asks Codex itself how full the ChatGPT subscription is and how many limit resets are available,
// through the official app-server protocol of the CLI. Codex otherwise reports its windows only in
// the session files of finished runs. Redeems a reset when the owner allowed it, see resets.ts.
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { saveQuota } from './adapters.ts'
import { getAccess } from './auth.ts'
import { t } from './i18n.ts'
import { limitingWindows } from './pacing.ts'
import { rememberResets, resetsEnabled, shouldRedeem } from './resets.ts'

const PROVIDER = 'openai'
const EVERY = 5 * 60_000
const TIMEOUT = 30_000

type Request = { method: string; params: unknown }

/** Starts `codex app-server`, sends the requests one after another and returns their results. */
function askCodex(requests: Request[]): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const isWindows = process.platform === 'win32'
    const child = isWindows
      ? spawn('codex app-server', { shell: true, windowsHide: true })
      : spawn('codex', ['app-server'])
    const results: any[] = []
    let buffer = ''
    let nextId = 1
    const timer = setTimeout(() => finish(new Error(t('codex app-server antwortet nicht'))), TIMEOUT)

    function finish(error?: Error) {
      clearTimeout(timer)
      child.kill()
      error ? reject(error) : resolve(results)
    }
    function send(message: object) {
      child.stdin.write(JSON.stringify(message) + '\n')
    }
    function sendNext() {
      const index = nextId - 2
      if (index >= requests.length) return finish()
      send({ id: nextId++, ...requests[index] })
    }

    child.on('error', finish)
    child.stdin.on('error', () => {})
    child.stdout.on('data', (chunk) => {
      buffer += chunk
      let end
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end)
        buffer = buffer.slice(end + 1)
        let message
        try {
          message = JSON.parse(line)
        } catch {
          continue
        }
        if (message.id !== nextId - 1) continue
        if (message.error) return finish(new Error(message.error.message ?? t('codex app-server Fehler')))
        if (message.id === 1) send({ method: 'initialized' })
        else results.push(message.result)
        sendNext()
      }
    })
    send({ id: nextId++, method: 'initialize', params: { clientInfo: { name: 'agentdeck', version: '1' } } })
  })
}

/** Stores the windows of a rateLimits snapshot under the names readCodexQuota uses. */
export function saveCodexWindows(snapshot: any) {
  for (const window of [snapshot?.primary, snapshot?.secondary]) {
    if (typeof window?.usedPercent !== 'number') continue
    const name = `${window.windowDurationMins ?? 'codex'}min`
    saveQuota(PROVIDER, name, window.usedPercent / 100, window.resetsAt ? window.resetsAt * 1000 : null)
  }
}

/** `afterReset` reads once more after a redeemed reset, but never redeems a second one in a row. */
export async function readCodexUsage(now = Date.now(), afterReset = false) {
  if (getAccess(PROVIDER).mode !== 'subscription') return
  const [limits] = await askCodex([{ method: 'account/rateLimits/read', params: null }])
  saveCodexWindows(limits?.rateLimits)
  const available = Number(limits?.rateLimitResetCredits?.availableCount ?? 0)
  rememberResets(PROVIDER, available, now)

  if (afterReset) return
  const enabled = resetsEnabled(PROVIDER)
  if (!shouldRedeem({ enabled, available, windows: limitingWindows(PROVIDER, now).filter((w) => !w.stale), now }))
    return
  const [answer] = await askCodex([
    { method: 'account/rateLimitResetCredit/consume', params: { idempotencyKey: randomUUID() } },
  ])
  console.log(`Codex-Reset eingelöst: ${answer?.outcome}`)
  if (answer?.outcome === 'reset') await readCodexUsage(Date.now(), true)
}

/** `onRead` runs after each reading: new quota numbers can let waiting issues start. */
export function startCodexUsage(onRead: () => void = () => {}) {
  const read = () => readCodexUsage().then(onRead, () => {})
  read()
  setInterval(read, EVERY).unref()
}
