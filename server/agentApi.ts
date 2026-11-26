// What a running agent may do on the board: read issues of its own project, comment, and file
// new issues. It authenticates with the token of its run, never with the board token.
import { Hono } from 'hono'
import { itemsFromText } from './checklist.ts'
import { addComment, createIssue, getAgent, getIssue, getProject, mapIssue, patchIssue } from './core.ts'
import { all, get, tx } from './db.ts'
import { kick } from './engine.ts'
import { forProject, t } from './i18n.ts'
import { addLesson } from './lessons.ts'
import { CONNECTIONS } from './mcp.ts'
import { runOfToken, type RunIdentity } from './runTokens.ts'
import { installPackages } from './sandbox.ts'
import { missingSections } from './ticket.ts'

type Env = { Variables: { run: RunIdentity } }

export const agentApi = new Hono<Env>()

agentApi.use('*', async (c, next) => {
  const header = c.req.header('authorization') ?? ''
  const identity = runOfToken(header.replace(/^Bearer /, ''))
  if (!identity) return c.json({ error: t('Dieses Lauf-Token ist nicht (mehr) gültig') }, 401)
  c.set('run', identity)
  // The agent that reads the answers works in its project's language.
  return forProject(getProject(identity.projectId), next)
})

const text = (value: unknown, max: number) => String(value ?? '').slice(0, max)

function issueByNumber(projectId: number, number: string) {
  return mapIssue(get('SELECT * FROM issues WHERE project_id=? AND number=?', projectId, Number(number)))
}

function agentIdsByName(projectId: number, names: unknown): number[] {
  const wanted = String(names ?? '')
    .split(',')
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean)
  if (!wanted.length) return []
  const agents = all('SELECT id, name FROM agents WHERE project_id=?', projectId)
  return wanted.map((name) => {
    const agent = agents.find((candidate) => candidate.name.toLowerCase() === name)
    if (!agent) throw new Error(t('Kein Agent namens "{name}" in diesem Projekt', { name }))
    return agent.id
  })
}

agentApi.get('/issues', (c) => {
  const { projectId } = c.get('run')
  const status = c.req.query('status')
  const rows = all(
    `SELECT i.number, i.title, i.status, i.priority, i.grp, a.name AS assignee FROM issues i
     LEFT JOIN agents a ON a.id = i.assignee_id
     WHERE i.project_id=? AND (?='' OR i.status=?) ORDER BY i.number DESC LIMIT 300`,
    projectId,
    status ?? '',
    status ?? '',
  )
  return c.json(rows)
})

agentApi.get('/issues/:number', (c) => {
  const issue = issueByNumber(c.get('run').projectId, c.req.param('number'))
  if (!issue) return c.json({ error: t('Issue nicht gefunden') }, 404)
  const comments = all(
    'SELECT author, kind, body, created_at FROM comments WHERE issue_id=? ORDER BY id',
    issue.id,
  )
  return c.json({ issue, comments })
})

agentApi.post('/issues/:number/unblock', async (c) => {
  const identity = c.get('run')
  const issue = issueByNumber(identity.projectId, c.req.param('number'))
  if (!issue) return c.json({ error: t('Issue nicht gefunden') }, 404)
  const blocker = Number((await c.req.json().catch(() => ({}))).blocker)
  if (!issue.blocked_by.includes(blocker)) {
    return c.json({ error: t('Issue {number} wartet nicht auf {blocker}', { number: issue.number, blocker }) }, 400)
  }
  patchIssue(
    issue.id,
    { blocked_by: issue.blocked_by.filter((number: number) => number !== blocker) },
    identity.agentName,
  )
  const key = getProject(identity.projectId).key
  addComment(issue.id, identity.agentName, 'agent', t('Wartet nicht mehr auf {issue}.', { issue: `${key}-${blocker}` }))
  kick()
  return c.json({ ok: true })
})

agentApi.post('/issues/:number/comments', async (c) => {
  const identity = c.get('run')
  const issue = issueByNumber(identity.projectId, c.req.param('number'))
  if (!issue) return c.json({ error: t('Issue nicht gefunden') }, 404)
  const body = text((await c.req.json().catch(() => ({}))).body, 20_000).trim()
  if (!body) return c.json({ error: t('Kommentar leer') }, 400)
  addComment(issue.id, identity.agentName, 'agent', body)
  return c.json({ ok: true }, 201)
})

// Agents have no root in the sandbox. Debian packages come from the server, so a run that
// needs a tool still goes on by itself. Each install is noted on the issue.
agentApi.post('/packages', async (c) => {
  const identity = c.get('run')
  const names = String((await c.req.json().catch(() => ({}))).names ?? '')
    .split(/[\s,]+/)
    .filter(Boolean)
  try {
    const output = await installPackages(names)
    addComment(
      identity.issueId,
      identity.agentName,
      'agent',
      t('Systempakete installiert: {names}', { names: names.join(', ') }),
    )
    return c.json({ ok: true, output })
  } catch (e: any) {
    return c.json({ error: String(e.stderr || e.message).trim().slice(-2000) }, 400)
  }
})

// An on-demand connection is left out of a run to keep its steps small (mcp.ts). The agent that
// needs its tools after all asks here; the next run on the issue gets them.
agentApi.post('/connections', async (c) => {
  const identity = c.get('run')
  const id = text((await c.req.json().catch(() => ({}))).id, 40).trim().toLowerCase()
  const own: string[] = getAgent(identity.agentId)?.mcp_ids ?? []
  if (!CONNECTIONS[id] || !own.includes(id)) {
    const possible = own.join(', ') || t('keine')
    return c.json({ error: t('Keine Verbindung "{id}" für diesen Agenten. Möglich: {possible}', { id, possible }) }, 400)
  }
  const wanted: string[] = getIssue(identity.issueId)?.mcp_wanted ?? []
  if (!wanted.includes(id)) {
    patchIssue(identity.issueId, { mcp_wanted: [...wanted, id] }, identity.agentName)
    const note = t('Braucht die MCP-Werkzeuge von {name}.', { name: CONNECTIONS[id].label })
    addComment(identity.issueId, identity.agentName, 'agent', note)
  }
  return c.json({ ok: true })
})

agentApi.post('/lessons', async (c) => {
  const identity = c.get('run')
  const body = await c.req.json().catch(() => ({}))
  try {
    addLesson(identity.projectId, text(body.body, 2000), identity.agentName)
    return c.json({ ok: true }, 201)
  } catch (e: any) {
    return c.json({ error: e.message }, 400)
  }
})

const STOP_WORDS = new Set(['the', 'and', 'for', 'with', 'der', 'die', 'das', 'und', 'mit', 'für', 'von'])

function titleWords(title: string) {
  const words = title
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 2 && !STOP_WORDS.has(word))
  return new Set(words)
}

/** How much two titles share, 0 to 1 (Jaccard of their words). */
function overlap(a: Set<string>, b: Set<string>) {
  if (!a.size || !b.size) return 0
  const shared = [...a].filter((word) => b.has(word)).length
  return shared / (a.size + b.size - shared)
}

const sourceLine = (description: string) =>
  description
    .match(/\*\*source:\*\*\s*([^\n]+)/i)?.[1]
    .trim()
    .toLowerCase() ?? ''

/**
 * Agents file the same follow-up twice, and the second copy costs a full review just to be closed
 * as a duplicate. An open issue with nearly the same title, or with the same source line, is named
 * instead of filing a new one.
 */
function similarOpenIssues(projectId: number, title: string, description: string) {
  const wanted = titleWords(title)
  const source = sourceLine(description)
  return all("SELECT number, title, description FROM issues WHERE project_id=? AND status!='done'", projectId)
    .filter(
      (issue) =>
        overlap(wanted, titleWords(issue.title)) >= 0.7 ||
        (source && sourceLine(issue.description) === source),
    )
    .slice(0, 3)
}

agentApi.post('/issues', async (c) => {
  const identity = c.get('run')
  const body = await c.req.json().catch(() => ({}))
  const title = text(body.title, 300).trim()
  if (!title) return c.json({ error: t('Titel fehlt') }, 400)

  const project = getProject(identity.projectId)
  const description = text(body.description, 20_000)
  const missing = missingSections(description)
  if (missing.length) {
    return c.json(
      {
        error: t(
          'Die Beschreibung braucht die Abschnitte {sections}. Schreib das Issue so, dass ein Junior es ohne Rückfrage erledigen kann (Format: siehe "How to write an issue" in deinem Prompt), und leg es erneut an.',
          { sections: missing.map((name) => `"## ${name}"`).join(', ') },
        ),
      },
      400,
    )
  }
  const similar = body.force ? [] : similarOpenIssues(identity.projectId, title, description)
  if (similar.length) {
    const list = similar.map((issue) => `${project.key}-${issue.number} "${issue.title}"`).join(', ')
    return c.json(
      {
        error: t(
          'Ähnliches offenes Issue vorhanden: {list}. Kommentiere dort, statt ein neues anzulegen. Nur wenn deins wirklich etwas anderes ist: --force yes.',
          { list },
        ),
      },
      409,
    )
  }

  try {
    const [assignee] = agentIdsByName(identity.projectId, body.assignee)
    const origin = getIssue(identity.issueId)
    const created = tx(() =>
      createIssue(identity.projectId, {
        title,
        description,
        checklist: itemsFromText(body.checklist),
        // Agents may queue work or park it, nothing else.
        status: body.status === 'todo' ? 'todo' : 'backlog',
        priority: Math.max(0, Math.min(3, Number(body.priority ?? 1) || 0)),
        assignee_id: assignee ?? null,
        blocked_by: String(body.blocked_by ?? '')
          .split(',')
          .map(Number)
          .filter(Boolean),
        reviewers: agentIdsByName(identity.projectId, body.reviewers),
        grp: text(body.group, 80),
        created_by: identity.agentName,
      }),
    )
    addComment(
      created.id,
      'System',
      'system',
      t('Angelegt von {agent} während {issue}.', {
        agent: identity.agentName,
        issue: `${project.key}-${origin?.number ?? '?'}`,
      }),
    )
    kick()
    return c.json({ number: created.number, key: `${project.key}-${created.number}` }, 201)
  } catch (e: any) {
    return c.json({ error: e.message }, 400)
  }
})
