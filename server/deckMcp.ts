// AgentDeck as an MCP server: any MCP client (Claude Code, Codex, Cursor, a chat app) can read the
// boards and file, comment, move and stop issues. Every tool goes through the same HTTP routes the
// board uses, with the caller's own login, so roles, the audit log and the rules of each route
// (cost caps, approval gates) apply here without a second copy. Stateless: one JSON answer per
// request, no session, nothing to clean up.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { z } from 'zod'

/** Calls one of AgentDeck's own routes as the person who called the MCP endpoint. */
export type Api = (method: string, path: string, body?: unknown) => Promise<Response>

const STATUSES = ['backlog', 'todo', 'in_progress', 'review', 'blocked', 'done'] as const
const DONE_SHOWN = 20
const COMMENT_CHARS = 2000

const issueKey = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9]*-\d+$/)
  .describe('Issue key, e.g. "SHOP-12"')
const projectKey = z.string().min(1).max(8).describe('Project key, e.g. "SHOP"')

async function ask(api: Api, method: string, path: string, body?: unknown) {
  const response = await api(method, path, body)
  const answer: any = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(answer?.error ?? `HTTP ${response.status}`)
  return answer
}

async function projectOf(api: Api, key: string) {
  const projects: any[] = await ask(api, 'GET', '/api/projects')
  const project = projects.find((candidate) => candidate.key === key.toUpperCase())
  if (!project)
    throw new Error(
      `No project with key ${key.toUpperCase()}. Known: ${projects.map((p) => p.key).join(', ')}`,
    )
  return project
}

async function issueOf(api: Api, key: string) {
  const wanted = key.toUpperCase()
  const hits: any[] = await ask(api, 'GET', `/api/search?q=${encodeURIComponent(wanted)}`)
  const hit = hits.find((candidate) => candidate.key === wanted)
  if (!hit) throw new Error(`No issue ${wanted}`)
  return hit
}

const text = (value: unknown) => ({
  content: [
    { type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 1) },
  ],
})

/** A tool that fails answers with the reason instead of breaking the connection. */
const guarded =
  <Args>(work: (args: Args) => Promise<unknown>) =>
  async (args: Args) => {
    try {
      return text(await work(args))
    } catch (error: any) {
      return { ...text(error.message), isError: true }
    }
  }

const minutes = (from: number, to: number) => Math.max(0, Math.round((to - from) / 60_000))

function boardView(board: any, status?: string) {
  const agents = new Map<number, string>(board.agents.map((agent: any) => [agent.id, agent.name]))
  const key = board.project.key
  const running = new Set<number>(board.runs.map((run: any) => run.issue_id))
  const columns: Record<string, unknown> = {}
  for (const name of STATUSES) {
    if (status && status !== name) continue
    const issues = board.issues
      .filter((issue: any) => issue.status === name)
      .sort((a: any, b: any) =>
        name === 'done' ? b.updated_at - a.updated_at : b.priority - a.priority || a.rank - b.rank,
      )
    const shown = name === 'done' && !status ? issues.slice(0, DONE_SHOWN) : issues
    columns[name] = {
      count: issues.length,
      issues: shown.map((issue: any) => ({
        key: `${key}-${issue.number}`,
        title: issue.title,
        priority: issue.priority,
        assignee: agents.get(issue.assignee_id) ?? null,
        ...(issue.blocked_by.length ? { blockedBy: issue.blocked_by.map((n: number) => `${key}-${n}`) } : {}),
        ...(running.has(issue.id) ? { running: true } : {}),
        ...(issue.landing ? { landing: issue.landing } : {}),
      })),
    }
  }
  return {
    project: { key, name: board.project.name, paused: !!board.project.paused },
    agents: board.agents.map((agent: any) => ({
      name: agent.name,
      role: agent.role,
      provider: agent.provider,
      enabled: !!agent.enabled,
    })),
    columns,
  }
}

function issueView(detail: any, projectKeyOf: string, agents: Map<number, string>, comments: number) {
  const { issue } = detail
  return {
    key: `${projectKeyOf}-${issue.number}`,
    title: issue.title,
    status: issue.status,
    priority: issue.priority,
    assignee: agents.get(issue.assignee_id) ?? null,
    createdBy: issue.created_by || null,
    description: issue.description,
    checklist: issue.checklist ?? [],
    blockedBy: detail.links.blockers.map((link: any) => ({
      key: `${projectKeyOf}-${link.number}`,
      title: link.title,
      status: link.status,
    })),
    blocks: detail.links.dependents.map((link: any) => ({
      key: `${projectKeyOf}-${link.number}`,
      title: link.title,
      status: link.status,
    })),
    runs: detail.runs.map((run: any) => ({
      agent: run.agent_name,
      provider: run.provider,
      model: run.model,
      kind: run.kind,
      status: run.status,
      verdict: run.verdict || null,
      minutes: minutes(run.started_at, run.ended_at ?? Date.now()),
      costUsd: Math.round(run.cost_usd * 100) / 100,
    })),
    comments: detail.comments.slice(-comments).map((comment: any) => ({
      author: comment.author,
      kind: comment.kind,
      at: new Date(comment.created_at).toISOString(),
      body: comment.body.length > COMMENT_CHARS ? `${comment.body.slice(0, COMMENT_CHARS)}…` : comment.body,
    })),
    commentsTotal: detail.comments.length,
  }
}

function fleetView(overview: any) {
  return {
    projects: overview.projects.map((project: any) => ({
      key: project.key,
      name: project.name,
      paused: project.paused,
      issues: project.counts,
      running: project.running,
      costLast24hUsd: Math.round(project.costToday * 100) / 100,
    })),
    running: overview.running.map((run: any) => ({
      issue: `${run.projectKey}-${run.issueNumber}`,
      title: run.issueTitle,
      agent: run.agent,
      provider: run.provider,
      model: run.model,
      minutes: minutes(run.startedAt, Date.now()),
      doing: run.line,
    })),
    waitingForHuman: overview.inbox.map((item: any) => ({
      issue: `${item.projectKey}-${item.number}`,
      title: item.title,
      reason: item.reason,
    })),
    last24h: overview.totals,
    spendGuard: overview.guard,
    killSwitch: overview.killSwitch,
  }
}

const READS = { readOnlyHint: true, openWorldHint: false }
const WRITES = { readOnlyHint: false, destructiveHint: false, openWorldHint: false }

export function deckMcp(api: Api) {
  const server = new McpServer(
    { name: 'agentdeck', version: '1.0.0' },
    {
      instructions:
        'AgentDeck runs teams of coding agents on shared boards. Issues in "todo" are picked up by agents and cost money; ' +
        'file new work as "backlog" unless the user asked to start it. Use fleet_status first to see what is going on.',
    },
  )

  server.registerTool(
    'fleet_status',
    {
      title: 'Fleet status',
      description:
        'All projects at a glance: issue counts per status, agents running right now and what they do, issues waiting for a human, cost of the last 24 hours.',
      annotations: READS,
    },
    guarded(async () => fleetView(await ask(api, 'GET', '/api/overview'))),
  )

  server.registerTool(
    'list_projects',
    {
      title: 'List projects',
      description: 'Projects with their key, open issue count and running agents.',
      annotations: READS,
    },
    guarded(async () =>
      (await ask(api, 'GET', '/api/projects')).map((project: any) => ({
        key: project.key,
        name: project.name,
        paused: !!project.paused,
        openIssues: project.open,
        running: project.running,
      })),
    ),
  )

  server.registerTool(
    'get_board',
    {
      title: 'Read a board',
      description: `The board of one project: its agents and its issues per column. Without a status, "done" shows the ${DONE_SHOWN} most recent.`,
      inputSchema: { project: projectKey, status: z.enum(STATUSES).optional().describe('Only this column') },
      annotations: READS,
    },
    guarded(async ({ project, status }) => {
      const found = await projectOf(api, project)
      return boardView(await ask(api, 'GET', `/api/projects/${found.id}/board`), status)
    }),
  )

  server.registerTool(
    'get_issue',
    {
      title: 'Read an issue',
      description:
        'One issue with its description, checklist, blockers, agent runs (verdict, duration, cost) and latest comments.',
      inputSchema: {
        issue: issueKey,
        comments: z
          .number()
          .int()
          .min(0)
          .max(50)
          .optional()
          .describe('How many of the latest comments, default 10'),
      },
      annotations: READS,
    },
    guarded(async ({ issue, comments }) => {
      const hit = await issueOf(api, issue)
      const detail = await ask(api, 'GET', `/api/issues/${hit.id}`)
      const board = await ask(api, 'GET', `/api/projects/${detail.issue.project_id}/board`)
      const agents = new Map<number, string>(board.agents.map((agent: any) => [agent.id, agent.name]))
      return issueView(detail, hit.projectKey, agents, comments ?? 10)
    }),
  )

  server.registerTool(
    'search_issues',
    {
      title: 'Search issues',
      description: 'Finds issues across all projects by key, number or words in title and description.',
      inputSchema: { query: z.string().min(1).max(200) },
      annotations: READS,
    },
    guarded(async ({ query }) =>
      (await ask(api, 'GET', `/api/search?q=${encodeURIComponent(query)}`)).map((hit: any) => ({
        key: hit.key,
        title: hit.title,
        status: hit.status,
        project: hit.project,
        assignee: hit.assignee,
        ...(hit.excerpt ? { excerpt: hit.excerpt } : {}),
      })),
    ),
  )

  server.registerTool(
    'create_issue',
    {
      title: 'File an issue',
      description:
        'Files a new issue. It lands in "backlog" unless status is "todo"; an issue in "todo" is started by an agent as soon as a slot is free.',
      inputSchema: {
        project: projectKey,
        title: z.string().min(1).max(300),
        description: z
          .string()
          .max(20_000)
          .optional()
          .describe('Markdown. Sections "## Task", "## Files" and "## Done when" help the agents.'),
        status: z.enum(['backlog', 'todo']).optional(),
        priority: z.number().int().min(0).max(3).optional().describe('0 low to 3 urgent, default 1'),
        assignee: z.string().max(80).optional().describe('Name of the agent who should do it'),
        blockedBy: z
          .array(issueKey)
          .max(20)
          .optional()
          .describe('Issues of the same project that must be done first'),
      },
      annotations: WRITES,
    },
    guarded(async ({ project, title, description, status, priority, assignee, blockedBy }) => {
      const found = await projectOf(api, project)
      let assigneeId: number | undefined
      if (assignee) {
        const board = await ask(api, 'GET', `/api/projects/${found.id}/board`)
        const agent = board.agents.find(
          (candidate: any) => candidate.name.toLowerCase() === assignee.toLowerCase(),
        )
        if (!agent)
          throw new Error(`No agent "${assignee}". Known: ${board.agents.map((a: any) => a.name).join(', ')}`)
        assigneeId = agent.id
      }
      const blockers = (blockedBy ?? []).map((key) => {
        const [prefix, number] = key.toUpperCase().split('-')
        if (prefix !== found.key) throw new Error(`${key} is not in project ${found.key}`)
        return Number(number)
      })
      const created = await ask(api, 'POST', `/api/projects/${found.id}/issues`, {
        title,
        description: description ?? '',
        status: status ?? 'backlog',
        priority: priority ?? 1,
        assignee_id: assigneeId ?? null,
        blocked_by: blockers,
      })
      return { key: `${found.key}-${created.number}`, status: created.status }
    }),
  )

  server.registerTool(
    'comment_on_issue',
    {
      title: 'Comment on an issue',
      description: 'Adds a comment. The agent working on the issue reads it at its next run.',
      inputSchema: { issue: issueKey, body: z.string().min(1).max(20_000) },
      annotations: WRITES,
    },
    guarded(async ({ issue, body }) => {
      const hit = await issueOf(api, issue)
      await ask(api, 'POST', `/api/issues/${hit.id}/comments`, { body, author: 'Owner (MCP)' })
      return `Comment added to ${hit.key}.`
    }),
  )

  server.registerTool(
    'move_issue',
    {
      title: 'Move an issue',
      description:
        'Moves an issue to another column. "todo" queues it for an agent, "backlog" shelves it, "done" closes it (and lands its branch if the project lands on done). A running agent on the issue is stopped.',
      inputSchema: { issue: issueKey, status: z.enum(['backlog', 'todo', 'review', 'blocked', 'done']) },
      annotations: WRITES,
    },
    guarded(async ({ issue, status }) => {
      const hit = await issueOf(api, issue)
      const moved = await ask(api, 'PATCH', `/api/issues/${hit.id}`, { status })
      return { key: hit.key, status: moved.status }
    }),
  )

  server.registerTool(
    'start_arena',
    {
      title: 'Let several agents compete on an issue',
      description:
        'Starts an arena: two to four agents solve the same issue in parallel, each on its own branch, and a jury picks the best result. Only the winner is reviewed and landed. Costs one run per agent. The issue must be in backlog or todo.',
      inputSchema: {
        issue: issueKey,
        agents: z.array(z.string().max(80)).min(2).max(4).describe('Names of the agents that compete'),
      },
      annotations: WRITES,
    },
    guarded(async ({ issue, agents }) => {
      const hit = await issueOf(api, issue)
      const detail = await ask(api, 'GET', `/api/issues/${hit.id}`)
      const board = await ask(api, 'GET', `/api/projects/${detail.issue.project_id}/board`)
      const ids = agents.map((name) => {
        const agent = board.agents.find(
          (candidate: any) => candidate.name.toLowerCase() === name.toLowerCase(),
        )
        if (!agent)
          throw new Error(`No agent "${name}". Known: ${board.agents.map((a: any) => a.name).join(', ')}`)
        return agent.id
      })
      const started = await ask(api, 'POST', `/api/issues/${hit.id}/arena`, { agents: ids })
      return {
        issue: hit.key,
        entries: started.entries.map((entry: any) => ({
          key: `${hit.projectKey}-${entry.number}`,
          agent: entry.agent,
        })),
      }
    }),
  )

  server.registerTool(
    'stop_run',
    {
      title: 'Stop the agent on an issue',
      description:
        'Stops the agent that is working on the issue right now; the issue goes back to the backlog.',
      inputSchema: { issue: issueKey },
      annotations: WRITES,
    },
    guarded(async ({ issue }) => {
      const hit = await issueOf(api, issue)
      const { stopped } = await ask(api, 'POST', `/api/issues/${hit.id}/stop`)
      return stopped ? `Stopped the run on ${hit.key}.` : `Nothing was running on ${hit.key}.`
    }),
  )

  return server
}

/** Answers one MCP request (Streamable HTTP, JSON answers). */
export async function handleDeckMcp(request: Request, api: Api) {
  const server = deckMcp(api)
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  })
  await server.connect(transport)
  try {
    return await transport.handleRequest(request)
  } finally {
    void server.close().catch(() => {})
  }
}
