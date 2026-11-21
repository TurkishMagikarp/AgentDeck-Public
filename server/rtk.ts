// RTK shortens command output before it reaches the model. Every agent writes its savings to
// a database of its own, so the board can show who saved how much.
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { DATA_DIR, all } from './db.ts'

const execFileAsync = promisify(execFile)

export type Savings = { commands: number; input: number; output: number; saved: number }

const NONE: Savings = { commands: 0, input: 0, output: 0, saved: 0 }

const folderOf = (projectKey: string) => join(DATA_DIR, 'rtk', projectKey)
const databaseOf = (projectKey: string, agentId: number) => join(folderOf(projectKey), `agent-${agentId}.db`)

/** Environment that makes RTK record an agent's savings in that agent's own database. */
export function rtkEnv(projectKey: string, agentId: number): Record<string, string> {
  mkdirSync(folderOf(projectKey), { recursive: true })
  return { RTK_DB_PATH: databaseOf(projectKey, agentId), RTK_TELEMETRY_DISABLED: '1' }
}

async function savingsIn(database: string): Promise<Savings> {
  if (!existsSync(database)) return NONE
  const { stdout } = await execFileAsync('rtk', ['gain', '--format', 'json'], {
    env: { ...process.env, RTK_DB_PATH: database },
    timeout: 15_000,
  })
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
  let installed = true
  const byAgent: (Savings & { agent: string })[] = []
  for (const agent of agents) {
    try {
      byAgent.push({ agent: agent.name, ...(await savingsIn(databaseOf(project.key, agent.id))) })
    } catch {
      installed = false
      break
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
