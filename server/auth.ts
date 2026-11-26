// How AgentDeck reaches each provider: through the CLI's subscription login or with an API key.
// Also drives the CLI login flows so they can be completed from the browser.
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR, get, run } from './db.ts'
import { t } from './i18n.ts'
import { wakeProvider } from './recovery.ts'

export type AccessMode = 'subscription' | 'apikey'
type LoginKind = 'claude' | 'codex'

type AccessInfo = { modes: AccessMode[]; login?: LoginKind; statusCommand?: [string, string[]] }

export const ACCESS: Record<string, AccessInfo> = {
  anthropic: {
    modes: ['subscription', 'apikey'],
    login: 'claude',
    statusCommand: ['claude', ['auth', 'status']],
  },
  openai: {
    modes: ['subscription', 'apikey'],
    login: 'codex',
    statusCommand: ['codex', ['login', 'status']],
  },
  opencode: { modes: ['subscription', 'apikey'], statusCommand: ['opencode', ['auth', 'list']] },
  deepseek: { modes: ['apikey'] },
  'claude-managed': { modes: ['apikey'] },
  mock: { modes: ['subscription'] },
}

const isWindows = process.platform === 'win32'
const stripAnsi = (text: string) => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')

// ---------- secrets at rest ----------

let cachedKey: Buffer | undefined

/** Keys are encrypted with AGENTDECK_SECRET, or with a random secret kept next to the database. */
function masterKey() {
  if (cachedKey) return cachedKey
  let passphrase = process.env.AGENTDECK_SECRET
  if (!passphrase) {
    const file = join(DATA_DIR, 'secret.key')
    if (!existsSync(file)) writeFileSync(file, randomBytes(32).toString('hex'), { mode: 0o600 })
    passphrase = readFileSync(file, 'utf8').trim()
  }
  cachedKey = scryptSync(passphrase, 'agentdeck-provider-keys', 32)
  return cachedKey
}

export function encrypt(plain: string) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', masterKey(), iv)
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64')
}

export function decrypt(stored: string) {
  const raw = Buffer.from(stored, 'base64')
  const decipher = createDecipheriv('aes-256-gcm', masterKey(), raw.subarray(0, 12))
  decipher.setAuthTag(raw.subarray(12, 28))
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8')
}

// ---------- access mode and keys ----------

export function getAccess(provider: string) {
  const row = get('SELECT mode, secret FROM provider_auth WHERE provider=?', provider)
  const modes = ACCESS[provider]?.modes ?? ['subscription']
  const mode: AccessMode = row && modes.includes(row.mode) ? row.mode : modes[0]
  const hasKey = !!row?.secret
  return { mode, hasKey, ready: mode === 'subscription' || hasKey }
}

export function apiKey(provider: string): string | null {
  const row = get('SELECT secret FROM provider_auth WHERE provider=?', provider)
  if (!row?.secret) return null
  try {
    return decrypt(row.secret)
  } catch {
    return null // secret was encrypted with a different master key
  }
}

export const SUBSCRIPTION_TOKEN = 'anthropic.subscription-token'

export function setSecret(name: string, value: string) {
  if (value) run('INSERT OR REPLACE INTO secrets (name, secret) VALUES (?,?)', name, encrypt(value))
  else run('DELETE FROM secrets WHERE name=?', name)
}

export function getSecret(name: string): string | null {
  const row = get('SELECT secret FROM secrets WHERE name=?', name)
  try {
    return row ? decrypt(row.secret) : null
  } catch {
    return null
  }
}

const codexApiHome = () => join(DATA_DIR, 'codex-api')

/** Saves the mode and, when a new key is given, the key. An empty string removes the stored key. */
export async function setAccess(provider: string, mode: AccessMode, newKey?: string) {
  if (!ACCESS[provider]?.modes.includes(mode))
    throw new Error(t('Diese Zugangsart gibt es für den Anbieter nicht'))

  const current = get('SELECT secret FROM provider_auth WHERE provider=?', provider)
  let secret: string | null = current?.secret ?? null
  if (newKey !== undefined) secret = newKey ? encrypt(newKey) : null

  run(
    'INSERT OR REPLACE INTO provider_auth (provider, mode, secret, updated_at) VALUES (?,?,?,?)',
    provider,
    mode,
    secret,
    Date.now(),
  )

  // Codex only takes an API key through its own login, so it gets a config folder of its own.
  // The subscription login in the default folder stays untouched.
  if (provider === 'openai' && newKey) await storeCodexApiKey(newKey)
  // New access, new chance: a provider resting after a broken login may be asked again at once.
  wakeProvider(provider)
}

function storeCodexApiKey(key: string) {
  mkdirSync(codexApiHome(), { recursive: true })
  return new Promise<void>((resolve, reject) => {
    const child = spawnCli('codex', ['login', '--with-api-key'], { CODEX_HOME: codexApiHome() })
    child.on('error', reject)
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(t('Codex hat den API-Key nicht angenommen'))),
    )
    child.stdin!.end(key)
  })
}

/** Environment for an agent process of this provider. AgentDeck's own secrets never reach agents. */
/** process.env without AgentDeck's own secrets. Use for every process that runs agent-controlled code. */
export function safeEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...process.env, ...extra }
  delete env.AGENTDECK_TOKEN
  delete env.AGENTDECK_SECRET
  delete env.AGENTDECK_PROXY_SECRET
  return env
}

export function runEnv(provider: string, cli: string): NodeJS.ProcessEnv {
  const env = safeEnv()

  const access = getAccess(provider)
  const key = access.mode === 'apikey' ? apiKey(provider) : null
  if (access.mode === 'apikey' && !key) throw new Error(t('Für diesen Anbieter ist kein API-Key hinterlegt'))

  if (cli === 'claude') {
    // An inherited key would silently bill the API although "subscription" is selected.
    delete env.ANTHROPIC_API_KEY
    delete env.ANTHROPIC_AUTH_TOKEN
    if (key) env.ANTHROPIC_API_KEY = key
    // A token from "claude setup-token" logs the subscription in without any login files, which
    // is what a server wants: nothing to refresh, nothing that two processes could fight over.
    const subscriptionToken = key ? null : getSecret(SUBSCRIPTION_TOKEN)
    if (subscriptionToken) env.CLAUDE_CODE_OAUTH_TOKEN = subscriptionToken
  } else if (cli === 'codex') {
    if (key) env.CODEX_HOME = codexApiHome()
  } else if (cli === 'opencode') {
    if (key) env.OPENCODE_API_KEY = key
  }
  return env
}

function spawnCli(command: string, args: string[], extraEnv: NodeJS.ProcessEnv = {}) {
  const env = { ...process.env, ...extraEnv }
  // The CLIs are .cmd shims on Windows and need a shell. All arguments here are fixed strings.
  return isWindows
    ? spawn([command, ...args].join(' '), { shell: true, windowsHide: true, env })
    : spawn(command, args, { env })
}

// ---------- login status ----------

export function loginStatus(provider: string) {
  const command = ACCESS[provider]?.statusCommand
  if (!command) return Promise.resolve({ loggedIn: null as boolean | null, detail: '' })

  return new Promise<{ loggedIn: boolean | null; detail: string }>((resolve) => {
    const child = spawnCli(command[0], command[1])
    let output = ''
    child.stdout!.on('data', (chunk) => (output += chunk))
    child.stderr!.on('data', (chunk) => (output += chunk))
    const timer = setTimeout(() => child.kill(), 15_000)
    child.on('error', () => resolve({ loggedIn: null, detail: t('{cli} ist nicht installiert', { cli: command[0] }) }))
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve(readStatus(provider, stripAnsi(output), code))
    })
  })
}

export function readStatus(provider: string, output: string, exitCode: number | null) {
  if (provider === 'anthropic') {
    if (getSecret(SUBSCRIPTION_TOKEN)) return { loggedIn: true, detail: t('über hinterlegtes Abo-Token') }
    try {
      const status = JSON.parse(output)
      return { loggedIn: !!status.loggedIn, detail: status.loggedIn ? t('über {method}', { method: status.authMethod }) : '' }
    } catch {
      return { loggedIn: false, detail: '' }
    }
  }
  if (provider === 'openai') {
    const loggedIn = exitCode === 0 && /logged in/i.test(output) && !/not logged in/i.test(output)
    return { loggedIn, detail: loggedIn ? output.trim().split('\n')[0] : '' }
  }
  // opencode ends its list with "N credentials"; account names stay on the server.
  const stored = Number(output.match(/(\d+)\s+credentials?\b/i)?.[1] ?? 0)
  return { loggedIn: stored > 0, detail: stored ? t('{n} Zugänge hinterlegt', { n: stored }) : '' }
}

// ---------- login from the browser ----------

type Login = {
  child: ChildProcess
  state: 'waiting' | 'done' | 'failed'
  url: string
  code: string
  needsCode: boolean
  output: string
  timer: NodeJS.Timeout
}

const logins = new Map<string, Login>()

const LOGIN_COMMANDS: Record<LoginKind, [string, string[]]> = {
  claude: ['claude', ['auth', 'login', '--claudeai']],
  codex: ['codex', ['login', '--device-auth']],
}

export function startLogin(provider: string, onComplete = () => wakeProvider(provider)) {
  const kind = ACCESS[provider]?.login
  if (!kind) throw new Error(t('Für diesen Anbieter gibt es keinen Login über das Tool'))
  cancelLogin(provider)

  const [command, args] = LOGIN_COMMANDS[kind]
  const child = spawnCli(command, args)
  const login: Login = {
    child,
    state: 'waiting',
    url: '',
    code: '',
    // Claude shows a code in the browser that has to be pasted back, Codex shows one to type in there.
    needsCode: kind === 'claude',
    output: '',
    timer: setTimeout(() => cancelLogin(provider), 15 * 60_000),
  }
  logins.set(provider, login)

  const onOutput = (chunk: Buffer) => {
    login.output = (login.output + stripAnsi(String(chunk))).slice(-4000)
    login.url ||= login.output.match(/https:\/\/\S+/)?.[0] ?? ''
    if (kind === 'codex') login.code ||= login.output.match(/\b[A-Z0-9]{4}-[A-Z0-9]{4,6}\b/)?.[0] ?? ''
  }
  child.stdout!.on('data', onOutput)
  child.stderr!.on('data', onOutput)
  child.stdin!.on('error', () => {})
  child.on('error', () => (login.state = 'failed'))
  child.on('close', (exitCode) => {
    clearTimeout(login.timer)
    if (login.state === 'waiting') login.state = exitCode === 0 ? 'done' : 'failed'
    if (login.state === 'done') onComplete()
  })
  return loginView(provider)
}

export function loginView(provider: string) {
  const login = logins.get(provider)
  if (!login) return { state: 'idle' as const }
  const lastLines = login.output.trim().split('\n').slice(-3).join('\n')
  return {
    state: login.state,
    url: login.url,
    code: login.code,
    needsCode: login.needsCode,
    message: login.state === 'failed' ? lastLines : '',
  }
}

export function submitLoginCode(provider: string, code: string) {
  const login = logins.get(provider)
  if (!login || login.state !== 'waiting') throw new Error(t('Kein laufender Login'))
  if (!/^[\w#.~-]{4,400}$/.test(code)) throw new Error(t('Der Code sieht nicht richtig aus'))
  login.child.stdin!.write(code + '\n')
}

export function cancelLogin(provider: string) {
  const login = logins.get(provider)
  if (!login) return
  clearTimeout(login.timer)
  if (login.state === 'waiting') {
    login.state = 'failed'
    if (isWindows && login.child.pid)
      execFile('taskkill', ['/pid', String(login.child.pid), '/T', '/F'], () => {})
    else login.child.kill()
  }
  logins.delete(provider)
}
