import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { compress } from 'hono/compress'
import { getCookie, setCookie } from 'hono/cookie'
import { streamSSE } from 'hono/streaming'
import { createHash, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
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
  PROVIDERS,
  STATUSES,
  subscribe,
  touch,
} from './core.ts'
import { kick, landByHand, notices, shutdown, startEngine, stopIssueRun, stopRun, waiting } from './engine.ts'
import { wakeProvider } from './recovery.ts'
import { addLesson, deleteLesson, listLessons } from './lessons.ts'
import { mailSettings, saveMailSettings, sendMail } from './notify.ts'
import { applyBlueprint, BLUEPRINT_GUIDE, extractJson } from './blueprint.ts'
import { importProject } from './importer.ts'
import { oneShot } from './adapters.ts'
import { listModels } from './models.ts'
import { rtkReport } from './rtk.ts'
import { projectStats } from './stats.ts'
import { agentApi } from './agentApi.ts'
import { startHousekeeping } from './housekeeping.ts'
import { issueChanges } from './diff.ts'
import { searchIssues } from './search.ts'
import { gitGraph } from './gitGraph.ts'
import { capOf, spentOn } from './issueCap.ts'
import { showcaseData, showcasePage } from './showcase.ts'
import { listShots, shotsDir } from './preview.ts'
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
const app = new Hono()

class HttpError extends Error {
  status: number
  constructor(status: number, msg: string) {
    super(msg)
    this.status = status
  }
}
const bad = (msg: string, status = 400): never => {
  throw new HttpError(status, msg)
}
app.onError((e, c) => {
  if (!(e instanceof HttpError)) console.error(e)
  return c.json({ error: e.message }, (e as any).status ?? 500)
})

// Agents authenticate with the token of their run, so their routes sit in front of the board login.
app.route('/api/agent', agentApi)

const sameSecret = (given: string, wanted: string) => {
  const a = Buffer.from(given)
  const b = Buffer.from(wanted)
  return a.length === b.length && timingSafeEqual(a, b)
}

// The browser keeps a hash of the token in a cookie, so the token itself is typed once and not stored.
const SESSION_COOKIE = 'agentdeck_session'
const SESSION_VALUE = createHash('sha256').update(`agentdeck-session:${TOKEN}`).digest('hex')

app.post('/api/login', async (c) => {
  const given = String((await c.req.json().catch(() => ({}))).token ?? '')
  if (!TOKEN || !sameSecret(given, TOKEN)) return c.json({ error: 'Wrong token' }, 401)
  setCookie(c, SESSION_COOKIE, SESSION_VALUE, {
    httpOnly: true,
    sameSite: 'Strict',
    secure: c.req.header('x-forwarded-proto') === 'https',
    path: '/',
    maxAge: 60 * 60 * 24 * 30,
  })
  return c.json({ ok: true })
})

// The showcase is public on purpose: it shows what the owner chose to show, and nothing else.
app.get('/api/public/:slug', (c) => {
  const data = showcaseData(c.req.param('slug'))
  return data ? c.json(data) : c.json({ error: 'not found' }, 404)
})
app.get('/show/:slug', (c) => c.html(showcasePage(c.req.param('slug'))))

app.use('/api/*', async (c, next) => {
  if (c.req.path.startsWith('/api/public/')) return next()
  if (!TOKEN) return next()
  const header = c.req.header('authorization') ?? ''
  if (header.startsWith('Bearer ') && sameSecret(header.slice(7), TOKEN)) return next()
  if (sameSecret(getCookie(c, SESSION_COOKIE) ?? '', SESSION_VALUE)) return next()
  if (TRUST_PROXY && c.req.header('remote-user')) return next()
  return c.json({ error: 'unauthorized' }, 401)
})
// The event stream must not be buffered, and the board ships its own cached gzip.
const skipsCompression = (path: string) => path === '/api/events' || path.endsWith('/board')
app.use('/api/*', (c, next) => (skipsCompression(c.req.path) ? next() : compress()(c, next)))

const id = (c: any, name = 'id') => Number(c.req.param(name)) || bad('invalid id')
const body = async (c: any) => (await c.req.json().catch(() => null)) ?? bad('JSON expected')
const s = (v: any, max = 20000) => String(v ?? '').slice(0, max)

// ---------- meta & projects ----------
app.get('/api/meta', (c) =>
  c.json({
    providers: Object.entries(PROVIDERS).map(([k, v]) => ({ id: k, label: v.label })),
    statuses: STATUSES,
    blueprintGuide: BLUEPRINT_GUIDE,
  }),
)

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
  if (get('SELECT 1 FROM projects WHERE key=?', s(b.key, 8).toUpperCase()))
    bad('Project key already exists', 409)
  let r: any
  try {
    r = applyBlueprint({ project: b })
  } catch (e: any) {
    bad(e.message)
  }
  return c.json(getProject(r.projectId), 201)
})

app.get('/api/projects/:id/board', (c) => {
  const cached = board(id(c)) ?? bad('not found', 404)
  const headers: Record<string, string> = { 'content-type': 'application/json', vary: 'accept-encoding' }
  if (!(c.req.header('accept-encoding') ?? '').includes('gzip')) return c.body(cached.json, 200, headers)
  return c.body(new Uint8Array(cached.gzip), 200, { ...headers, 'content-encoding': 'gzip' })
})

app.patch('/api/projects/:id', async (c) => {
  const pid = id(c)
  const b = await body(c)
  const p = getProject(pid) ?? bad('not found', 404)
  run(
    'UPDATE projects SET name=?, description=?, repo_path=?, paused=?, settings=? WHERE id=?',
    s(b.name ?? p.name, 120),
    s(b.description ?? p.description, 4000),
    s(b.repo_path ?? p.repo_path, 500),
    (b.paused ?? p.paused) ? 1 : 0,
    JSON.stringify(mergeSettings(b.settings ?? p.settings)),
    pid,
  )
  touch(pid)
  kick()
  return c.json(getProject(pid))
})

app.delete('/api/projects/:id', (c) => {
  const pid = id(c)
  for (const r of all("SELECT id FROM runs WHERE project_id=? AND status='running'", pid))
    stopRun(r.id, 'Project deleted', 'backlog', 'System')
  run('DELETE FROM projects WHERE id=?', pid)
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
    if (!EFFORTS.includes(b.effort)) bad('unknown effort level')
    run('UPDATE agents SET effort=? WHERE id=?', b.effort, agentId)
  }
}

function agentFields(b: any, cur: any = {}) {
  const provider = b.provider ?? cur.provider
  if (!PROVIDERS[provider]) bad('unknown provider')
  const model = s(b.model ?? cur.model ?? '', 80)
  if (!MODEL_RE.test(model)) bad('invalid model name')
  const name = s(b.name ?? cur.name, 80).trim() || bad('Name is missing')
  return [
    name,
    s(b.role ?? cur.role ?? '', 200),
    provider,
    model,
    s(b.instructions ?? cur.instructions ?? ''),
    JSON.stringify((b.skill_ids ?? cur.skill_ids ?? []).map(Number).filter(Boolean)),
    Math.max(1, Math.min(20, Number(b.max_instances ?? cur.max_instances ?? 1) || 1)),
    (b.enabled ?? cur.enabled ?? true) ? 1 : 0,
  ]
}
app.post('/api/projects/:id/agents', async (c) => {
  const pid = id(c)
  getProject(pid) ?? bad('not found', 404)
  const b = await body(c)
  const r = run(
    'INSERT INTO agents (name, role, provider, model, instructions, skill_ids, max_instances, enabled, project_id) VALUES (?,?,?,?,?,?,?,?,?)',
    ...agentFields(b),
    pid,
  )
  saveAgentExtras(Number(r.lastInsertRowid), b)
  touch(pid)
  kick()
  return c.json(mapAgent(get('SELECT * FROM agents WHERE id=?', r.lastInsertRowid)), 201)
})
app.patch('/api/agents/:id', async (c) => {
  const cur = mapAgent(get('SELECT * FROM agents WHERE id=?', id(c))) ?? bad('not found', 404)
  const b = await body(c)
  run(
    'UPDATE agents SET name=?, role=?, provider=?, model=?, instructions=?, skill_ids=?, max_instances=?, enabled=? WHERE id=?',
    ...agentFields(b, cur),
    cur.id,
  )
  saveAgentExtras(cur.id, b)
  touch(cur.project_id)
  kick()
  return c.json(mapAgent(get('SELECT * FROM agents WHERE id=?', cur.id)))
})
app.delete('/api/agents/:id', (c) => {
  const cur = get('SELECT * FROM agents WHERE id=?', id(c)) ?? bad('not found', 404)
  for (const r of all("SELECT id FROM runs WHERE agent_id=? AND status='running'", cur.id))
    stopRun(r.id, 'Agent deleted', 'todo', 'System')
  run('DELETE FROM agents WHERE id=?', cur.id)
  touch(cur.project_id)
  return c.json({ ok: true })
})

app.post('/api/projects/:id/skills', async (c) => {
  const pid = id(c)
  getProject(pid) ?? bad('not found', 404)
  const b = await body(c)
  const r = run(
    'INSERT INTO skills (project_id, name, description, content) VALUES (?,?,?,?)',
    pid,
    s(b.name, 80).trim() || bad('Name is missing'),
    s(b.description, 400),
    s(b.content),
  )
  touch(pid)
  return c.json(get('SELECT * FROM skills WHERE id=?', r.lastInsertRowid), 201)
})
app.patch('/api/skills/:id', async (c) => {
  const cur = get('SELECT * FROM skills WHERE id=?', id(c)) ?? bad('not found', 404)
  const b = await body(c)
  run(
    'UPDATE skills SET name=?, description=?, content=? WHERE id=?',
    s(b.name ?? cur.name, 80),
    s(b.description ?? cur.description, 400),
    s(b.content ?? cur.content),
    cur.id,
  )
  touch(cur.project_id)
  return c.json(get('SELECT * FROM skills WHERE id=?', cur.id))
})
app.delete('/api/skills/:id', (c) => {
  const cur = get('SELECT * FROM skills WHERE id=?', id(c)) ?? bad('not found', 404)
  run('DELETE FROM skills WHERE id=?', cur.id)
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
  const title = s(b.title, 300).trim() || bad('Title is missing')
  const issue = tx(() =>
    createIssue(pid, { ...b, title, description: s(b.description), created_by: 'Owner' }),
  )
  kick()
  return c.json(issue, 201)
})

app.get('/api/issues/:id/spent', (c) => {
  const issue = getIssue(id(c)) ?? bad('not found', 404)
  const cap = getProject(issue.project_id).settings.issueCap
  return c.json({ spent: spentOn(issue.id), cap: capOf(cap, issue.cap_factor), capped: !!issue.capped })
})
app.post('/api/issues/:id/raise-cap', (c) => {
  const issue = getIssue(id(c)) ?? bad('not found', 404)
  addComment(issue.id, 'System', 'system', 'Another round of the cost cap granted.')
  patchIssue(issue.id, {
    cap_factor: issue.cap_factor + 1,
    capped: 0,
    ...(issue.capped && issue.status === 'backlog' ? { status: 'todo' } : {}),
  })
  kick()
  return c.json({ ok: true })
})

app.get('/api/issues/:id/changes', async (c) => {
  const issue = getIssue(id(c)) ?? bad('not found', 404)
  return c.json(await issueChanges(getProject(issue.project_id), issue.number))
})
app.get('/api/issues/:id/shots', (c) => c.json(listShots(id(c))))
app.get('/api/issues/:id/shots/:file', async (c) => {
  const file = c.req.param('file')
  if (!/^\d+-(desktop|phone)\.png$/.test(file)) bad('invalid file')
  const path = `${shotsDir(id(c))}/${file}`
  if (!existsSync(path)) bad('not found', 404)
  return c.body(readFileSync(path), 200, {
    'content-type': 'image/png',
    'cache-control': 'private, max-age=86400',
  })
})

const LINK_COLUMNS = 'i.id, i.number, i.title, i.status, i.assignee_id'

app.get('/api/issues/:id', (c) => {
  const issue = getIssue(id(c)) ?? bad('not found', 404)
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
  })
})

app.patch('/api/issues/:id', async (c) => {
  const cur = getIssue(id(c)) ?? bad('not found', 404)
  const b = await body(c)
  const patch: Record<string, any> = {}
  if ('title' in b) patch.title = s(b.title, 300).trim() || bad('Title is missing')
  if ('description' in b) patch.description = s(b.description)
  if ('priority' in b) patch.priority = Math.max(0, Math.min(3, Number(b.priority) || 0))
  if ('rank' in b) patch.rank = Number(b.rank) || 0
  if ('assignee_id' in b) patch.assignee_id = b.assignee_id ? Number(b.assignee_id) : null
  if ('blocked_by' in b)
    patch.blocked_by = (Array.isArray(b.blocked_by) ? b.blocked_by : [])
      .map(Number)
      .filter((n: number) => n && n !== cur.number)
  if ('grp' in b) patch.grp = s(b.grp, 80).trim()
  if ('model' in b) {
    patch.model = s(b.model, 80).trim()
    if (!MODEL_RE.test(patch.model)) bad('invalid model name')
  }
  if ('reviewers' in b) {
    const known = new Set(all('SELECT id FROM agents WHERE project_id=?', cur.project_id).map((a) => a.id))
    patch.reviewers = (Array.isArray(b.reviewers) ? b.reviewers : [])
      .map(Number)
      .filter((a: number) => known.has(a))
  }
  if ('status' in b && b.status !== cur.status) {
    if (!STATUSES.includes(b.status)) bad('unknown status')
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
    patch.cap_factor = cur.cap_factor + 1
    patch.capped = 0
  }
  const issue = patchIssue(cur.id, patch, c.req.header('remote-user') || 'Owner')
  if (patch.status === 'done') landByHand(cur.id)
  if (
    cur.status === 'in_progress' &&
    (patch.status || ('assignee_id' in patch && patch.assignee_id !== cur.assignee_id))
  )
    stopIssueRun(cur.id, 'Run stopped, the issue was changed by hand.', patch.status ?? 'todo', 'System')
  kick()
  return c.json(issue)
})

app.delete('/api/issues/:id', (c) => {
  const cur = getIssue(id(c)) ?? bad('not found', 404)
  stopIssueRun(cur.id, 'Issue deleted', 'backlog', 'System')
  run('DELETE FROM issues WHERE id=?', cur.id)
  forgetIssue(cur.project_id, cur.id)
  touch(cur.project_id)
  return c.json({ ok: true })
})

app.post('/api/issues/:id/comments', async (c) => {
  const cur = getIssue(id(c)) ?? bad('not found', 404)
  const b = await body(c)
  const text = s(b.body).trim() || bad('Comment is empty')
  return c.json(
    addComment(cur.id, s(b.author || c.req.header('remote-user') || 'You', 60), 'comment', text),
    201,
  )
})

app.post('/api/issues/:id/stop', (c) =>
  c.json({ stopped: stopIssueRun(id(c), 'Run stopped by hand.', 'backlog', 'System') }),
)

// ---------- tokens RTK kept out of the agents' context ----------
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

app.get('/api/search', (c) => c.json(searchIssues(c.req.query('q') ?? '')))

app.get('/api/projects/:id/git', async (c) => {
  const project = getProject(id(c)) ?? bad('not found', 404)
  return c.json(await gitGraph(project))
})

app.get('/api/projects/:id/rtk', async (c) =>
  c.json(await rtkReport(getProject(id(c)) ?? bad('not found', 404))),
)

// ---------- what a run printed ----------
app.get('/api/runs/:id/log', (c) =>
  c.json(all('SELECT at, text FROM run_log WHERE run_id=? ORDER BY id LIMIT 5000', id(c))),
)

// ---------- models per provider, for the dropdowns ----------
app.get('/api/models', async (c) => c.json(await listModels(c.req.query('refresh') === '1')))

// ---------- dashboard ----------
app.get('/api/projects/:id/stats', (c) => {
  const project = getProject(id(c)) ?? bad('not found', 404)
  const days = Math.max(7, Math.min(180, Number(c.req.query('days')) || 14))
  return c.json(projectStats(project.id, days))
})

// ---------- usage ----------
app.get('/api/projects/:id/usage', (c) => {
  const p = getProject(id(c)) ?? bad('not found', 404)
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
  if (!PROVIDERS[provider]) bad('unknown provider', 404)
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
  kick()
  return c.json(getAccess(provider))
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
    return c.json(startLogin(knownProvider(c)))
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
  cancelLogin(knownProvider(c))
  return c.json({ ok: true })
})

// ---------- routines ----------
app.get('/api/projects/:id/routines', (c) => c.json(listRoutines(id(c))))

app.post('/api/projects/:id/routines', async (c) => {
  const pid = id(c)
  getProject(pid) ?? bad('not found', 404)
  try {
    return c.json(createRoutine(pid, await body(c)), 201)
  } catch (e: any) {
    return bad(e.message)
  }
})

app.patch('/api/routines/:id', async (c) => {
  try {
    return c.json(updateRoutine(id(c), await body(c)) ?? bad('not found', 404))
  } catch (e: any) {
    return bad(e.message, e.status)
  }
})

app.delete('/api/routines/:id', (c) => c.json({ ok: deleteRoutine(id(c)) }))

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
  return c.json({ devices: pushDevices().length }, 201)
})
app.post('/api/push/unsubscribe', async (c) => {
  unsubscribePush(s((await body(c)).endpoint, 2000))
  return c.json({ devices: pushDevices().length })
})
app.post('/api/push/test', async (c) =>
  c.json({ delivered: await sendPush('AgentDeck', 'Push works on this device.') }),
)

app.get('/api/report', (c) => c.json({ ...reportSettings(), preview: buildReport().text }))
app.put('/api/report', async (c) => {
  try {
    return c.json({ ...saveReportSettings(await body(c)), preview: buildReport().text })
  } catch (e: any) {
    return bad(e.message)
  }
})
app.post('/api/report/send', async (c) => {
  try {
    return c.json(await sendReport())
  } catch (e: any) {
    return bad(e.message)
  }
})

app.get('/api/mail', (c) => c.json(mailSettings()))

app.put('/api/mail', async (c) => c.json(saveMailSettings(await body(c))))

app.post('/api/mail/test', async (c) => {
  try {
    await sendMail('[AgentDeck] Test mail', 'If you can read this, AgentDeck can send you mail.')
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
  return c.json(listConnections())
})

// ---------- blueprints (used by the UI wizard and by the agentdeck skill) ----------
app.post('/api/import', async (c) => {
  try {
    return c.json(importProject(await body(c)), 201)
  } catch (e: any) {
    return bad(e.message)
  }
})

app.get('/api/templates', (c) => c.json(listTemplates()))
app.post('/api/templates/:template', async (c) => {
  const b = await body(c)
  const key = s(b.key, 8).toUpperCase()
  // A blueprint with a known key extends that project; a template must never do that.
  if (get('SELECT 1 FROM projects WHERE key=?', key)) bad('Project key already exists', 409)
  try {
    const result = applyTemplate(c.req.param('template'), {
      key,
      name: s(b.name, 120),
      repo_path: s(b.repo_path, 500),
    })
    kick()
    return c.json(result, 201)
  } catch (e: any) {
    return bad(e.message)
  }
})

app.post('/api/blueprint', async (c) => {
  const b = await body(c)
  let r
  try {
    r = applyBlueprint(b)
  } catch (e: any) {
    bad(e.message)
  }
  kick()
  return c.json(r, 201)
})

app.post('/api/blueprint/generate', async (c) => {
  const b = await body(c)
  const provider = PROVIDERS[b.provider] ? b.provider : 'anthropic'
  const wish = s(b.prompt, 8000).trim() || bad('Description is missing')
  const res = await oneShot(
    provider,
    `${BLUEPRINT_GUIDE}\n\nCreate a blueprint for the following request. Write names, descriptions and issues in the language of the request. Reply with the JSON object only, no prose, no code fence.\n\n## Request\n${wish}`,
    DATA_DIR,
  )
  if (!res.ok) bad(`AI call failed: ${res.error}`, 502)
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
    const queue: any[] = []
    let wake: (() => void) | null = null
    let open = true
    const unsub = subscribe(pid, (e) => {
      queue.push(e)
      wake?.()
    })
    stream.onAbort(() => {
      open = false
      unsub()
      wake?.()
    })
    for (const [runId, a] of activity) queue.push({ t: 'activity', runId, issueId: a.issueId, text: a.text })
    queue.push({ t: 'notice', text: notices.get(pid) ?? '' })
    queue.push({ t: 'waiting', reasons: waiting.get(pid) ?? {} })
    while (open) {
      while (queue.length && open) await stream.writeSSE({ data: JSON.stringify(queue.shift()) })
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
app.use('/*', compress(), serveStatic({ root: './dist' }))
app.get('*', serveStatic({ path: './dist/index.html' }))

const port = Number(process.env.PORT ?? 8790)
const server = serve({ fetch: app.fetch, port, hostname: process.env.HOST ?? '127.0.0.1' }, () =>
  console.log(`AgentDeck http://localhost:${port}  data=${DATA_DIR}`),
)
recoverAfterRestart()
startEngine()
startRoutines(kick)
startHousekeeping()
startReports()
for (const sig of ['SIGINT', 'SIGTERM'] as const)
  process.on(sig, () => {
    shutdown()
    server.close()
    process.exit(0)
  })
