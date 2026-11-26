// RTK shortens command output before it reaches the model. Every agent writes its savings to
// a database of its own, so the board can show who saved how much.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR, all } from './db.ts'
import { execIn, ownerRequired, SANDBOX } from './sandbox.ts'
import { safeEnv } from './auth.ts'

export type Savings = { commands: number; input: number; output: number; saved: number }

const NONE: Savings = { commands: 0, input: 0, output: 0, saved: 0 }

const folderOf = (projectKey: string) => join(DATA_DIR, 'rtk', projectKey)
const databaseOf = (projectKey: string, agentId: number) => join(folderOf(projectKey), `agent-${agentId}.db`)

let installed: boolean | undefined
export function rtkInstalled() {
  if (installed === undefined) {
    try {
      execFileSync('rtk', ['--version'], { stdio: 'ignore', timeout: 3_000, cwd: import.meta.dirname })
      installed = true
    } catch {
      installed = false
    }
  }
  return installed
}

export const RTK_INSTRUCTIONS =
  'RTK compacts supported shell commands. Use `rtk <command>` where supported; if compact output is insufficient, use `rtk bypass <command>`. Leave unsupported commands unchanged.'

/** Preserve MCP and other CLI settings when adding the packaged OpenCode plugin. */
export function withRtkPlugin(content: string | undefined, plugin: string) {
  const config = content ? JSON.parse(content) : {}
  const plugins: string[] = Array.isArray(config.plugin) ? config.plugin : []
  return JSON.stringify({ ...config, plugin: [...new Set([...plugins, plugin])] })
}

export function rtkRewriteResult(code: number, stdout: string, original: string) {
  if (code !== 0 && code !== 3) return original
  return stdout.trim() || original
}

/** DeepSeek's shell has no native CLI hook. Ask RTK under the same project identity as the command. */
export async function rewriteCommand(cwd: string, command: string, env: NodeJS.ProcessEnv) {
  if (!env.RTK_DB_PATH || env.RTK_DISABLED === '1' || !rtkInstalled()) return command
  if (SANDBOX) ownerRequired(cwd)
  try {
    const { stdout } = await execIn(cwd, 'rtk', ['rewrite', '--', command], { cwd, env, timeout: 3_000 })
    return rtkRewriteResult(0, stdout, command)
  } catch (error) {
    const { code, stdout } = error as { code: number; stdout?: string }
    return rtkRewriteResult(code, stdout ?? '', command)
  }
}

/** Environment that makes RTK record an agent's savings in that agent's own database. */
export function rtkEnv(projectKey: string, agentId: number): Record<string, string> {
  mkdirSync(folderOf(projectKey), { recursive: true })
  return { RTK_DB_PATH: databaseOf(projectKey, agentId), RTK_TELEMETRY_DISABLED: '1' }
}

async function savingsIn(folder: string, database: string): Promise<Savings> {
  // RTK may chmod its history directory to 0700. The board user then cannot stat the DB,
  // but the project user can. Do the existence check and gain lookup as that user.
  if (!existsSync(SANDBOX ? folder : database)) return NONE
  if (SANDBOX) ownerRequired(folder)
  const [cmd, args] = SANDBOX
    ? ['sh', ['-c', 'if [ -f "$RTK_DB_PATH" ]; then exec rtk gain --format json; fi']] as const
    : ['rtk', ['gain', '--format', 'json']] as const
  const { stdout } = await execIn(folder, cmd, [...args], {
    // The server starts sudo before the uid changes, so spawning with a private cwd would fail.
    cwd: import.meta.dirname,
    env: safeEnv({ RTK_DB_PATH: database, RTK_TELEMETRY_DISABLED: '1' }),
    timeout: 15_000,
  })
  if (!stdout.trim()) return NONE
  const summary = JSON.parse(stdout).summary ?? {}
  return {
    commands: summary.total_commands ?? 0,
    input: summary.total_input ?? 0,
    output: summary.total_output ?? 0,
    saved: summary.total_saved ?? 0,
  }
}

const cache = new Map<number, { at: number; report: unknown }>()

/** Savings per agent and in total. `installed` is false where RTK is not on this machine. */
export async function rtkReport(project: { id: number; key: string }) {
  const cached = cache.get(project.id)
  if (cached && Date.now() - cached.at < 60_000) return cached.report

  const agents = all('SELECT id, name FROM agents WHERE project_id=? ORDER BY name', project.id)
  const installed = rtkInstalled()
  const byAgent: (Savings & { agent: string })[] = []
  for (const agent of installed ? agents : []) {
    try {
      byAgent.push({ agent: agent.name, ...(await savingsIn(folderOf(project.key), databaseOf(project.key, agent.id))) })
    } catch (error) {
      console.warn(`RTK: Statistik für ${project.key}/${agent.id} nicht lesbar`, (error as Error).message)
    }
  }

  const total = byAgent.reduce(
    (sum, row) => ({
      commands: sum.commands + row.commands,
      input: sum.input + row.input,
      output: sum.output + row.output,
      saved: sum.saved + row.saved,
    }),
    NONE,
  )
  const report = { installed, total, byAgent: byAgent.filter((row) => row.commands > 0) }
  cache.set(project.id, { at: Date.now(), report })
  return report
}
