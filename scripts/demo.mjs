// A fleet to look at without any login or key: starts AgentDeck with mock agents on its own data
// folder, builds a small team from a template, files a few issues and lets the agents work.
//   npm run demo            then open http://localhost:8798
// Mock agents cost nothing and change no repository. Stop with Ctrl+C; the folder data-demo can
// be deleted afterwards.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

const PORT = process.env.PORT ?? '8798'
const base = `http://127.0.0.1:${PORT}`

const EXTRA_ISSUES = [
  [
    'Cart survives a reload',
    'The cart lives in localStorage and is still there after a reload.',
  ],
  ['Search that tolerates typos', 'The product search finds "shoes" for "sheos" too.'],
  ['Order confirmation by email', 'After a purchase an email goes out with the order number and the items.'],
  ['Dark mode', 'Follows the system setting, with a switch in the header.'],
]

const ticket = ([title, goal]) => ({
  title,
  status: 'todo',
  description: `## Goal\n${goal}\n\n## Task\nBuild it and cover it with a test.\n\n## Files\nsrc/\n\n## Done when\n- The test is green.`,
})

async function call(method, path, body) {
  const response = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`)
  return response.json()
}

async function waitForServer() {
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      if ((await fetch(`${base}/api/projects`)).ok) return
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error('The server did not start.')
}

async function seed() {
  if ((await call('GET', '/api/projects')).length) return
  const { projectId } = await call('POST', '/api/templates/saas', { key: 'SHOP', name: 'Demo shop' })
  const board = await call('GET', `/api/projects/${projectId}/board`)
  for (const agent of board.agents)
    await call('PATCH', `/api/agents/${agent.id}`, { provider: 'mock', model: '', provider_override: true })
  for (const issue of EXTRA_ISSUES) await call('POST', `/api/projects/${projectId}/issues`, ticket(issue))
  await call('PATCH', `/api/projects/${projectId}`, { paused: false })
}

if (!existsSync('dist/index.html')) {
  console.error('The interface is not built yet: run "npm run build" first.')
  process.exit(1)
}

const server = spawn(process.execPath, ['server/main.ts'], {
  env: {
    ...process.env,
    PORT,
    AGENTDECK_MOCK: '1',
    AGENTDECK_MOCK_MS: process.env.AGENTDECK_MOCK_MS ?? '6000',
    AGENTDECK_DATA: process.env.AGENTDECK_DATA ?? './data-demo',
    AGENTDECK_SANDBOX: '0',
  },
  stdio: 'inherit',
})
server.on('exit', (code) => process.exit(code ?? 0))
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.kill())

try {
  await waitForServer()
  await seed()
  console.log(
    `\nAgentDeck demo is running: http://localhost:${PORT}\nMock agents work on the project "Demo shop". Stop with Ctrl+C.\n`,
  )
} catch (error) {
  console.error(error.message)
  server.kill()
  process.exit(1)
}
