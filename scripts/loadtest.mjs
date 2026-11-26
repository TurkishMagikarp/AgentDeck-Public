// Load test against a running AgentDeck instance that was started with AGENTDECK_MOCK=1.
// Usage: node scripts/loadtest.mjs [baseUrl] [issues] [agents]
import { performance } from 'node:perf_hooks'

const BASE = process.argv[2] ?? 'http://localhost:8796'
const ISSUES = Number(process.argv[3] ?? 5000)
const AGENTS = Number(process.argv[4] ?? 40)

const api = async (method, path, body) => {
  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body && JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status}`)
  return res.json()
}

const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]

/** Runs `total` calls with `parallel` in flight and reports latency percentiles. */
async function measure(label, total, parallel, call) {
  const times = []
  let next = 0
  const started = performance.now()
  const worker = async () => {
    while (next < total) {
      const index = next++
      const t = performance.now()
      await call(index)
      times.push(performance.now() - t)
    }
  }
  await Promise.all(Array.from({ length: parallel }, worker))
  const seconds = (performance.now() - started) / 1000
  times.sort((a, b) => a - b)
  const ms = (value) => value.toFixed(1).padStart(7) + ' ms'
  console.log(
    `${label.padEnd(34)} ${String(Math.round(total / seconds)).padStart(6)}/s   p50 ${ms(percentile(times, 0.5))}   p99 ${ms(percentile(times, 0.99))}`,
  )
}

// One SSE connection that only counts what arrives.
async function listen(projectId, counter, signal) {
  const res = await fetch(`${BASE}/api/events?project=${projectId}`, { signal })
  const reader = res.body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      counter.bytes += value.length
      counter.chunks++
    }
  } catch {
    // aborted at the end of the test
  }
}

console.log(`Target ${BASE}: ${ISSUES} issues, ${AGENTS} parallel mock agents\n`)

const agents = Array.from({ length: 8 }, (_, i) => ({
  name: `Agent-${i + 1}`,
  provider: 'mock',
  max_instances: Math.ceil(AGENTS / 8),
}))
const issues = Array.from({ length: ISSUES }, (_, i) => ({
  title: `Load test issue ${i + 1} with a title of the usual length`,
  description: 'Description with acceptance criteria. '.repeat(8),
  status: 'backlog',
  priority: i % 4,
}))

let t = performance.now()
const { projectId } = await api('POST', '/blueprint', {
  project: { key: 'LOAD', name: 'Load test', settings: { maxConcurrent: AGENTS } },
  agents,
  issues,
})
console.log(`Blueprint with ${ISSUES} issues created in ${Math.round(performance.now() - t)} ms`)

const board = await fetch(`${BASE}/api/projects/${projectId}/board`)
const boardBytes = (await board.arrayBuffer()).byteLength
console.log(`Board response: ${(boardBytes / 1024).toFixed(0)} KB uncompressed\n`)

await measure('Read board (warm cache)', 2000, 50, () => api('GET', `/projects/${projectId}/board`))
await measure('Read issue details', 2000, 50, (i) => api('GET', `/issues/${(i % ISSUES) + 1}`))
await measure('Create issue', 1000, 20, (i) =>
  api('POST', `/projects/${projectId}/issues`, { title: `New ${i}` }),
)
await measure('Write comment', 2000, 20, (i) =>
  api('POST', `/issues/${(i % ISSUES) + 1}/comments`, { body: 'Comment' }),
)
await measure('Read board under write load', 500, 10, async (i) => {
  await api('PATCH', `/issues/${(i % ISSUES) + 1}`, { priority: i % 4 })
  await api('GET', `/projects/${projectId}/board`)
})

// Agents under load: move a batch to "todo" and let the scheduler drain it while 100 browsers listen.
const BATCH = Math.min(ISSUES, 600)
const counter = { bytes: 0, chunks: 0 }
const abort = new AbortController()
for (let i = 0; i < 100; i++) listen(projectId, counter, abort.signal)

t = performance.now()
await measure('Move issue to "To Do"', BATCH, 20, (i) =>
  api('PATCH', `/issues/${i + 1}`, { status: 'todo' }),
)

let peakRunning = 0
let slowestPoll = 0
for (;;) {
  const p = performance.now()
  const state = await api('GET', `/projects/${projectId}/board`)
  slowestPoll = Math.max(slowestPoll, performance.now() - p)
  peakRunning = Math.max(peakRunning, state.runs.length)
  const open = state.issues.filter(
    (issue) => issue.status === 'todo' || issue.status === 'in_progress',
  ).length
  if (!open) break
  await new Promise((resolve) => setTimeout(resolve, 250))
}
const seconds = (performance.now() - t) / 1000
abort.abort()

console.log(
  `\n${BATCH} issues worked through by agents in ${seconds.toFixed(1)} s (${(BATCH / seconds).toFixed(1)} runs/s)`,
)
console.log(`Peak number of agents running at once: ${peakRunning}`)
console.log(`Slowest board fetch meanwhile: ${slowestPoll.toFixed(1)} ms`)
console.log(`100 SSE clients received ${(counter.bytes / 1024 / 1024).toFixed(1)} MB in total`)
