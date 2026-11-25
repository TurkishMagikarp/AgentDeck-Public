// Claude Managed Agents: Anthropic runs the agent loop, the tools run here. The environment is
// "self-hosted", so bash and the file tools work in the issue's own checkout on this server, and
// landing, reviews and the board commands behave exactly as with the CLI agents.
//
// One Managed Agent and one environment are created on first use and reused for every run. Each
// run is a session; a single worker polls the environment and binds every session's tools to the
// working directory and environment of the run that started it.
import Anthropic from '@anthropic-ai/sdk'
import { EnvironmentWorker } from '@anthropic-ai/sdk/helpers/beta/environments'
import { betaAgentToolset20260401 } from '@anthropic-ai/sdk/tools/agent-toolset/node'
import type { RunHandle, RunOpts, RunResult, Usage } from './adapters.ts'
import { apiKey, getSecret, runEnv } from './auth.ts'
import { get, run } from './db.ts'
import { prepareMcp } from './mcp.ts'
import { openManagedMcp, type ManagedMcp } from './managedMcp.ts'
import type { BetaRunnableTool } from '@anthropic-ai/sdk/lib/tools/BetaRunnableTool'
import { SANDBOX } from './sandbox.ts'

export const MANAGED = 'claude-managed'
export const ENVIRONMENT_KEY_SECRET = 'claude-managed.environment-key'
export const DEFAULT_RUN_LIMIT_USD = 5

const AGENT_SYSTEM = `You are a coding agent working for AgentDeck, a board where several agents share issues.
Your tools run in the issue's own git checkout on a Linux server; that checkout is your current directory.
You may install what you need (sudo apt-get, uv, npm). Work autonomously: nobody answers questions during a run.
When the task is finished, reply with your final message.`

const WEB_TOOLS_OFF = [
  { name: 'web_search' as const, enabled: false },
  { name: 'web_fetch' as const, enabled: false },
]

const FULL_TOOLSET = {
  type: 'agent_toolset_20260401' as const,
  default_config: { enabled: true, permission_policy: { type: 'always_allow' as const } },
  configs: WEB_TOOLS_OFF,
}

const READ_ONLY_TOOLSET = {
  ...FULL_TOOLSET,
  configs: [
    ...WEB_TOOLS_OFF,
    { name: 'bash' as const, enabled: false },
    { name: 'write' as const, enabled: false },
    { name: 'edit' as const, enabled: false },
  ],
}

const READ_ONLY_TOOLS = new Set(['read', 'glob', 'grep'])

const setting = (key: string): string => get('SELECT value FROM settings WHERE key=?', key)?.value ?? ''
const saveSetting = (key: string, value: string) =>
  run('INSERT OR REPLACE INTO settings (key, value) VALUES (?,?)', key, value)

export function managedRunLimitUsd() {
  const stored = Number(setting('managed.run_limit_usd'))
  return stored > 0 ? stored : DEFAULT_RUN_LIMIT_USD
}

export function setManagedRunLimitUsd(usd: number) {
  if (!(usd > 0 && usd <= 1000)) throw new Error('The limit per run must be between 0 and 1000 USD')
  saveSetting('managed.run_limit_usd', String(Math.round(usd * 100) / 100))
}

export function managedStatus() {
  return {
    environmentId: setting('managed.environment_id'),
    hasEnvironmentKey: !!getSecret(ENVIRONMENT_KEY_SECRET),
    runLimitUsd: managedRunLimitUsd(),
  }
}

function controlClient() {
  const key = apiKey(MANAGED)
  if (!key) throw new Error('No API key is stored for Claude Managed Agents')
  return new Anthropic({ apiKey: key, authToken: null })
}

/** Creates the environment and the agent once; later calls only bring the agent up to date. */
export async function ensureManagedSetup() {
  const client = controlClient()

  let environmentId = setting('managed.environment_id')
  if (!environmentId) {
    const environment = await client.beta.environments.create({
      name: 'AgentDeck',
      config: { type: 'self_hosted' },
    })
    environmentId = environment.id
    saveSetting('managed.environment_id', environmentId)
  }

  const agentConfig = {
    name: 'AgentDeck',
    model: 'claude-opus-5-5',
    system: AGENT_SYSTEM,
    tools: [FULL_TOOLSET],
  }
  const configJson = JSON.stringify(agentConfig)
  let agentId = setting('managed.agent_id')
  if (!agentId) {
    agentId = (await client.beta.agents.create(agentConfig)).id
    saveSetting('managed.agent_id', agentId)
    saveSetting('managed.agent_config', configJson)
  } else if (setting('managed.agent_config') !== configJson) {
    await client.beta.agents.update(agentId, agentConfig)
    saveSetting('managed.agent_config', configJson)
  }

  return { client, environmentId, agentId }
}

// ---------- the worker that executes the tools ----------

type SessionBinding = {
  cwd: string
  env: Record<string, string>
  readOnly: boolean
  mcpTools: BetaRunnableTool[]
}

const sessions = new Map<string, SessionBinding>()
let worker: { key: string; abort: AbortController } | undefined

/** Environment for bash: like the CLI agents, but never with AgentDeck's or Anthropic's own credentials. */
function toolEnv(extra: Record<string, string> = {}) {
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(runEnv(MANAGED, 'managed'))) {
    if (value !== undefined && !name.startsWith('ANTHROPIC_')) env[name] = value
  }
  return { ...env, ...extra }
}

function ensureWorker(environmentId: string) {
  const environmentKey = getSecret(ENVIRONMENT_KEY_SECRET)
  if (!environmentKey) {
    throw new Error(
      'The environment key for Claude Managed Agents is missing (create it at the environment in the Claude Console)',
    )
  }
  if (worker?.key === environmentKey && !worker.abort.signal.aborted) return
  worker?.abort.abort()

  const abort = new AbortController()
  worker = { key: environmentKey, abort }
  const client = new Anthropic({ authToken: environmentKey, apiKey: null })

  const keepRunning = async () => {
    while (!abort.signal.aborted) {
      try {
        await new EnvironmentWorker({
          client,
          environmentId,
          environmentKey,
          memorySyncIntervalMs: null,
          signal: abort.signal,
          tools: (ctx) => {
            const sessionId = ctx.session?.id ?? ctx.sessionId ?? ''
            const binding = sessions.get(sessionId)
            // A session from before a restart has no run waiting for it any more.
            if (!binding) return []
            const tools = betaAgentToolset20260401({ ...ctx, workdir: binding.cwd, env: binding.env })
            if (binding.readOnly) return tools.filter((tool) => READ_ONLY_TOOLS.has(tool.name))
            return [...tools, ...binding.mcpTools]
          },
        }).run()
      } catch (err: any) {
        if (abort.signal.aborted) return
        console.error('managed agents worker', err?.message ?? err)
        await new Promise((resolve) => setTimeout(resolve, 5_000))
      }
    }
  }
  void keepRunning()
}

// ---------- one run = one session ----------

const short = (text: string, max = 400) => (text.length > max ? text.slice(0, max) + '…' : text)

function usageOf(session: Anthropic.Beta.Sessions.BetaManagedAgentsSession): Usage {
  const u = session.usage ?? {}
  const cacheWrites = Object.values(u.cache_creation ?? {}).reduce<number>(
    (sum, value) => sum + (typeof value === 'number' ? value : 0),
    0,
  )
  const cached = u.cache_read_input_tokens ?? 0
  return {
    input: (u.input_tokens ?? 0) + cached + cacheWrites,
    output: u.output_tokens ?? 0,
    cached,
    // list_cost is in cents and includes the session's running time.
    cost: Number(u.list_cost?.amount ?? 0) / 100,
  }
}

export function startManagedRun(opts: RunOpts, model: string): RunHandle {
  // The worker runs the agent's tools inside the server process, as the server's user. In the
  // sandbox that would give the agent the database, the keys and every project, so managed runs
  // stay off there until the worker runs its tools as the project user.
  if (SANDBOX) {
    throw new Error(
      "Claude Managed Agents are locked in the sandbox: their tools would run with the server's rights. Switch the agent to another provider.",
    )
  }
  if (process.platform === 'win32') {
    throw new Error(
      'Claude Managed Agents only run on the Linux server (the tools need /bin/bash)',
    )
  }

  const abort = new AbortController()
  let sessionId = ''
  let client: Anthropic | undefined
  let stoppedByUs = false
  let mcp: ManagedMcp | undefined
  const activity = (line: string) => opts.onActivity?.(line)

  async function execute(): Promise<RunResult> {
    const setup = await ensureManagedSetup()
    client = setup.client
    ensureWorker(setup.environmentId)

    // Like the CLI agents, the agent also gets each connection's key under its usual variable name.
    const env = toolEnv({ ...prepareMcp('managed', opts.mcp ?? [], '').env, ...opts.env })
    if (opts.autonomous && opts.mcp?.length) mcp = await openManagedMcp(opts.mcp, env, activity)
    const tools = !opts.autonomous
      ? [READ_ONLY_TOOLSET]
      : mcp?.definitions.length
        ? [FULL_TOOLSET, ...mcp.definitions]
        : undefined

    const effort = opts.effort || 'high'
    const session = await client.beta.sessions.create(
      {
        agent: {
          type: 'agent_with_overrides',
          id: setup.agentId,
          model: { id: model, effort: effort as any },
          ...(tools ? { tools } : {}),
        },
        environment_id: setup.environmentId,
        title: short(opts.prompt.match(/## Issue [^\n]*/)?.[0] ?? 'AgentDeck run', 200),
        budget: {
          type: 'limit',
          max_list_cost: { amount: String(Math.round(managedRunLimitUsd() * 100)), currency: 'USD' },
        },
      },
      { signal: abort.signal },
    )
    sessionId = session.id
    sessions.set(sessionId, {
      cwd: opts.cwd,
      env,
      readOnly: !opts.autonomous,
      mcpTools: mcp?.tools ?? [],
    })
    activity(`Managed-Agents-Session ${sessionId}`)

    try {
      return await follow(client, sessionId)
    } finally {
      sessions.delete(sessionId)
    }
  }

  async function follow(client: Anthropic, sessionId: string): Promise<RunResult> {
    const seen = new Set<string>()
    let text = ''
    let error: string | undefined
    let started = false
    let messageSent = false

    /** Returns a result once the session has finished its turn, otherwise undefined. */
    const handle = (event: any): RunResult | undefined | 'done' => {
      if (seen.has(event.id)) return
      seen.add(event.id)
      switch (event.type) {
        case 'session.status_running':
          started = true
          return
        case 'agent.message': {
          const said = event.content
            .filter((block: any) => block.type === 'text')
            .map((block: any) => block.text)
            .join('')
          if (said) {
            activity((text = said))
            opts.onEvent?.({ kind: 'assistant', text: said })
          }
          return
        }
        case 'agent.tool_use':
        case 'agent.mcp_tool_use':
        case 'agent.custom_tool_use':
          activity(`${event.name}: ${JSON.stringify(event.input ?? {})}`)
          opts.onEvent?.({ kind: 'tool_call', name: String(event.name ?? 'tool'), text: JSON.stringify(event.input ?? {}) })
          return
        case 'session.error': {
          const message = event.error?.message ?? event.error?.type ?? 'error'
          activity(`Error: ${message}`)
          opts.onEvent?.({ kind: 'error', text: String(message) })
          if (event.error?.retry_status?.type !== 'retrying') error = short(String(message))
          return
        }
        case 'session.status_idle': {
          if (!started) return
          const reason = event.stop_reason?.type
          if (reason === 'requires_action') return
          if (reason === 'end_turn') return 'done'
          if (reason === 'budget_reached')
            error = `Limit per run (${managedRunLimitUsd()} USD) reached, the run was stopped`
          else if (reason === 'refusal') error = 'Claude refused the task'
          else error = error ?? `Session stopped (${reason ?? 'unknown'})`
          return 'done'
        }
        case 'session.status_terminated':
          return 'done'
      }
    }

    // A dropped stream has no replay, so after every reconnect we read the history once.
    for (let attempt = 0; ; attempt++) {
      try {
        const stream = await client.beta.sessions.events.stream(sessionId, {}, { signal: abort.signal })
        if (!messageSent) {
          messageSent = true
          await client.beta.sessions.events.send(sessionId, {
            events: [{ type: 'user.message', content: [{ type: 'text', text: opts.prompt }] }],
          })
        } else {
          for await (const event of client.beta.sessions.events.list(sessionId)) {
            if (handle(event) === 'done') return finish()
          }
        }
        for await (const event of stream) {
          if (handle(event) === 'done') return finish()
        }
      } catch (err: any) {
        if (abort.signal.aborted) throw err
        if (attempt >= 20) throw err
        activity(`Connection to the session lost, reconnecting…`)
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(30_000, 1_000 * 2 ** attempt)))
    }

    async function finish(): Promise<RunResult> {
      const usage = usageOf(await client.beta.sessions.retrieve(sessionId))
      return { ok: !error && !!text, text, usage, error: error ?? (text ? undefined : 'No answer') }
    }
  }

  const empty: Usage = { input: 0, output: 0, cost: 0 }
  const done = execute()
    .catch(async (err: any): Promise<RunResult> => {
      let usage = empty
      if (client && sessionId) {
        try {
          usage = usageOf(await client.beta.sessions.retrieve(sessionId))
        } catch {}
      }
      return {
        ok: false,
        text: '',
        usage,
        error: stoppedByUs ? 'gestoppt' : short(String(err?.message ?? err)),
      }
    })
    .finally(() => mcp?.close())

  return {
    kill() {
      stoppedByUs = true
      abort.abort()
      if (client && sessionId) {
        client.beta.sessions.events.send(sessionId, { events: [{ type: 'user.interrupt' }] }).catch(() => {})
      }
    },
    done,
  }
}
