import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono, type Context } from 'hono'
import { compress } from 'hono/compress'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { streamSSE } from 'hono/streaming'
import { createHash, timingSafeEqual } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { all, get, recoverAfterRestart, run, tx, DATA_DIR } from './db.ts'
import {
  activity,
  addComment,
  board,
  forgetBoards,
  forgetIssue,
  createIssue,
  defaultSettings,
  getIssue,
  getProject,
  mapAgent,
  mapIssue,
  mapProject,
  mergeSettings,
  EFFORTS,
  MODEL_RE,
  patchIssue,
  providerLeft,
  modelFor,
  PROVIDERS,
  STATUSES,
  subscribe,
  tierOf,
  touch,
} from './core.ts'
import {
  approveLanding,
  kick,
  landByHand,
  notices,
  pickArenaWinner,
  shutdown,
  startEngine,
  stopIssueRun,
  stopRun,
  waiting,
} from './engine.ts'
import { wakeProvider } from './recovery.ts'
import { checklistFor, itemsFromText } from './checklist.ts'
import { addLesson, deleteLesson, listLessons } from './lessons.ts'
import { createWebhook, deleteWebhook, testWebhook } from './webhooks.ts'
import { mailSettings, saveMailSettings, sendMail } from './notify.ts'
import { applyBlueprint, blueprintGuide, blueprintRequest, extractJson } from './blueprint.ts'
import { importProject } from './importer.ts'
import { oneShot } from './adapters.ts'
import { listModels } from './models.ts'
import { rtkReport } from './rtk.ts'
import { MAX_RANGE_DAYS, parseDay, projectStats } from './stats.ts'
import { agentApi } from './agentApi.ts'
import { arenaOf, startArena } from './arena.ts'
import { handleDeckMcp, type Api } from './deckMcp.ts'
import { webhookApp, webhookSecret } from './githubWebhook.ts'
import { takeGithubIssue } from './intake.ts'
import { metricsText } from './metrics.ts'
import { readClaudeUsage, startClaudeUsage } from './claudeUsage.ts'
import { startCodexUsage } from './codexUsage.ts'
import { setResetsEnabled } from './resets.ts'
import { journal } from './journal.ts'
import { buildDossier, projectFeed } from './dossier.ts'
import { RUN_EVENT_KINDS, runEvents, type RunEventKind } from './runEvents.ts'
import { startHousekeeping } from './housekeeping.ts'
import { issueChanges } from './diff.ts'
import { searchIssues } from './search.ts'
import { gitGraph } from './gitGraph.ts'
import { capOf, spentOn } from './issueCap.ts'
import { forecastView } from './forecast.ts'
import { showcaseData, showcasePage, showcaseTag } from './showcase.ts'
import { Lru } from './lru.ts'
import { limitBody, newNonce, securityHeaders, showcaseCsp } from './httpSecurity.ts'
import { clientKey, FailureLimiter } from './rateLimit.ts'
import { allows, hasOddNumber, isRole, requiredRole, roleLabel, type Role } from './roles.ts'
import {
  createUser,
  deleteUser,
  listUsers,
  noteUse,
  sessionHash,
  setUserRole,
  userByName,
  userBySession,
  userByToken,
  type User,
} from './users.ts'
import { audit, listAudit, settingsChanges } from './audit.ts'
import { isCrossSiteWrite } from './origin.ts'
import { buildOverview, killSwitch, saveGuardSettings, sinceSummary, startSpendGuard } from './overview.ts'
import { changedShellSettings, confirmedBy, confirmMode } from './reauth.ts'

import { listShots, shotsDir } from './preview.ts'
import { ensureEgress, ensureProject, installPackages, lockDownServerFiles, SANDBOX, startEgress } from './sandbox.ts'
import { egressStatus } from './egress.ts'
import { applyTemplate, listTemplates } from './templates.ts'
import {
  pushDevices,
  pushPublicKey,
  sendPush,
  subscribe as subscribePush,
  unsubscribe as unsubscribePush,
} from './push.ts'
import { buildReport, reportSettings, saveReportSettings, sendReport, startReports } from './report.ts'
import { createRoutine, deleteRoutine, listRoutines, startRoutines, updateRoutine } from './routines.ts'
import { CONNECTIONS, listConnections, setConnectionKey } from './mcp.ts'
import { MAX_OWNER_NOTE, ownerNote, saveOwnerNote } from './ownerNote.ts'
import { forProject, instanceLang, isLang, requestLang, t, tIn, withLang } from './i18n.ts'
import {
  ENVIRONMENT_KEY_SECRET,
  ensureManagedSetup,
  MANAGED,
  managedStatus,
  setManagedRunLimitUsd,
} from './managedAgent.ts'
import {
  ACCESS,
  cancelLogin,
  getAccess,
  getSecret,
  setSecret,
  SUBSCRIPTION_TOKEN,
  loginStatus,
  loginView,
  setAccess,
  startLogin,
  submitLoginCode,
} from './auth.ts'

const TOKEN = process.env.AGENTDECK_TOKEN ?? ''
const TRUST_PROXY = process.env.AGENTDECK_TRUST_PROXY === '1' // nginx + Authelia in front set Remote-User
// nginx sends this secret with every request, so a local process (an agent) cannot fake Remote-User.
const PROXY_SECRET = process.env.AGENTDECK_PROXY_SECRET ?? ''
const ALLOW_OPEN = process.env.AGENTDECK_ALLOW_OPEN === '1' || process.env.AGENTDECK_MOCK === '1'
if (TRUST_PROXY && PROXY_SECRET.length < 16) {
  console.error(
    'AGENTDECK_TRUST_PROXY=1 braucht AGENTDECK_PROXY_SECRET (mind. 16 Zeichen), das nginx als X-AgentDeck-Proxy mitsendet.',
  )
  process.exit(1)
}
if (!TOKEN && !TRUST_PROXY && !ALLOW_OPEN) {
  console.error(
    'AGENTDECK_TOKEN fehlt. Ohne Token wäre die API offen. Für lokale Tests AGENTDECK_ALLOW_OPEN=1 setzen.',
  )
  process.exit(1)
}
const fromProxy = (c: { req: { header: (n: string) => string | undefined } }) =>
  TRUST_PROXY &&
  !!c.req.header('remote-user') &&
  sameSecret(c.req.header('x-agentdeck-proxy') ?? '', PROXY_SECRET)
const app = new Hono()
// Before every route, the agent API included.
app.use('*', securityHeaders)
// Answers come in the language of the person asking.
app.use('/api/*', (c, next) => withLang(requestLang((name) => c.req.header(name)), next))
// GitHub's webhook has its own, larger limit (githubWebhook.ts).
app.use('/api/*', (c, next) => (c.req.path.startsWith('/api/github/') ? next() : limitBody(c, next)))

/**
 * In the sandbox every project gets its Linux user before anything runs in it, so the board can
 * read its repo from the start. Projects already set up are skipped without a call.
 */
function sandboxProjects() {
  if (!SANDBOX) return
  for (const project of all('SELECT key, repo_path, settings FROM projects')) {
    ensureProject(project).catch((error) => console.error(error.message))
    // After the user exists (ensureEgress waits for it): the firewall rules name its uid.
    const settings = mergeSettings(JSON.parse(project.settings || '{}'))
    ensureEgress({ key: project.key, repo_path: project.repo_path, settings })
  }
}

class HttpError extends Error {
  status: number
  /** More fields for the JSON answer, e.g. `confirm` so the UI asks for the token. */
  extra: Record<string, unknown>
  constructor(status: number, msg: string, extra: Record<string, unknown> = {}) {
    super(msg)
    this.status = status
    this.extra = extra
  }
}
const bad = (msg: string, status = 400): never => {
  throw new HttpError(status, msg)
}
app.onError((e, c) => {
  if (!(e instanceof HttpError)) console.error(e)
  return c.json({ error: e.message, ...((e as any).extra ?? {}) }, (e as any).status ?? 500)
})

// Agents authenticate with the token of their run, so their routes sit in front of the board login.
app.route('/api/agent', agentApi)
// GitHub authenticates with the webhook signature, so its route sits in front of the login too.
app.route(
  '/api/github',
  webhookApp(webhookSecret(), undefined, (payload) => {
    if (takeGithubIssue(payload).length) kick()
  }),
)

const sameSecret = (given: string, wanted: string) => {
  const a = Buffer.from(given)
  const b = Buffer.from(wanted)
  return a.length === b.length && timingSafeEqual(a, b)
}

// The browser keeps a hash of the token in a cookie, so the token itself is typed once and not stored.
const SESSION_COOKIE = 'agentdeck_session'
const SESSION_VALUE = createHash('sha256').update(`agentdeck-session:${TOKEN}`).digest('hex')

// Failed attempts with the raw board token, per client and overall.
const tokenGuesses = new FailureLimiter()
const guesser = (c: Context) =>
  clientKey(c, TRUST_PROXY && sameSecret(c.req.header('x-agentdeck-proxy') ?? '', PROXY_SECRET))
const tooMany = (c: Context, wait: number) => {
  c.header('retry-after', String(wait))
  return c.json({ error: t('Zu viele Fehlversuche. Bitte in {wait} s erneut versuchen.', { wait }) }, 429)
}

type Who = { name: string; role: Role }
// Set by the login check for every API request that passed it.
const whoOf = new WeakMap<Request, Who>()
// A proxy user without an entry in the users table gets this role. Admin by default: before
// roles existed, everyone the proxy let in could do everything.
const PROXY_ROLE: Role = isRole(process.env.AGENTDECK_PROXY_ROLE) ? process.env.AGENTDECK_PROXY_ROLE : 'admin'

/** Who made a change, for the audit log. */
const actor = (c: Context) =>
  whoOf.get(c.req.raw)?.name ?? ((fromProxy(c) && String(c.req.header('remote-user')).slice(0, 60)) || 'Owner')


app.post('/api/login', async (c) => {
  const client = guesser(c)
  const wait = tokenGuesses.retryAfter(client)
  if (wait) return tooMany(c, wait)
  const given = String((await c.req.json().catch(() => ({}))).token ?? '')
  const owner = !!TOKEN && sameSecret(given, TOKEN)
  const user = owner ? undefined : userByToken(given)
  if (!owner && !user) {
    tokenGuesses.fail(client)
    audit(actor(c), 'login.failed', client)
    return c.json({ error: t('Token stimmt nicht') }, 401)
  }
  audit(user?.name ?? 'Owner', 'login', client)

  // The cookie holds a hash of the token; for a user it is the hash the users table keeps.
  setCookie(c, SESSION_COOKIE, owner ? SESSION_VALUE : sessionHash(given), {
    httpOnly: true,
    sameSite: 'Strict',
    secure: c.req.header('x-forwarded-proto') === 'https',
    path: '/',
    maxAge: 60 * 60 * 24 * 30,
  })
  return c.json({ ok: true })
})

// The showcase is public on purpose: it shows what the owner chose to show, and nothing else.
// The page asks every 10 s; mostly nothing changed, and then the answer is a 304 without a query.
app.get('/api/public/:slug', (c) => {
  const slug = c.req.param('slug')
  const tag = showcaseTag(slug)
  // no-cache: the browser keeps the answer but asks each time, sending the tag along.
  if (tag && c.req.header('if-none-match') === tag) return c.body(null, 304, { etag: tag, 'cache-control': 'no-cache' })
  const data = showcaseData(slug)
  if (!data) return c.json({ error: t('nicht gefunden') }, 404)
  if (tag) c.header('etag', tag)
  c.header('cache-control', 'no-cache')
  return c.json(data)
})
app.get('/show/:slug', (c) => {
  const slug = c.req.param('slug')
  if (!/^[\w-]{8,40}$/.test(slug)) return c.notFound()
  const nonce = newNonce()
  return c.html(showcasePage(slug, nonce), 200, { 'content-security-policy': showcaseCsp(nonce) })
})

/**
 * Who is asking: the owner with the board token (cookie or Bearer), a user with their own token,
 * or the proxy's user. Null when nobody; a Response when the client is guessing too fast.
 */
function identify(c: Context): Who | Response | null {
  if (!TOKEN && !TRUST_PROXY) return { name: 'Owner', role: 'admin' }
  // Without a board token there is no cookie and no Bearer login for it: an empty token would
  // match "Bearer " and a cookie anyone can compute, and so skip the proxy login.
  const cookie = getCookie(c, SESSION_COOKIE) ?? ''
  if (TOKEN && sameSecret(cookie, SESSION_VALUE)) return { name: 'Owner', role: 'admin' }
  const sessionUser = userBySession(cookie)
  if (sessionUser) return sessionUser
  if (fromProxy(c)) {
    const name = String(c.req.header('remote-user')).slice(0, 60)
    return { name, role: userByName(name)?.role ?? PROXY_ROLE }
  }
  const header = c.req.header('authorization') ?? ''
  if (header.startsWith('Bearer ') && header.length > 7) {
    const client = guesser(c)
    const wait = tokenGuesses.retryAfter(client)
    if (wait) return tooMany(c, wait)
    const given = header.slice(7)
    if (TOKEN && sameSecret(given, TOKEN)) return { name: 'Owner', role: 'admin' }
    const user = userByToken(given)
    if (user) return user
    tokenGuesses.fail(client)
  }
  return null
}

// A page on another site must not be able to write through the owner's logged-in browser.
app.use('/api/*', async (c, next) => {
  if (c.req.path.startsWith('/api/github/')) return next()
  if (isCrossSiteWrite(c.req.method, (name) => c.req.header(name))) return c.json({ error: t('Fremde Herkunft') }, 403)
  return next()
})

app.use('/api/*', async (c, next) => {
  if (c.req.path.startsWith('/api/public/')) return next()
  if (hasOddNumber(c.req.path)) return c.json({ error: t('ungültige id') }, 400)
  const who = identify(c)
  if (who instanceof Response) return who
  if (!who) return c.json({ error: 'unauthorized' }, 401)
  if ('id' in who) noteUse(who as User)
  const reads = c.req.method === 'GET' || c.req.method === 'HEAD'
  // Parsed once here only where the rule depends on it; Hono keeps it for the route.
  const body = !reads && /^\/api\/projects\/\d+$/.test(c.req.path) ? await c.req.json().catch(() => null) : undefined
  const needs = requiredRole(c.req.method, c.req.path, body)
  if (!allows(who.role, needs)) {
    const error = t('Dafür fehlt die Berechtigung ({needs} nötig, du hast {has}).', {
      needs: roleLabel(needs),
      has: roleLabel(who.role),
    })
    return c.json({ error }, 403)
  }
  whoOf.set(c.req.raw, who)
  return next()
})
// The event stream must not be buffered, and the board ships its own cached gzip.
const skipsCompression = (path: string) => path === '/api/events' || path.endsWith('/board')
app.use('/api/*', (c, next) => (skipsCompression(c.req.path) ? next() : compress()(c, next)))

app.post('/api/logout', (c) => {
  deleteCookie(c, SESSION_COOKIE, { path: '/' })
  audit(actor(c), 'logout', guesser(c))
  return c.json({ ok: true })
})

const CONFIRM = confirmMode(TOKEN, TRUST_PROXY)

/**
 * Settings the server runs as shell commands change only with the board token in the same
 * request (reauth.ts). Throws 403 with `confirm: true`, so the UI asks for the token and retries.
 */
function confirmShellChange(c: Context, b: any, target: string, changed: string[]) {
  if (!changed.length || CONFIRM === 'open') return
  // A user confirms with their own token: it proves the same as the board token does for the owner.
  const who = whoOf.get(c.req.raw)
  if (who && 'id' in who && allows(who.role, 'admin')) {
    const bearer = c.req.header('authorization') ?? ''
    const given = typeof b?.confirmToken === 'string' ? b.confirmToken : bearer.startsWith('Bearer ') ? bearer.slice(7) : ''
    if ((userByToken(given) as User | undefined)?.id === (who as User).id) return
  }
  if (CONFIRM === 'refused') {
    audit(actor(c), 'confirm.refused', target, { fields: changed })
    bad(
      t('Befehle lassen sich hinter dem Proxy nur ändern, wenn auf dem Server auch AGENTDECK_TOKEN gesetzt ist.'),
      403,
    )
  }
  const client = guesser(c)
  const wait = tokenGuesses.retryAfter(client)
  if (wait) {
    c.header('retry-after', String(wait))
    bad(t('Zu viele Fehlversuche. Bitte in {wait} s erneut versuchen.', { wait }), 429)
  }
  if (confirmedBy(TOKEN, b?.confirmToken, c.req.header('authorization'))) return
  const given = typeof b?.confirmToken === 'string' && b.confirmToken !== ''
  // Asking without a token is the normal first step of the dialog; only a wrong token is a guess.
  if (given) {
    tokenGuesses.fail(client)
    audit(actor(c), 'confirm.failed', target, { fields: changed })
  }
  throw new HttpError(
    403,
    given
      ? t('Das Token stimmt nicht.')
      : t('Diese Änderung betrifft Befehle, die der Server ausführt. Bitte mit dem Zugangs-Token bestätigen.'),
    { confirm: true, fields: changed },
  )
}

/** Shell settings a blueprint would change: on a new project, or merged into an existing one. */
function blueprintShellChanges(pj: any) {
  if (!pj || typeof pj !== 'object' || !pj.settings || typeof pj.settings !== 'object') return []
  const existing = get('SELECT settings FROM projects WHERE key=?', s(pj.key, 8).toUpperCase())
  if (!existing) return changedShellSettings(null, pj.settings)
  const stored = JSON.parse(existing.settings || '{}')
  return changedShellSettings(mergeSettings(stored), { ...stored, ...pj.settings })
}

app.get('/api/audit', (c) => c.json(listAudit(c.req.query('limit'), c.req.query('before'))))

// ---------- users & roles ----------
app.get('/api/me', (c) => {
  const who = whoOf.get(c.req.raw)!
  return c.json({ name: who.name, role: who.role })
})
app.get('/api/users', (c) => c.json(listUsers()))
app.post('/api/users', async (c) => {
  const b = await body(c)
  let created
  try {
    created = createUser(s(b.name, 60), b.role)
  } catch (e: any) {
    return bad(e.message)
  }
  audit(actor(c), 'user.create', created.user.name, { role: created.user.role })
  // The token leaves the server this once; only its hashes stay.
  return c.json(created, 201)
})
app.patch('/api/users/:id', async (c) => {
  const b = await body(c)
  try {
    if (!setUserRole(id(c), b.role)) bad(t('nicht gefunden'), 404)
  } catch (e: any) {
    if (e instanceof HttpError) throw e
    bad(e.message)
  }
  audit(actor(c), 'user.role', String(id(c)), { role: b.role })
  return c.json({ ok: true })
})
app.delete('/api/users/:id', (c) => {
  if (!deleteUser(id(c))) bad(t('nicht gefunden'), 404)
  audit(actor(c), 'user.delete', String(id(c)))
  return c.json({ ok: true })
})

// Plain digits only: Number() would also read "0x1" or "1e0", which the role rules do not match.
const id = (c: any, name = 'id') => {
  const raw = String(c.req.param(name) ?? '')
  return /^[1-9]\d{0,15}$/.test(raw) ? Number(raw) : bad(t('ungültige id'))
}
const body = async (c: any) => (await c.req.json().catch(() => null)) ?? bad(t('JSON erwartet'))
const s = (v: any, max = 20000) => String(v ?? '').slice(0, max)
/** What the server writes on an issue is read in its project later: it is written in that language. */
const inProject = <T>(issue: { project_id: number } | undefined, work: () => T): T =>
  forProject(issue && getProject(issue.project_id), work)

// Screenshots are written once and read often (board, issue page, every reviewer): kept in RAM.
const shots = new Lru<{ data: Uint8Array<ArrayBuffer>; etag: string }>({
  maxEntries: 400,
  maxSize: 64 * 1024 * 1024,
  sizeOf: (shot) => shot.data.length,
})
function readShot(path: string) {
  let stat
  try {
    stat = statSync(path)
  } catch {
    return undefined
  }
  const etag = `"${stat.size.toString(36)}-${Math.round(stat.mtimeMs).toString(36)}"`
  const cached = shots.get(path)
  if (cached?.etag === etag) return cached
  const shot = { data: readFileSync(path) as Uint8Array<ArrayBuffer>, etag }
  shots.set(path, shot)
  return shot
}

// ---------- AgentDeck as an MCP server ----------
// Marks a call that came in through the MCP endpoint, so an issue filed there says so.
const VIA_HEADER = 'x-agentdeck-via'
const LOGIN_HEADERS = ['authorization', 'cookie', 'remote-user', 'x-agentdeck-proxy', 'x-real-ip']

/** The MCP tools call the board's own routes with the login of whoever called the endpoint. */
app.all('/api/mcp-server', (c) => {
  const headers: Record<string, string> = { 'content-type': 'application/json', [VIA_HEADER]: 'mcp' }
  // With the language header too: a client that asks for a language gets the routes' answers in it.
  for (const name of [...LOGIN_HEADERS, 'x-agentdeck-lang']) {
    const value = c.req.header(name)
    if (value) headers[name] = value
  }
  const api: Api = async (method, path, payload) =>
    app.request(path, { method, headers, body: payload === undefined ? undefined : JSON.stringify(payload) })
  return handleDeckMcp(c.req.raw, api)
})

// ---------- meta & projects ----------
app.get('/api/meta', (c) =>
  c.json({
    providers: Object.entries(PROVIDERS).map(([k, v]) => ({ id: k, label: v.label })),
    statuses: STATUSES,
    blueprintGuide: blueprintGuide(),
  }),
)

// ---------- mission control ----------
app.get('/api/metrics', (c) => c.text(metricsText(), 200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' }))
app.get('/api/overview', (c) => c.json(buildOverview()))
app.get('/api/overview/since', (c) => c.json(sinceSummary(Number(c.req.query('t')))))
app.put('/api/spend-guard', async (c) => {
  const input = await body(c)
  try {
    const saved = saveGuardSettings(input)
    audit(actor(c), 'spend-guard.set', '', { capUsd: saved.capUsd })
    return c.json(saved)
  } catch (e: any) {
    bad(e.message)
  }
})
app.post('/api/kill-switch', async (c) => {
  const action = (await body(c)).action
  if (action !== 'stop' && action !== 'resume') bad(t('action: stop oder resume'))
  try {
    const result = killSwitch(action, actor(c))
    audit(actor(c), `kill-switch.${action}`, '', result)
    return c.json(result)
  } catch (e: any) {
    bad(e.message, 409)
  }
})

app.get('/api/projects', (c) =>
  c.json(
    all(`SELECT p.id, p.key, p.name, p.paused,
    (SELECT COUNT(*) FROM issues i WHERE i.project_id=p.id AND i.status!='done') AS open,
    (SELECT COUNT(*) FROM runs r WHERE r.project_id=p.id AND r.status='running') AS running
    FROM projects p ORDER BY p.name`),
  ),
)

app.post('/api/projects', async (c) => {
  const b = await body(c)
  const key = s(b.key, 8).toUpperCase()
  if (get('SELECT 1 FROM projects WHERE key=?', key)) bad(t('Projekt-Key existiert bereits'), 409)
  confirmShellChange(c, b, key, blueprintShellChanges(b))
  let r: any
  try {
    r = applyBlueprint({ project: b })
  } catch (e: any) {
    bad(e.message)
  }
  audit(actor(c), 'project.create', key)
  sandboxProjects()
  return c.json(getProject(r.projectId), 201)
})

app.get('/api/projects/:id/board', (c) => {
  const cached = board(id(c)) ?? bad(t('nicht gefunden'), 404)
  const headers: Record<string, string> = { 'content-type': 'application/json', vary: 'accept-encoding' }
  if (!(c.req.header('accept-encoding') ?? '').includes('gzip')) return c.body(cached.json, 200, headers)
  return c.body(new Uint8Array(cached.gzip), 200, { ...headers, 'content-encoding': 'gzip' })
})

app.patch('/api/projects/:id', async (c) => {
  const pid = id(c)
  const b = await body(c)
  const p = getProject(pid) ?? bad(t('nicht gefunden'), 404)
  confirmShellChange(c, b, p.key, changedShellSettings(p.settings, b.settings ?? p.settings))
  const next = {
    name: s(b.name ?? p.name, 120),
    description: s(b.description ?? p.description, 4000),
    repo_path: s(b.repo_path ?? p.repo_path, 500),
    paused: !!(b.paused ?? p.paused),
    settings: mergeSettings(b.settings ?? p.settings),
  }
  run(
    'UPDATE projects SET name=?, description=?, repo_path=?, paused=?, settings=? WHERE id=?',
    next.name,
    next.description,
    next.repo_path,
    next.paused ? 1 : 0,
    JSON.stringify(next.settings),
    pid,
  )
  const before = {
    name: p.name,
    description: p.description,
    repo_path: p.repo_path,
    paused: p.paused,
    settings: p.settings,
  }
  const changes = settingsChanges(before, next)
  if (Object.keys(changes).length) audit(actor(c), 'project.update', p.key, changes)
  touch(pid)
  sandboxProjects()
  kick()
  return c.json(getProject(pid))
})

/** Whether the allowlist is enforced, and what it refused lately (settings page). */
app.get('/api/projects/:id/egress', (c) => {
  const project = getProject(id(c)) ?? bad(t('nicht gefunden'), 404)
  return c.json({ sandbox: SANDBOX, ...egressStatus(project.key) })
})

app.delete('/api/projects/:id', (c) => {
  const pid = id(c)
  const p = getProject(pid) ?? bad(t('nicht gefunden'), 404)
  forProject(p, () => {
    for (const r of all("SELECT id FROM runs WHERE project_id=? AND status='running'", pid))
      stopRun(r.id, t('Projekt gelöscht'), 'backlog', 'System')
  })
  for (const hook of getProject(pid)?.settings.webhooks ?? []) deleteWebhook(hook.id)
  run('DELETE FROM projects WHERE id=?', pid)
  audit(actor(c), 'project.delete', p.key, { name: p.name })
  forgetBoards(pid)
  touch(pid)
  return c.json({ ok: true })
})

// ---------- agents & skills ----------
/** Fields that were added after the first release and are saved on their own. */
function saveAgentExtras(agentId: number, b: any) {
  if (Array.isArray(b.mcp_ids)) {
    const ids = b.mcp_ids.filter((id: string) => CONNECTIONS[id])
    run('UPDATE agents SET mcp_ids=? WHERE id=?', JSON.stringify(ids), agentId)
  }
  if (typeof b.effort === 'string') {
    if (!EFFORTS.includes(b.effort)) bad(t('unbekannte Effort-Stufe'))
    run('UPDATE agents SET effort=? WHERE id=?', b.effort, agentId)
  }
}

/** The agent fields a request touched, for the audit log (names only, the instructions stay out). */
const AGENT_FIELDS = [
  ...['name', 'role', 'provider', 'model', 'provider_override', 'instructions'],
  ...['skill_ids', 'max_instances', 'enabled', 'mcp_ids', 'effort'],
]
const agentAudit = (b: any) => ({ fields: AGENT_FIELDS.filter((field) => field in b) })
const projectKey = (pid: number) => get('SELECT key FROM projects WHERE id=?', pid)?.key ?? String(pid)

function agentFields(b: any, cur: any = {}) {
  const provider = b.provider ?? cur.provider ?? 'anthropic'
  if (!Object.hasOwn(PROVIDERS, provider)) bad(t('unbekannter Provider'))
  const model = s(b.model ?? cur.model ?? '', 80)
  if (!MODEL_RE.test(model)) bad(t('ungültiger Modellname'))
  if (b.provider_override !== undefined && typeof b.provider_override !== 'boolean')
    bad(t('ungültiger Anbieter-Override'))
  // Older API clients set a direct override by changing the existing agent's provider or model.
  const override = b.provider_override ?? (cur.provider_override ||
    (cur.id != null && (provider !== cur.provider || model !== cur.model)))
  const name = s(b.name ?? cur.name, 80).trim() || bad(t('Name fehlt'))
  return [
    name,
    s(b.role ?? cur.role ?? '', 200),
    provider,
    model,
    s(b.instructions ?? cur.instructions ?? ''),
    JSON.stringify((b.skill_ids ?? cur.skill_ids ?? []).map(Number).filter(Boolean)),
    Math.max(1, Math.min(20, Number(b.max_instances ?? cur.max_instances ?? 1) || 1)),
    (b.enabled ?? cur.enabled ?? true) ? 1 : 0,
    override ? 1 : 0,
  ]
}
app.post('/api/projects/:id/agents', async (c) => {
  const pid = id(c)
  getProject(pid) ?? bad(t('nicht gefunden'), 404)
  const b = await body(c)
  const r = run(
    'INSERT INTO agents (name, role, provider, model, instructions, skill_ids, max_instances, enabled, provider_override, project_id) VALUES (?,?,?,?,?,?,?,?,?,?)',
    ...agentFields(b),
    pid,
  )
  saveAgentExtras(Number(r.lastInsertRowid), b)
  audit(actor(c), 'agent.create', `${projectKey(pid)}/${s(b.name, 80)}`, agentAudit(b))
  touch(pid)
  kick()
  return c.json(mapAgent(get('SELECT * FROM agents WHERE id=?', r.lastInsertRowid)), 201)
})
app.patch('/api/agents/:id', async (c) => {
  const cur = mapAgent(get('SELECT * FROM agents WHERE id=?', id(c))) ?? bad(t('nicht gefunden'), 404)
  const b = await body(c)
  run(
    'UPDATE agents SET name=?, role=?, provider=?, model=?, instructions=?, skill_ids=?, max_instances=?, enabled=?, provider_override=? WHERE id=?',
    ...agentFields(b, cur),
    cur.id,
  )
  saveAgentExtras(cur.id, b)
  audit(actor(c), 'agent.update', `${projectKey(cur.project_id)}/${cur.name}`, agentAudit(b))
  touch(cur.project_id)
  kick()
  return c.json(mapAgent(get('SELECT * FROM agents WHERE id=?', cur.id)))
})
/**
 * Moves agents to another provider in one go. Each keeps its tier (strong, medium, light), so the
 * team stays the same shape. `dryRun` only returns the plan; running runs finish on the old one.
 */
app.post('/api/projects/:id/switch-provider', async (c) => {
  const project = getProject(id(c)) ?? bad(t('nicht gefunden'), 404)
  const b = await body(c)
  const provider = String(b.provider ?? '')
  if (!PROVIDERS[provider]) bad(t('Unbekannter Anbieter'))
  const only = Array.isArray(b.agent_ids) ? b.agent_ids.map(Number) : null
  const tiers = project.settings.modelTiers
  const plan = all('SELECT * FROM agents WHERE project_id=?', project.id)
    .map(mapAgent)
    .filter((agent) => !only || only.includes(agent.id))
    .map((agent) => {
      const tier = tierOf(tiers, agent.provider, agent.model)
      return {
        agent_id: agent.id,
        name: agent.name,
        tier,
        from: { provider: agent.provider, model: agent.model },
        to: { provider, model: agent.provider === provider ? agent.model : modelFor(tiers, tier, provider) },
      }
    })
  if (!b.dryRun) {
    for (const step of plan)
      run('UPDATE agents SET provider=?, model=?, provider_override=1 WHERE id=?', step.to.provider, step.to.model, step.agent_id)
    audit(actor(c), 'agent.switch-provider', project.key, { provider, agents: plan.map((step) => step.name) })
    touch(project.id)
    kick()
  }
  return c.json({ plan })
})
app.delete('/api/agents/:id', (c) => {
  const cur = get('SELECT * FROM agents WHERE id=?', id(c)) ?? bad(t('nicht gefunden'), 404)
  forProject(getProject(cur.project_id), () => {
    for (const r of all("SELECT id FROM runs WHERE agent_id=? AND status='running'", cur.id))
      stopRun(r.id, t('Agent gelöscht'), 'todo', 'System')
  })
  run('DELETE FROM agents WHERE id=?', cur.id)
  audit(actor(c), 'agent.delete', `${projectKey(cur.project_id)}/${cur.name}`)
  touch(cur.project_id)
  return c.json({ ok: true })
})

app.post('/api/projects/:id/skills', async (c) => {
  const pid = id(c)
  getProject(pid) ?? bad(t('nicht gefunden'), 404)
  const b = await body(c)
  const r = run(
    'INSERT INTO skills (project_id, name, description, content) VALUES (?,?,?,?)',
    pid,
    s(b.name, 80).trim() || bad(t('Name fehlt')),
    s(b.description, 400),
    s(b.content),
  )
  audit(actor(c), 'skill.create', `${projectKey(pid)}/${s(b.name, 80)}`)
  touch(pid)
  return c.json(get('SELECT * FROM skills WHERE id=?', r.lastInsertRowid), 201)
})
app.patch('/api/skills/:id', async (c) => {
  const cur = get('SELECT * FROM skills WHERE id=?', id(c)) ?? bad(t('nicht gefunden'), 404)
  const b = await body(c)
  run(
    'UPDATE skills SET name=?, description=?, content=? WHERE id=?',
    s(b.name ?? cur.name, 80),
    s(b.description ?? cur.description, 400),
    s(b.content ?? cur.content),
    cur.id,
  )
  audit(actor(c), 'skill.update', `${projectKey(cur.project_id)}/${cur.name}`)
  touch(cur.project_id)
  return c.json(get('SELECT * FROM skills WHERE id=?', cur.id))
})
app.delete('/api/skills/:id', (c) => {
  const cur = get('SELECT * FROM skills WHERE id=?', id(c)) ?? bad(t('nicht gefunden'), 404)
  run('DELETE FROM skills WHERE id=?', cur.id)
  audit(actor(c), 'skill.delete', `${projectKey(cur.project_id)}/${cur.name}`)
  touch(cur.project_id)
  return c.json({ ok: true })
})

// ---------- issues ----------
app.get('/api/projects/:id/issues', (c) =>
  c.json(
    all(
      `SELECT id, number, title, description, status, priority, assignee_id, grp, blocked_by, reviewers, created_by
       FROM issues WHERE project_id=? ORDER BY number`,
      id(c),
    ).map(mapIssue),
  ),
)

app.post('/api/projects/:id/issues', async (c) => {
  const pid = id(c)
  const b = await body(c)
  const title = s(b.title, 300).trim() || bad(t('Titel fehlt'))
  const issue = tx(() =>
    createIssue(pid, {
      ...b,
      title,
      description: s(b.description),
      checklist: checklistInput(b.checklist),
      created_by: c.req.header(VIA_HEADER) === 'mcp' ? 'Owner (MCP)' : 'Owner',
    }),
  )
  kick()
  return c.json(issue, 201)
})

/** A checklist from the board: a list of items or text with one item per line. */
const checklistInput = (value: unknown) => itemsFromText(Array.isArray(value) ? value.join('\n') : value)

/**
 * Gives open issues without a checklist the one they would get at their next start, see
 * checklist.ts. Without `apply` it only lists what it would do. Issues in progress or in review
 * are left alone, so no running review changes its measure halfway.
 */
app.post('/api/projects/:id/checklists/fill', async (c) => {
  const p = getProject(id(c)) ?? bad(t('nicht gefunden'), 404)
  const b = await body(c)
  const agents = all('SELECT id, name FROM agents WHERE project_id=?', p.id)
  const open = all(
    `SELECT * FROM issues WHERE project_id=? AND status IN ('backlog','todo','blocked') AND checklist='[]'
     ORDER BY number`,
    p.id,
  ).map(mapIssue)
  const planned = open
    .map((issue) => {
      const agent = agents.find((a) => a.id === (issue.maker_id ?? issue.assignee_id))
      return {
        issue,
        agent: agent?.name ?? '',
        ...checklistFor(issue, agent?.name ?? '', p.settings.checklists.templates),
      }
    })
    .filter((plan) => plan.items.length)
  if (b.apply) {
    tx(() => {
      for (const plan of planned) patchIssue(plan.issue.id, { checklist: plan.items }, 'Owner')
    })
  }
  return c.json(
    planned.map((plan) => ({
      key: `${p.key}-${plan.issue.number}`,
      title: plan.issue.title,
      status: plan.issue.status,
      agent: plan.agent,
      template: plan.template,
      items: plan.items,
    })),
  )
})

app.get('/api/issues/:id/spent', (c) => {
  const issue = getIssue(id(c)) ?? bad(t('nicht gefunden'), 404)
  const cap = getProject(issue.project_id).settings.issueCap
  return c.json({ spent: spentOn(issue.id), cap: capOf(cap, issue.cap_factor), capped: !!issue.capped })
})
/** Expected cost from similar finished issues (forecast.ts). */
app.get('/api/issues/:id/forecast', (c) => c.json(forecastView(id(c)) ?? bad(t('nicht gefunden'), 404)))
app.post('/api/issues/:id/raise-cap', (c) => {
  const issue = getIssue(id(c)) ?? bad(t('nicht gefunden'), 404)
  inProject(issue, () =>
    addComment(issue.id, 'System', 'system', t('Weitere Runde des Kosten-Deckels freigegeben.')),
  )
  patchIssue(issue.id, {
    cap_factor: issue.cap_factor + 1,
    capped: 0,
    ...(issue.capped && issue.status === 'backlog' ? { status: 'todo' } : {}),
  })
  kick()
  return c.json({ ok: true })
})

app.post('/api/issues/:id/approve-landing', async (c) => {
  const issue = getIssue(id(c)) ?? bad(t('nicht gefunden'), 404)
  const sha = s((await body(c)).sha, 64)
  if (!/^[0-9a-f]{40,64}$/.test(sha)) bad(t('ungültiger Stand'))
  await approveLanding(issue.id, sha, actor(c)).catch((e) => bad(e.message, 409))
  kick()
  return c.json({ ok: true })
})

app.get('/api/issues/:id/changes', async (c) => {
  const issue = getIssue(id(c)) ?? bad(t('nicht gefunden'), 404)
  return c.json(await issueChanges(getProject(issue.project_id), issue.number))
})
app.get('/api/issues/:id/dossier', (c) => c.json(buildDossier(id(c)) ?? bad(t('nicht gefunden'), 404)))
app.get('/api/projects/:id/feed', (c) => {
  const project = getProject(id(c)) ?? bad(t('nicht gefunden'), 404)
  const since = Number(c.req.query('since')) || 0
  const limit = Number(c.req.query('limit')) || 150
  // Targets the egress proxy refused: no run is known for them, so they stand for the project.
  const refused = egressStatus(project.key)
    .blocked.filter((b) => b.at > since)
    .map((b, n) => ({
      runId: 0, seq: -1 - n, at: b.at, kind: 'network', name: t('blockiert'),
      text: t('Zugriff auf {target} verweigert', { target: b.target }),
      agent: t('Netzwerk'), issue: 0, title: '',
    }))
  return c.json([...projectFeed(project.id, since, limit), ...refused].sort((a, b) => b.at - a.at).slice(0, limit))
})
app.get('/api/issues/:id/shots', (c) => c.json(listShots(id(c))))
app.get('/api/issues/:id/shots/:file', async (c) => {
  const file = c.req.param('file')
  if (!/^\d+-(desktop|phone)\.png$/.test(file)) bad(t('ungültige Datei'))
  const shot = readShot(`${shotsDir(id(c))}/${file}`) ?? bad(t('nicht gefunden'), 404)
  const headers = { etag: shot.etag, 'cache-control': 'private, max-age=86400' }
  if (c.req.header('if-none-match') === shot.etag) return c.body(null, 304, headers)
  return c.body(shot.data, 200, { ...headers, 'content-type': 'image/png' })
})

const LINK_COLUMNS = 'i.id, i.number, i.title, i.status, i.assignee_id'

app.get('/api/issues/:id', (c) => {
  const issue = getIssue(id(c)) ?? bad(t('nicht gefunden'), 404)
  const blockers = issue.blocked_by.length
    ? all(
        `SELECT ${LINK_COLUMNS} FROM issues i WHERE i.project_id=? AND i.number IN (${issue.blocked_by.map(() => '?').join(',')})
         ORDER BY i.number`,
        issue.project_id,
        ...issue.blocked_by,
      )
    : []
  // blocked_by is a JSON array; json_each finds the issues that list this one.
  const dependents = all(
    `SELECT ${LINK_COLUMNS} FROM issues i, json_each(i.blocked_by) j
     WHERE i.project_id=? AND j.value=? ORDER BY i.number`,
    issue.project_id,
    issue.number,
  )
  return c.json({
    issue,
    comments: all('SELECT * FROM comments WHERE issue_id=? ORDER BY id', issue.id),
    runs: all('SELECT * FROM runs WHERE issue_id=? ORDER BY id', issue.id),
    events: all(
      'SELECT id, at, actor, field, old, new FROM issue_events WHERE issue_id=? ORDER BY id',
      issue.id,
    ),
    links: { blockers, dependents },
    arena: arenaOf(issue) ?? null,
  })
})

// ---------- arena: several agents on one issue, a jury picks ----------
app.get('/api/issues/:id/arena', (c) => c.json(arenaOf(getIssue(id(c)) ?? bad(t('nicht gefunden'), 404)) ?? null))
app.post('/api/issues/:id/arena', async (c) => {
  const b = await body(c)
  try {
    const entries = startArena(id(c), b.agents, actor(c))
    kick()
    return c.json(
      { entries: entries.map((entry) => ({ id: entry.id, number: entry.number, agent: entry.agent })) },
      201,
    )
  } catch (e: any) {
    bad(e.message, 409)
  }
})
app.post('/api/issues/:id/arena/pick', async (c) => {
  const b = await body(c)
  try {
    pickArenaWinner(id(c), Number(b.entry), '', actor(c))
    return c.json({ ok: true })
  } catch (e: any) {
    bad(e.message, 409)
  }
})

app.patch('/api/issues/:id', async (c) => {
  const cur = getIssue(id(c)) ?? bad(t('nicht gefunden'), 404)
  const b = await body(c)
  const patch: Record<string, any> = {}
  if ('title' in b) patch.title = s(b.title, 300).trim() || bad(t('Titel fehlt'))
  if ('description' in b) patch.description = s(b.description)
  if ('priority' in b) patch.priority = Math.max(0, Math.min(3, Number(b.priority) || 0))
  if ('rank' in b) patch.rank = Number(b.rank) || 0
  if ('assignee_id' in b) patch.assignee_id = b.assignee_id ? Number(b.assignee_id) : null
  if ('blocked_by' in b)
    patch.blocked_by = (Array.isArray(b.blocked_by) ? b.blocked_by : [])
      .map(Number)
      .filter((n: number) => n && n !== cur.number)
  if ('grp' in b) patch.grp = s(b.grp, 80).trim()
  if ('checklist' in b) patch.checklist = checklistInput(b.checklist)
  if ('model' in b) {
    patch.model = s(b.model, 80).trim()
    if (!MODEL_RE.test(patch.model)) bad(t('ungültiger Modellname'))
  }
  if ('reviewers' in b) {
    const known = new Set(all('SELECT id FROM agents WHERE project_id=?', cur.project_id).map((a) => a.id))
    patch.reviewers = (Array.isArray(b.reviewers) ? b.reviewers : [])
      .map(Number)
      .filter((a: number) => known.has(a))
  }
  if ('status' in b && b.status !== cur.status) {
    if (!STATUSES.includes(b.status)) bad(t('unbekannter Status'))
    // "in progress" is owned by the scheduler: a human moving a card there means "start it".
    patch.status = b.status === 'in_progress' ? 'todo' : b.status
    // Pulling an issue out of a running review by hand ends that review: it goes back to its maker.
    const leavesReview = cur.review_index >= 0 && patch.status !== 'review' && patch.status !== 'blocked'
    if (leavesReview) {
      patch.review_index = -1
      patch.review_rounds = 0
      if (!('assignee_id' in patch) && cur.maker_id) patch.assignee_id = cur.maker_id
    }
  }
  // Moving a capped issue back into the queue grants it another round of the project's cap.
  if (cur.capped && ['todo', 'review'].includes(patch.status)) {
    // Another round costs money: the same decision as raise-cap, so the same role.
    if (!allows(whoOf.get(c.req.raw)?.role ?? 'viewer', 'admin')) bad(t('Nur wer verwaltet, darf das Kostenlimit erhöhen.'), 403)
    patch.cap_factor = cur.cap_factor + 1
    patch.capped = 0
  }
  // Moving an issue held at an approval gate anywhere else ends the wait for the approval. Moved
  // to done, it is landed again and held again unless the owner approved it.
  if (cur.landing === 'approval' && patch.status && patch.status !== 'blocked') {
    patch.landing = ''
    patch.gate_sha = ''
  }
  // Moving a parked issue back into the queue by hand ends its rest.
  if (cur.parked_until && ['todo', 'review'].includes(patch.status)) patch.parked_until = 0
  const issue = patchIssue(cur.id, patch, actor(c))
  if (patch.status === 'done') landByHand(cur.id)
  if (
    cur.status === 'in_progress' &&
    (patch.status || ('assignee_id' in patch && patch.assignee_id !== cur.assignee_id))
  )
    inProject(cur, () =>
      stopIssueRun(cur.id, t('Lauf gestoppt, Issue wurde manuell geändert.'), patch.status ?? 'todo', 'System'),
    )
  kick()
  return c.json(issue)
})

app.delete('/api/issues/:id', (c) => {
  const cur = getIssue(id(c)) ?? bad(t('nicht gefunden'), 404)
  inProject(cur, () => stopIssueRun(cur.id, t('Issue gelöscht'), 'backlog', 'System'))
  run('DELETE FROM issues WHERE id=?', cur.id)
  forgetIssue(cur.project_id, cur.id)
  touch(cur.project_id)
  return c.json({ ok: true })
})

app.post('/api/issues/:id/comments', async (c) => {
  const cur = getIssue(id(c)) ?? bad(t('nicht gefunden'), 404)
  const b = await body(c)
  const text = s(b.body).trim() || bad(t('Kommentar leer'))
  return c.json(
    addComment(
      cur.id,
      s((actor(c) !== 'Owner' && actor(c)) || b.author || t('Du'), 60),
      'comment',
      text,
    ),
    201,
  )
})

app.post('/api/issues/:id/stop', (c) => {
  const issueId = id(c)
  const stopped = inProject(getIssue(issueId), () =>
    stopIssueRun(issueId, t('Lauf manuell gestoppt.'), 'backlog', 'System'),
  )
  return c.json({ stopped })
})

// ---------- tokens RTK kept out of the agents' context ----------
app.get('/api/projects/:id/journal', (c) =>
  c.json(journal(id(c), Number(c.req.query('before')) || undefined)),
)

app.get('/api/projects/:id/lessons', (c) => c.json(listLessons(id(c))))
app.post('/api/projects/:id/lessons', async (c) => {
  const b = await body(c)
  try {
    addLesson(id(c), s(b.body, 2000), 'Owner')
  } catch (e: any) {
    bad(e.message)
  }
  return c.json(listLessons(id(c)), 201)
})
app.delete('/api/projects/:id/lessons/:lesson', (c) => {
  deleteLesson(id(c), id(c, 'lesson'))
  return c.json(listLessons(id(c)))
})

// ---------- webhooks: URL and secret stay on the server, the settings only keep the host ----------
function saveWebhooks(pid: number, change: (hooks: any[]) => any[]) {
  const project = getProject(pid) ?? bad(t('nicht gefunden'), 404)
  const settings = { ...project.settings, webhooks: change(project.settings.webhooks) }
  run('UPDATE projects SET settings=? WHERE id=?', JSON.stringify(mergeSettings(settings)), pid)
  touch(pid)
}
const webhookOf = (c: any) =>
  getProject(id(c))?.settings.webhooks.find((hook: any) => hook.id === c.req.param('hook')) ??
  bad(t('Webhook nicht gefunden'), 404)

app.post('/api/projects/:id/webhooks', async (c) => {
  const pid = id(c)
  const project = getProject(pid) ?? bad(t('nicht gefunden'), 404)
  if (project.settings.webhooks.length >= 10) bad(t('Höchstens 10 Webhooks pro Projekt'))
  const b = await body(c)
  let created: ReturnType<typeof createWebhook>
  try {
    created = createWebhook(pid, { url: s(b.url, 2048), kind: b.kind, events: b.events })
  } catch (e: any) {
    return bad(e.message)
  }
  saveWebhooks(pid, (hooks) => [...hooks, created.webhook])
  // The secret is in this answer only; it is never shown again.
  return c.json(created, 201)
})
app.delete('/api/projects/:id/webhooks/:hook', (c) => {
  const hook = webhookOf(c)
  deleteWebhook(hook.id)
  saveWebhooks(id(c), (hooks) => hooks.filter((other) => other.id !== hook.id))
  return c.json({ ok: true })
})
app.post('/api/projects/:id/webhooks/:hook/test', async (c) => {
  const hook = webhookOf(c)
  try {
    return c.json({ status: await testWebhook(id(c), hook) })
  } catch (e: any) {
    return bad(e.message)
  }
})

app.get('/api/search', (c) => c.json(searchIssues(c.req.query('q') ?? '')))

app.get('/api/projects/:id/git', async (c) => {
  const project = getProject(id(c)) ?? bad(t('nicht gefunden'), 404)
  return c.json(await gitGraph(project))
})

app.get('/api/projects/:id/rtk', async (c) =>
  c.json(await rtkReport(getProject(id(c)) ?? bad(t('nicht gefunden'), 404))),
)

// ---------- what a run printed ----------
app.get('/api/runs/:id/log', (c) =>
  c.json(all('SELECT at, text FROM run_log WHERE run_id=? ORDER BY id LIMIT 5000', id(c))),
)

// ---------- the replay of a run: its steps, redacted when they were recorded ----------
app.get('/api/runs/:id/events', (c) => {
  const kind = c.req.query('kind') || undefined
  if (kind && !RUN_EVENT_KINDS.includes(kind as RunEventKind)) bad(t('unbekannte Art'))
  const found =
    get('SELECT id, started_at, ended_at, status FROM runs WHERE id=?', id(c)) ?? bad(t('nicht gefunden'), 404)
  return c.json({ run: found, events: runEvents(found.id, kind as RunEventKind | undefined) })
})

// ---------- models per provider, for the dropdowns ----------
app.get('/api/models', async (c) => c.json(await listModels(c.req.query('refresh') === '1')))

// ---------- dashboard ----------
app.get('/api/projects/:id/stats', (c) => {
  const project = getProject(id(c)) ?? bad(t('nicht gefunden'), 404)
  // A custom range is `from` and `to` (inclusive local days, "2026-11-01"); otherwise the last `days`.
  const from = c.req.query('from')
  const to = c.req.query('to')
  if (from || to) {
    const start = parseDay(from ?? '')
    const end = parseDay(to ?? '')
    if (!start || !end) bad(t('Zeitraum: from und to als JJJJ-MM-TT angeben'))
    if (end! < start!) bad(t('Zeitraum: das Ende liegt vor dem Anfang'))
    if ((end!.getTime() - start!.getTime()) / 86_400_000 >= MAX_RANGE_DAYS) {
      bad(t('Zeitraum: höchstens {days} Tage', { days: MAX_RANGE_DAYS }))
    }
    return c.json(projectStats(project.id, { from: start!, to: end! }))
  }
  const days = Math.max(7, Math.min(180, Number(c.req.query('days')) || 14))
  return c.json(projectStats(project.id, { days }))
})

// ---------- usage ----------
app.get('/api/projects/:id/usage', (c) => {
  const p = getProject(id(c)) ?? bad(t('nicht gefunden'), 404)
  return c.json({
    providers: Object.keys(PROVIDERS).map((k) => ({ ...providerLeft(p, k), label: PROVIDERS[k].label })),
    byAgent: all(
      `SELECT agent_name, provider, COUNT(*) AS runs, SUM(input_tokens) AS input, SUM(cached_tokens) AS cached, SUM(output_tokens) AS output, SUM(cost_usd) AS cost,
       SUM(status='failed') AS failed FROM runs WHERE project_id=? GROUP BY agent_name, provider ORDER BY cost DESC, input DESC`,
      p.id,
    ),
    daily: all(
      `SELECT date(started_at/1000,'unixepoch','localtime') AS day, provider, SUM(input_tokens+output_tokens) AS tokens, SUM(cost_usd) AS cost
       FROM runs WHERE project_id=? AND started_at>=? GROUP BY day, provider ORDER BY day`,
      p.id,
      Date.now() - 14 * 86400_000,
    ),
  })
})

// ---------- provider access: subscription login or API key ----------
const knownProvider = (c: any) => {
  const provider = c.req.param('id')
  if (!PROVIDERS[provider]) bad(t('unbekannter Anbieter'), 404)
  return provider as string
}

app.get('/api/providers', (c) =>
  c.json(
    Object.entries(PROVIDERS).map(([id, provider]) => ({
      id,
      label: provider.label,
      modes: ACCESS[id]?.modes ?? ['subscription'],
      canLogin: !!ACCESS[id]?.login,
      ...getAccess(id), // mode, hasKey, ready. The key itself never leaves the server.
      hasSubscriptionToken: id === 'anthropic' && !!getSecret(SUBSCRIPTION_TOKEN),
      ...(id === MANAGED ? { managed: managedStatus() } : {}),
    })),
  ),
)

app.put('/api/providers/:id', async (c) => {
  const provider = knownProvider(c)
  const b = await body(c)
  const key = typeof b.apiKey === 'string' ? b.apiKey.trim().slice(0, 500) : undefined
  if (provider === 'anthropic' && typeof b.subscriptionToken === 'string') {
    setSecret(SUBSCRIPTION_TOKEN, b.subscriptionToken.trim().slice(0, 500))
  }
  try {
    if (provider === MANAGED && typeof b.environmentKey === 'string') {
      setSecret(ENVIRONMENT_KEY_SECRET, b.environmentKey.trim().slice(0, 500))
    }
    if (provider === MANAGED && b.runLimitUsd !== undefined) setManagedRunLimitUsd(Number(b.runLimitUsd))
    await setAccess(provider, b.mode, key)
    // The environment has to exist before its key can be generated in the Claude Console.
    if (provider === MANAGED && key) await ensureManagedSetup()
  } catch (e: any) {
    bad(e.message)
  }
  // Only which secret changed, never its value.
  const secrets = [
    key !== undefined && (key ? 'apiKey' : tIn(instanceLang(), 'apiKey entfernt')),
    provider === 'anthropic' && typeof b.subscriptionToken === 'string' && 'subscriptionToken',
    provider === MANAGED && typeof b.environmentKey === 'string' && 'environmentKey',
  ].filter(Boolean)
  audit(actor(c), 'provider.access', provider, {
    mode: s(b.mode, 40),
    changed: secrets,
    ...(provider === MANAGED && b.runLimitUsd !== undefined ? { runLimitUsd: Number(b.runLimitUsd) } : {}),
  })
  if (provider === 'anthropic') void readClaudeUsage().then(kick, () => {})
  kick()
  return c.json(getAccess(provider))
})

app.put('/api/providers/:id/resets', async (c) => {
  const provider = knownProvider(c)
  const b = await body(c)
  setResetsEnabled(provider, b.enabled === true)
  audit(actor(c), 'provider.resets', provider, { enabled: b.enabled === true })
  kick()
  return c.json({ ok: true })
})

// Ends the rest after a limit or a broken login early, e.g. once the owner has fixed the cause.
app.post('/api/providers/:id/wake', (c) => {
  wakeProvider(knownProvider(c))
  kick()
  return c.json({ ok: true })
})

app.get('/api/providers/:id/status', async (c) => c.json(await loginStatus(knownProvider(c))))

app.get('/api/providers/:id/login', (c) => c.json(loginView(knownProvider(c))))

app.post('/api/providers/:id/login', (c) => {
  try {
    const provider = knownProvider(c)
    const view = startLogin(provider, () => {
      if (provider === 'anthropic') void readClaudeUsage().catch(() => {}).finally(() => wakeProvider(provider))
      else wakeProvider(provider)
    })
    audit(actor(c), 'provider.login', provider)
    return c.json(view)
  } catch (e: any) {
    return bad(e.message)
  }
})

app.post('/api/providers/:id/login/code', async (c) => {
  const provider = knownProvider(c)
  const b = await body(c)
  try {
    submitLoginCode(provider, s(b.code, 400).trim())
  } catch (e: any) {
    bad(e.message)
  }
  return c.json(loginView(provider))
})

app.delete('/api/providers/:id/login', (c) => {
  const provider = knownProvider(c)
  cancelLogin(provider)
  audit(actor(c), 'provider.login-cancel', provider)
  return c.json({ ok: true })
})

// ---------- routines ----------
const ROUTINE_FIELDS = ['name', 'agent_id', 'prompt', 'schedule', 'at', 'every_minutes', 'enabled', 'only_when_idle']
const routineFields = (b: any) => ROUTINE_FIELDS.filter((field) => field in b)
app.get('/api/projects/:id/routines', (c) => c.json(listRoutines(id(c))))

app.post('/api/projects/:id/routines', async (c) => {
  const pid = id(c)
  const project = getProject(pid) ?? bad(t('nicht gefunden'), 404)
  const b = await body(c)
  let routine: any
  try {
    routine = createRoutine(pid, b)
  } catch (e: any) {
    return bad(e.message)
  }
  audit(actor(c), 'routine.create', `${project.key}/${routine?.name ?? ''}`, { fields: routineFields(b) })
  return c.json(routine, 201)
})

app.patch('/api/routines/:id', async (c) => {
  const b = await body(c)
  let routine: any
  try {
    routine = updateRoutine(id(c), b) ?? bad(t('nicht gefunden'), 404)
  } catch (e: any) {
    return bad(e.message, e.status)
  }
  audit(actor(c), 'routine.update', `${projectKey(routine.project_id)}/${routine.name}`, {
    fields: routineFields(b),
  })
  return c.json(routine)
})

app.delete('/api/routines/:id', (c) => {
  const routine = get('SELECT project_id, name FROM routines WHERE id=?', id(c))
  const ok = deleteRoutine(id(c))
  if (ok) audit(actor(c), 'routine.delete', `${projectKey(routine.project_id)}/${routine.name}`)
  return c.json({ ok })
})

// ---------- mail to the owner ----------
// ---------- push and morning report ----------
app.get('/api/push', (c) => c.json({ publicKey: pushPublicKey(), devices: pushDevices().length }))
app.post('/api/push/subscribe', async (c) => {
  const b = await body(c)
  try {
    subscribePush(b.subscription, s(b.device, 120))
  } catch (e: any) {
    bad(e.message)
  }
  audit(actor(c), 'push.subscribe', s(b.device, 120))
  return c.json({ devices: pushDevices().length }, 201)
})
app.post('/api/push/unsubscribe', async (c) => {
  unsubscribePush(s((await body(c)).endpoint, 2000))
  audit(actor(c), 'push.unsubscribe')
  return c.json({ devices: pushDevices().length })
})
app.post('/api/push/test', async (c) =>
  c.json({ delivered: await sendPush('AgentDeck', t('Push funktioniert auf diesem Gerät.')) }),
)

app.get('/api/report', (c) => c.json({ ...reportSettings(), preview: buildReport().text }))
app.put('/api/report', async (c) => {
  let saved: any
  try {
    saved = saveReportSettings(await body(c))
  } catch (e: any) {
    return bad(e.message)
  }
  audit(actor(c), 'report.settings', '', { at: saved.at })
  return c.json({ ...saved, preview: buildReport().text })
})
app.post('/api/report/send', async (c) => {
  try {
    return c.json(await sendReport())
  } catch (e: any) {
    return bad(e.message)
  }
})

app.get('/api/agent-note', (c) => c.json({ note: ownerNote(), max: MAX_OWNER_NOTE }))
app.put('/api/agent-note', async (c) => {
  const saved = saveOwnerNote(await body(c))
  audit(actor(c), 'agents.note', '', { length: saved.note.length })
  return c.json({ ...saved, max: MAX_OWNER_NOTE })
})

app.get('/api/mail', (c) => c.json(mailSettings()))

app.put('/api/mail', async (c) => {
  const b = await body(c)
  const saved = saveMailSettings(b)
  // Names of what changed only: the API key is a secret, the addresses are personal data.
  audit(actor(c), 'mail.settings', '', {
    changed: ['inbox', 'to', 'apiKey'].filter((field) => typeof b[field] === 'string'),
  })
  return c.json(saved)
})

app.post('/api/mail/test', async (c) => {
  try {
    await sendMail(t('[AgentDeck] Testmail'), t('Wenn du das liest, kann AgentDeck dir Mails schicken.'))
    return c.json({ ok: true })
  } catch (e: any) {
    return bad(e.message, 502)
  }
})

// ---------- MCP connections ----------
app.get('/api/mcp', (c) => c.json(listConnections()))

app.put('/api/mcp/:id', async (c) => {
  const b = await body(c)
  try {
    setConnectionKey(c.req.param('id'), s(b.apiKey, 500).trim())
  } catch (e: any) {
    bad(e.message, 404)
  }
  audit(actor(c), 'mcp.key', c.req.param('id'), {
    changed: [s(b.apiKey, 500).trim() ? 'apiKey' : tIn(instanceLang(), 'apiKey entfernt')],
  })
  return c.json(listConnections())
})

// ---------- blueprints (used by the UI wizard and by the agentdeck skill) ----------
app.post('/api/import', async (c) => {
  const b = await body(c)
  const key = s(b?.project?.key, 8).toUpperCase()
  confirmShellChange(c, b, key, changedShellSettings(null, b?.project?.settings))
  try {
    const imported = importProject(b)
    audit(actor(c), 'project.import', key)
    sandboxProjects()
    return c.json(imported, 201)
  } catch (e: any) {
    return bad(e.message)
  }
})

app.get('/api/templates', (c) => c.json(listTemplates()))
app.post('/api/templates/:template', async (c) => {
  const b = await body(c)
  const key = s(b.key, 8).toUpperCase()
  // A blueprint with a known key extends that project; a template must never do that.
  if (get('SELECT 1 FROM projects WHERE key=?', key)) bad(t('Projekt-Key existiert bereits'), 409)
  try {
    const result = applyTemplate(c.req.param('template'), {
      key,
      name: s(b.name, 120),
      repo_path: s(b.repo_path, 500),
      language: isLang(b.settings?.language) ? b.settings.language : undefined,
    })
    audit(actor(c), 'project.template', key, { template: s(c.req.param('template'), 60) })
    sandboxProjects()
    kick()
    return c.json(result, 201)
  } catch (e: any) {
    return bad(e.message)
  }
})

app.post('/api/blueprint', async (c) => {
  const b = await body(c)
  const key = s(b?.project?.key, 8).toUpperCase()
  confirmShellChange(c, b, key, blueprintShellChanges(b?.project))
  let r
  try {
    r = applyBlueprint(b)
  } catch (e: any) {
    bad(e.message)
  }
  audit(actor(c), 'project.blueprint', key, {
    agents: Array.isArray(b.agents) ? b.agents.length : 0,
    issues: Array.isArray(b.issues) ? b.issues.length : 0,
    settings: !!b.project?.settings,
  })
  sandboxProjects()
  kick()
  return c.json(r, 201)
})

app.post('/api/blueprint/generate', async (c) => {
  const b = await body(c)
  const provider = PROVIDERS[b.provider] ? b.provider : 'anthropic'
  const wish = s(b.prompt, 8000).trim() || bad(t('Beschreibung fehlt'))
  const res = await oneShot(
    provider,
    blueprintRequest(wish),
    DATA_DIR,
  )
  if (!res.ok) bad(t('KI-Aufruf fehlgeschlagen: {error}', { error: String(res.error) }), 502)
  try {
    return c.json(extractJson(res.text))
  } catch (e: any) {
    return bad(e.message, 502)
  }
})

// ---------- live events ----------
app.get('/api/events', (c) => {
  const pid = Number(c.req.query('project'))
  return streamSSE(c, async (stream) => {
    // JSON strings: an event is serialized once in emit, for every browser that listens.
    const queue: string[] = []
    let wake: (() => void) | null = null
    let open = true
    const unsub = subscribe(pid, (_e, json) => {
      queue.push(json)
      wake?.()
    })
    stream.onAbort(() => {
      open = false
      unsub()
      wake?.()
    })
    const send = (e: unknown) => queue.push(JSON.stringify(e))
    for (const [runId, a] of activity) send({ t: 'activity', runId, issueId: a.issueId, text: a.text })
    send({ t: 'notice', text: notices.get(pid) ?? '' })
    send({ t: 'waiting', reasons: waiting.get(pid) ?? {} })
    while (open) {
      while (queue.length && open) await stream.writeSSE({ data: queue.shift()! })
      await new Promise<void>((r) => {
        wake = r
        setTimeout(r, 25_000)
      })
      wake = null
      if (open && !queue.length) await stream.writeSSE({ event: 'ping', data: '' })
    }
  })
})

// ---------- static UI ----------
app.use('/assets/*', async (c, next) => {
  await next()
  c.header('cache-control', 'public, max-age=31536000, immutable')
})
// The build writes .br and .gz next to each file, so nothing is compressed per request. compress()
// stays for a dist built without them; it leaves a response that already has an encoding alone.
app.use('/*', compress(), serveStatic({ root: './dist', precompressed: true }))
app.get('*', compress(), serveStatic({ path: './dist/index.html', precompressed: true }))

const port = Number(process.env.PORT ?? 8790)
const server = serve({ fetch: app.fetch, port, hostname: process.env.HOST ?? '127.0.0.1' }, () =>
  console.log(`AgentDeck http://localhost:${port}  data=${DATA_DIR}`),
)
recoverAfterRestart()
lockDownServerFiles(DATA_DIR)
startEgress()
sandboxProjects()
startEngine()
startRoutines(kick)
startHousekeeping()
startClaudeUsage(kick)
startCodexUsage(kick)
startReports()
startSpendGuard()
for (const sig of ['SIGINT', 'SIGTERM'] as const)
  process.on(sig, () => {
    shutdown()
    server.close()
    process.exit(0)
  })
