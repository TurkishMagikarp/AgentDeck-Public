// CPU budget check: starts AgentDeck with mock agents, runs the load test against it and then
// measures how much CPU the idle server burns. Fails when a budget is exceeded, so a change that
// makes the server busier shows up in CI, not on the production host.
// Usage: node scripts/cpubench.mjs [issues] [idleSeconds]   (Linux: reads /proc for the CPU time)
// Budgets: CPU_BUDGET_LOAD_MS (whole load test), CPU_BUDGET_IDLE_MS_PER_MIN.
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ISSUES = Number(process.argv[2] ?? 1500)
const IDLE_SECONDS = Number(process.argv[3] ?? 30)
const LOAD_BUDGET = Number(process.env.CPU_BUDGET_LOAD_MS ?? 120_000)
const IDLE_BUDGET = Number(process.env.CPU_BUDGET_IDLE_MS_PER_MIN ?? 1_000)
const PORT = 18000 + Math.floor(Math.random() * 1000)

if (process.platform !== 'linux') {
  console.log('cpubench: reads /proc, runs on Linux only; skipped.')
  process.exit(0)
}

const ticks = Number(
  (await new Promise((resolve) => {
    const p = spawn('getconf', ['CLK_TCK'])
    let out = ''
    p.stdout.on('data', (d) => (out += d))
    p.on('close', () => resolve(out.trim() || '100'))
  })),
)
/** User plus system CPU time of a process in ms. */
const cpuMs = (pid) => {
  const fields = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ')
  return ((Number(fields[11]) + Number(fields[12])) * 1000) / ticks
}

const data = mkdtempSync(join(tmpdir(), 'agentdeck-bench-'))
const server = spawn(process.execPath, ['server/main.ts'], {
  env: { ...process.env, AGENTDECK_MOCK: '1', AGENTDECK_MOCK_MS: '50', AGENTDECK_DATA: data, PORT: String(PORT) },
  stdio: ['ignore', 'inherit', 'inherit'],
})
const base = `http://127.0.0.1:${PORT}`
let failed = false
try {
  for (let i = 0; ; i++) {
    if (i > 100) throw new Error('server did not start')
    if (await fetch(`${base}/api/meta`).then((r) => r.ok, () => false)) break
    await new Promise((r) => setTimeout(r, 200))
  }

  const beforeLoad = cpuMs(server.pid)
  await new Promise((resolve, reject) => {
    const load = spawn(process.execPath, ['scripts/loadtest.mjs', base, String(ISSUES), '16'], { stdio: 'inherit' })
    load.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`loadtest exited ${code}`))))
  })
  const loadMs = cpuMs(server.pid) - beforeLoad

  await new Promise((r) => setTimeout(r, 5_000)) // let the last runs settle
  const beforeIdle = cpuMs(server.pid)
  await new Promise((r) => setTimeout(r, IDLE_SECONDS * 1000))
  const idlePerMin = ((cpuMs(server.pid) - beforeIdle) * 60) / IDLE_SECONDS

  console.log(`\nServer CPU during the load test: ${Math.round(loadMs)} ms (budget ${LOAD_BUDGET})`)
  console.log(`Server CPU while idle: ${Math.round(idlePerMin)} ms/min (budget ${IDLE_BUDGET})`)
  if (loadMs > LOAD_BUDGET) failed = true
  if (idlePerMin > IDLE_BUDGET) failed = true
} finally {
  server.kill()
  rmSync(data, { recursive: true, force: true })
}
if (failed) {
  console.error('CPU budget exceeded')
  process.exit(1)
}
