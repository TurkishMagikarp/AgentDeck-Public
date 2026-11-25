// Agents run as a Linux user of their project, not as the server. A project user owns the
// project's repository, worktrees and home and nothing else: it cannot read the database, the
// key file, the server's logins or another project. The server reaches it with sudo, see
// docker/sudoers; the few things that need root go through docker/agentdeck-sandbox.
//
// Who a command runs as follows from the directory it runs in: a directory owned by a project
// user runs its commands as that user. So git hooks and settings an agent planted in a repo run
// as the agent too, never as the server.
//
// Off unless AGENTDECK_SANDBOX=1 on Linux (the Docker image sets it). Elsewhere nothing changes.
import { execFile, spawn, type ChildProcess, type ExecFileOptions, type SpawnOptions } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { promisify } from 'node:util'
import { configureEgress, EGRESS_PORT, egressEnv, keyOfUser, setFirewall, startEgressProxy, uidOfPeer, type EgressSettings } from './egress.ts'

export const SANDBOX = process.platform === 'linux' && process.env.AGENTDECK_SANDBOX === '1'
const HELPER = '/usr/local/sbin/agentdeck-sandbox'
const HOME_SYNC = join(import.meta.dirname, 'sandbox-home.mjs')
const execFileAsync = promisify(execFile)

// ---------- who owns a directory ----------

let users: Map<number, { name: string; home: string }> | null = null

function readUsers() {
  users = new Map()
  for (const line of readFileSync('/etc/passwd', 'utf8').split('\n')) {
    const [name, , uid, , , home] = line.split(':')
    if (name?.startsWith('ad-')) users.set(Number(uid), { name, home })
  }
  return users
}

export type ProjectUser = { name: string; home: string }

/** The project user that owns `dir` (or the folder it will be created in), or null. */
export function ownerOf(dir: string): ProjectUser | null {
  if (!SANDBOX) return null
  let uid: number | undefined
  for (let path = dir; ; path = dirname(path)) {
    try {
      uid = statSync(path).uid
      break
    } catch {
      if (dirname(path) === path) return null
    }
  }
  return (users ?? readUsers()).get(uid) ?? readUsers().get(uid) ?? null
}

/** Refuses to start agent code as the server. A project directory without its user is a setup error. */
export function ownerRequired(dir: string) {
  const owner = ownerOf(dir)
  if (SANDBOX && !owner) throw new Error(`Sandbox: ${dir} belongs to no project user, the run does not start`)
  return owner
}

// ---------- starting processes ----------

/** The server's own secrets never cross to a project user, whatever env the caller passes. */
const SERVER_SECRETS = [
  'AGENTDECK_TOKEN',
  'AGENTDECK_SECRET',
  'AGENTDECK_PROXY_SECRET',
  'AGENTDECK_GITHUB_WEBHOOK_SECRET',
]

function withoutSecrets(env: NodeJS.ProcessEnv) {
  const clean = { ...env }
  for (const name of SERVER_SECRETS) delete clean[name]
  return clean
}

/** Exported for the tests. */
export function envFor(user: ProjectUser, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  // gh's login of the server is not readable for the project user; its copy is (loginsIn).
  const gh = env.GH_CONFIG_DIR ? { GH_CONFIG_DIR: join(user.home, '.config', 'gh') } : {}
  // Allowlist projects reach the outside only through the egress proxy; it replaces any proxy
  // the caller's env names.
  const proxy = egressEnv(keyOfUser(user.name))
  return withoutSecrets({ ...env, ...gh, ...proxy, HOME: user.home, USER: user.name, LOGNAME: user.name, TMPDIR: '/tmp' })
}

const asUser = (user: ProjectUser, cmd: string, args: string[]) =>
  ['sudo', ['-n', '-E', '-u', user.name, '--', cmd, ...args]] as const

/** Process groups started through sudo: only the helper may stop those. */
const viaSudo = new Set<number>()

function track(child: ChildProcess) {
  const pid = child.pid
  if (!pid) return child
  viaSudo.add(pid)
  child.on('exit', () => viaSudo.delete(pid))
  return child
}

/**
 * Spawns `cmd` in `cwd` as the directory's project user. `agent`: the command runs code the
 * agent controls, so it may never fall back to the server's user inside the sandbox.
 */
export function spawnIn(
  cwd: string,
  cmd: string,
  args: string[],
  options: SpawnOptions = {},
  agent = false,
): ChildProcess {
  const owner = agent ? ownerRequired(cwd) : ownerOf(cwd)
  if (!owner) return spawn(cmd, args, { ...options, cwd })
  const [sudo, sudoArgs] = asUser(owner, cmd, args)
  return track(spawn(sudo, sudoArgs, { ...options, cwd, env: envFor(owner, options.env) }))
}

/** A command line through the shell, as the project user. Always agent code. */
export function spawnShellIn(cwd: string, command: string, options: SpawnOptions = {}): ChildProcess {
  if (!SANDBOX) return spawn(command, { ...options, cwd, shell: true, env: withoutSecrets(options.env ?? process.env) })
  return spawnIn(cwd, 'sh', ['-c', command], options, true)
}

type ExecResult = { stdout: string; stderr: string }

/** execFile in `dir` as its project user. For git and other tools the server calls itself. */
export function execIn(dir: string, cmd: string, args: string[], options: ExecFileOptions = {}): Promise<ExecResult> {
  const owner = ownerOf(dir)
  const run = owner
    ? execFileAsync(...asUser(owner, cmd, args), { ...options, env: envFor(owner, options.env) })
    : execFileAsync(cmd, args, options)
  return run.then((r) => ({ stdout: String(r.stdout), stderr: String(r.stderr) }))
}

/** git -C `repo` as the repo's project user. */
export const gitIn = (repo: string, args: string[], options: ExecFileOptions = {}) =>
  execIn(repo, 'git', ['-C', repo, ...args], { maxBuffer: 16 * 1024 * 1024, ...options })

/**
 * Runs a command line to its end in its own process group, as the project user, with a
 * timeout that stops the whole group. Rejects like exec: with stdout, stderr, code, killed.
 */
export function runShellIn(cwd: string, command: string, o: { timeout: number; maxBuffer?: number; env?: NodeJS.ProcessEnv }) {
  return new Promise<ExecResult>((resolve, reject) => {
    const child = spawnShellIn(cwd, command, {
      env: o.env,
      detached: process.platform !== 'win32',
      windowsHide: true,
    })
    const max = o.maxBuffer ?? 32 * 1024 * 1024
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (d) => (stdout = (stdout + d).slice(-max)))
    child.stderr?.on('data', (d) => (stderr = (stderr + d).slice(-max)))
    let killed = false
    const timer = setTimeout(() => {
      killed = true
      stopGroup(child.pid)
    }, o.timeout)
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(Object.assign(error, { stdout, stderr }))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0 && !killed) resolve({ stdout, stderr })
      else reject(Object.assign(new Error(`Exit-Code ${code}`), { stdout, stderr, code, killed }))
    })
  })
}

/** Stops a detached process group, also one started as a project user. */
export function stopGroup(pid: number | undefined) {
  if (!pid) return
  if (process.platform === 'win32') {
    execFile('taskkill', ['/pid', String(pid), '/T', '/F'], () => {})
    return
  }
  if (viaSudo.has(pid)) {
    execFile('sudo', ['-n', HELPER, 'kill', String(pid)], () => {})
    return
  }
  try {
    process.kill(-pid, 'SIGTERM')
  } catch {
    // already gone
  }
}

// ---------- setting up a project ----------

const ensured = new Map<string, Promise<void>>()

/** Creates the project user and hands it the project's folders. Once per project and repo. */
export function ensureProject(project: { key: string; repo_path?: string }) {
  if (!SANDBOX) return Promise.resolve()
  const id = `${project.key}\n${project.repo_path ?? ''}`
  let done = ensured.get(id)
  if (!done) {
    const args = ['-n', HELPER, 'ensure', project.key, ...(project.repo_path ? [project.repo_path] : [])]
    done = execFileAsync('sudo', args).then(
      async () => {
        const name = `ad-${project.key.toLowerCase()}`
        const user = [...readUsers().values()].find((u) => u.name === name)
        if (user) await seedHome(user).catch((err) => console.error(`sandbox config ${project.key}`, err.message))
      },
      (error) => {
        ensured.delete(id)
        throw new Error(`Sandbox for ${project.key}: ${String(error.stderr || error.message).trim()}`)
      },
    )
    ensured.set(id, done)
  }
  return done
}

// ---------- outbound network ----------

const egressApplied = new Map<string, { mode: string; done: Promise<void> }>()

/**
 * Brings a project's network rules in line with its settings: the proxy's allowlist at once, the
 * firewall (docker/agentdeck-sandbox egress) only when the mode changed. Never rejects. Without
 * iptables or NET_ADMIN the project stays open apart from the proxy env, and the settings page
 * says so.
 */
export function ensureEgress(project: { key: string; repo_path?: string; settings: { egress?: EgressSettings } }) {
  const { key } = project
  const egress = project.settings.egress
  if (!egress) return Promise.resolve()
  const { mode } = egress
  configureEgress(key, egress)
  if (!SANDBOX) return Promise.resolve()
  const previous = egressApplied.get(key)
  if (previous?.mode === mode) return previous.done
  setFirewall(key, 'pending')
  const done = (previous?.done ?? Promise.resolve())
    .then(() => ensureProject(project))
    .then(() => execFileAsync('sudo', ['-n', HELPER, 'egress', key, mode]))
    .then(
      () => setFirewall(key, mode === 'allowlist' ? 'active' : 'open'),
      (error) => {
        // Tried again at the next change or run start.
        if (egressApplied.get(key)?.done === done) egressApplied.delete(key)
        const message = String(error.stderr || error.message).trim()
        setFirewall(key, mode === 'allowlist' ? 'unavailable' : 'open', message)
        console.error(`sandbox egress ${key} ${mode}: ${message}`)
      },
    )
  egressApplied.set(key, { mode, done })
  return done
}

/** The project of a uid in the range the helper gives project users, or null. */
function projectKeyOfUid(uid: number) {
  if (uid < 20000 || uid > 29999) return null
  const user = (users ?? readUsers()).get(uid) ?? readUsers().get(uid)
  return user ? keyOfUser(user.name) : null
}

/** The egress proxy on 127.0.0.1. Only in the sandbox: elsewhere no rule sends agents to it. */
export function startEgress() {
  if (!SANDBOX) return
  startEgressProxy({
    port: EGRESS_PORT,
    identify: (socket) => {
      try {
        const uid = uidOfPeer(socket)
        return uid === null ? null : projectKeyOfUid(uid)
      } catch {
        return null
      }
    },
  })
}

/**
 * What the agents' CLIs read from their home besides the logins: skills, plugins, opencode's
 * configuration, Godot's editor settings. The project home gets a copy of the server's whenever
 * it changed, checked at the first use of a project after a start.
 */
const SHARED_CONFIG = [
  '.claude/skills',
  '.claude/plugins',
  '.claude/agents',
  '.claude/commands',
  '.claude/settings.json',
  '.claude/CLAUDE.md',
  '.codex/skills',
  '.codex/plugins',
  '.codex/AGENTS.md',
  '.config/opencode',
  '.config/godot',
]
const SEED_STAMP = '.agentdeck/config-stamp'

/** A cheap fingerprint of the shared config: names and times of its first two levels. */
function configStamp(paths: string[]) {
  const parts: string[] = []
  for (const path of paths) {
    const full = join(homedir(), path)
    parts.push(`${path}:${statSync(full).mtimeMs}`)
    if (!statSync(full).isDirectory()) continue
    for (const name of readdirSync(full).sort()) {
      try {
        parts.push(`${path}/${name}:${statSync(join(full, name)).mtimeMs}`)
      } catch {}
    }
  }
  return parts.join('\n')
}

async function seedHome(user: ProjectUser) {
  const paths = SHARED_CONFIG.filter((path) => existsSync(join(homedir(), path)))
  if (!paths.length) return
  const stamp = configStamp(paths)
  // The home is the project user's, the group the server's: the server reads the stamp directly.
  const stampFile = join(user.home, SEED_STAMP)
  if (existsSync(stampFile) && readFileSync(stampFile, 'utf8') === stamp) return
  // tar runs as the server on its home and as the project user on the project home: neither
  // reads or writes the other's home.
  await new Promise<void>((resolve, reject) => {
    const pack = spawn('tar', ['-C', homedir(), '-cf', '-', '--', ...paths], { stdio: ['ignore', 'pipe', 'pipe'] })
    const unpack = spawnIn(user.home, 'tar', ['-C', user.home, '-xf', '-', '--no-same-owner'], {
      stdio: ['pipe', 'ignore', 'pipe'],
    })
    let err = ''
    pack.stderr!.on('data', (d) => (err += d))
    unpack.stderr!.on('data', (d) => (err += d))
    pack.stdout!.pipe(unpack.stdin!)
    pack.on('error', reject)
    unpack.on('error', reject)
    unpack.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.trim() || `tar ${code}`))))
  })
  await homeSync(user, ['in'], JSON.stringify([{ path: SEED_STAMP, data: Buffer.from(stamp).toString('base64'), mtime: Date.now() }]))
  console.log(`sandbox: ${user.name} got the shared CLI configuration`)
}

/** Debian packages for the agents, installed by the helper. The names are checked there again. */
export async function installPackages(names: string[]) {
  if (!SANDBOX) throw new Error('AgentDeck installs packages only in the container')
  if (!names.length || names.some((name) => !/^[a-z0-9][a-z0-9+.-]{0,62}$/.test(name)))
    throw new Error('Invalid package name')
  const { stdout, stderr } = await execFileAsync('sudo', ['-n', HELPER, 'install', ...names], {
    timeout: 15 * 60_000,
    maxBuffer: 8 * 1024 * 1024,
  })
  return `${stdout}${stderr}`.trim().split('\n').slice(-20).join('\n')
}

/**
 * The server's own files: readable by the server alone. Project users may pass through the
 * data folder to their own folders in it, nothing more.
 */
export function lockDownServerFiles(dataDir: string) {
  if (!SANDBOX) return
  // What the server creates itself is its own; project folders are handed over by the helper.
  process.umask(0o077)
  const mode = (path: string, value: number) => existsSync(path) && chmodSync(path, value)
  mode(dataDir, 0o711)
  for (const name of ['agentdeck.db', 'agentdeck.db-wal', 'agentdeck.db-shm', 'secret.key'])
    mode(join(dataDir, name), 0o600)
  for (const name of ['shots', 'tmp', 'codex-api']) mode(join(dataDir, name), 0o700)
  for (const name of ['worktrees', 'workspaces', 'rtk', 'landing']) {
    mkdirSync(join(dataDir, name), { recursive: true })
    mode(join(dataDir, name), 0o711)
  }
  mode(homedir(), 0o700)
  // Temp files of the server stay out of the shared /tmp.
  const tmp = join(dataDir, 'tmp')
  mkdirSync(tmp, { recursive: true, mode: 0o700 })
  process.env.TMPDIR = tmp
}

// ---------- CLI logins ----------

/**
 * The logins the CLIs keep in their home. The owner logs in once as the server; each run gets a
 * copy in its project's home. Only the token files come back (TOKEN_FILES): the rest can hold
 * commands (MCP servers, hooks, notify), and the server runs these CLIs as itself too.
 */
const LOGIN_FILES = ['.claude/.credentials.json', '.claude.json', '.codex/auth.json', '.codex/config.toml', '.local/share/opencode/auth.json', '.gitconfig']
const TOKEN_FILES = ['.claude/.credentials.json', '.codex/auth.json', '.local/share/opencode/auth.json']
/** gh's login, in the project home under .config/gh; GH_CONFIG_DIR of a run points there. */
const GH_FILES = ['hosts.yml', 'config.yml']
const ghDir = () => process.env.GH_CONFIG_DIR || join(homedir(), '.config', 'gh')

function readLogin(file: string, path: string) {
  try {
    return { path, data: readFileSync(file).toString('base64'), mtime: statSync(file).mtimeMs }
  } catch {
    return null
  }
}

function homeSync(user: ProjectUser, args: string[], input?: string) {
  return new Promise<string>((resolve, reject) => {
    const child = spawnIn(user.home, process.execPath, [HOME_SYNC, ...args], { stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout!.on('data', (d) => (out += d))
    child.stderr!.on('data', (d) => (err += d))
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(err.trim() || `Exit-Code ${code}`))))
    child.stdin!.end(input ?? '')
  })
}

/** Project users with a run going, and how many: a refreshed token reaches them at once. */
const runningUsers = new Map<string, { user: ProjectUser; runs: number }>()

export type LoginOptions = {
  /** Whole login folders of the server (the Codex home of an API key), copied to a path in the home. */
  extra?: { from: string; to: string }[]
  /** gh's login too. Off for projects that push with a token of their own. */
  gh?: boolean
  /** A run starts: loginsOut(cwd) follows when it ends. */
  run?: boolean
}

/** Copies the server's CLI logins into the home of the user that owns `cwd`. */
export async function loginsIn(cwd: string, { extra = [], gh = true, run = true }: LoginOptions = {}) {
  const user = ownerOf(cwd)
  if (!user) return
  const files = LOGIN_FILES.map((path) => readLogin(join(homedir(), path), path))
  if (gh) for (const name of GH_FILES) files.push(readLogin(join(ghDir(), name), join('.config', 'gh', name)))
  for (const { from, to } of extra)
    for (const name of ['auth.json', 'config.toml']) files.push(readLogin(join(from, name), join(to, name)))
  const present = files.filter(Boolean)
  if (present.length) await homeSync(user, ['in'], JSON.stringify(present))
  if (run) {
    const entry = runningUsers.get(user.name) ?? { user, runs: 0 }
    entry.runs++
    runningUsers.set(user.name, entry)
  }
}

/** A token file as a CLI writes it: a JSON object. Anything else stays in the project home. */
function isTokenFile(data: Buffer) {
  if (data.length > 256 * 1024) return false
  try {
    const value = JSON.parse(data.toString('utf8'))
    return !!value && typeof value === 'object' && !Array.isArray(value)
  } catch {
    return false
  }
}

/**
 * After a run: tokens the CLI refreshed during it replace the server's, and go on to the homes of
 * the other running projects. A refresh can make the old refresh token invalid, and a run that
 * still held it would fail at its next refresh.
 */
export async function loginsOut(cwd: string) {
  const user = ownerOf(cwd)
  if (!user) return
  const entry = runningUsers.get(user.name)
  if (entry && --entry.runs <= 0) runningUsers.delete(user.name)
  const files: { path: string; data: string; mtime: number }[] = JSON.parse(
    (await homeSync(user, ['out', ...TOKEN_FILES])) || '[]',
  )
  const refreshed: { path: string; data: string; mtime: number }[] = []
  for (const { path, data, mtime } of files) {
    if (!TOKEN_FILES.includes(path)) continue
    const content = Buffer.from(data, 'base64')
    if (!isTokenFile(content)) continue
    const file = join(homedir(), path)
    const mine = existsSync(file) ? statSync(file).mtimeMs : 0
    // A time in the future would block every later refresh.
    if (mtime <= mine || mtime > Date.now() + 60_000) continue
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    writeFileSync(file, content, { mode: 0o600 })
    utimesSync(file, new Date(), new Date(mtime))
    refreshed.push({ path, data, mtime })
  }
  if (!refreshed.length) return
  const input = JSON.stringify(refreshed)
  for (const other of runningUsers.values())
    if (other.user.name !== user.name)
      await homeSync(other.user, ['in'], input).catch((err) => console.error('sandbox logins', err.message))
}

/** Writes a private file (0600) into the home of the user that owns `cwd`. Returns nothing. */
export async function placeInHome(cwd: string, file: string, content: string) {
  const user = ownerOf(cwd)
  if (!user) throw new Error('no project user')
  const path = relative(user.home, file)
  if (path.startsWith('..')) throw new Error(`${file} is not in the project home`)
  const entry = { path, data: Buffer.from(content).toString('base64'), mtime: Date.now() }
  await homeSync(user, ['in'], JSON.stringify([entry]))
}

export async function removeFromHome(cwd: string, file: string) {
  const user = ownerOf(cwd)
  if (!user) return
  await homeSync(user, ['rm', relative(user.home, file)])
}

/** For the few synchronous calls (the mock agent): command, arguments and env as the owner of `dir`. */
export function syncCommandIn(dir: string, cmd: string, args: string[]): [string, string[], NodeJS.ProcessEnv] {
  const owner = ownerOf(dir)
  if (!owner) return [cmd, args, process.env]
  const [sudo, sudoArgs] = asUser(owner, cmd, args)
  return [sudo, [...sudoArgs], envFor(owner)]
}

/** Takes back logins a CLI refreshed during a run in `cwd`. */
/** The home the CLI of a run in `cwd` uses, for files it leaves there (Codex sessions). */
export const homeOf = (cwd: string) => ownerOf(cwd)?.home ?? homedir()
