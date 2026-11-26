// A fleet to look at without any login or key: starts AgentDeck with mock agents on its own data
// folder, builds a small team from a template, files a few issues and lets the agents work.
//   npm run demo            then open http://localhost:8798
// Mock agents cost nothing and change no repository. Stop with Ctrl+C; the folder data-demo can
// be deleted afterwards. AGENTDECK_LANG=de|en picks the language of the demo (default en).
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

const PORT = process.env.PORT ?? '8798'
const base = `http://127.0.0.1:${PORT}`

const LANG = process.env.AGENTDECK_LANG === 'de' ? 'de' : 'en'

const TEXTS = {
  de: {
    project: 'Demo-Shop',
    issues: [
      [
        'Warenkorb übersteht einen Reload',
        'Der Warenkorb liegt im localStorage und ist nach dem Neuladen noch da.',
      ],
      ['Suche mit Tippfehler-Toleranz', 'Die Produktsuche findet „Schuhe“ auch bei „Shcuhe“.'],
      ['Bestellbestätigung per Mail', 'Nach dem Kauf geht eine Mail mit Bestellnummer und Positionen raus.'],
      ['Dark Mode', 'Folgt der Einstellung des Systems, mit Umschalter in der Kopfzeile.'],
    ],
    task: 'Umsetzen und mit einem Test absichern.',
    doneWhen: 'Der Test läuft grün.',
    notStarted: 'Der Server ist nicht gestartet.',
    notBuilt: 'Die Oberfläche ist noch nicht gebaut: erst "npm run build".',
    running: (url) =>
      `AgentDeck-Demo läuft: ${url}\nMock-Agenten arbeiten am Projekt „Demo-Shop“. Beenden mit Strg+C.`,
  },
  en: {
    project: 'Demo shop',
    issues: [
      ['Cart survives a reload', 'The cart is kept in localStorage and is still there after a reload.'],
      ['Search with typo tolerance', 'The product search finds "shoes" for "sheos" as well.'],
      ['Order confirmation by mail', 'After the purchase a mail with order number and items goes out.'],
      ['Dark mode', 'Follows the system setting, with a switch in the header.'],
    ],
    task: 'Implement it and cover it with a test.',
    doneWhen: 'The test passes.',
    notStarted: 'The server did not start.',
    notBuilt: 'The UI is not built yet: run "npm run build" first.',
    running: (url) =>
      `AgentDeck demo is running: ${url}\nMock agents are working on the project "Demo shop". Stop with Ctrl+C.`,
  },
}
const text = TEXTS[LANG]

const ticket = ([title, goal]) => ({
  title,
  status: 'todo',
  description: `## Goal\n${goal}\n\n## Task\n${text.task}\n\n## Files\nsrc/\n\n## Done when\n- ${text.doneWhen}`,
})

async function call(method, path, body) {
  const response = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', 'x-agentdeck-lang': LANG },
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
  throw new Error(text.notStarted)
}

async function seed() {
  if ((await call('GET', '/api/projects')).length) return
  const { projectId } = await call('POST', '/api/templates/saas', { key: 'SHOP', name: text.project })
  const board = await call('GET', `/api/projects/${projectId}/board`)
  for (const agent of board.agents)
    await call('PATCH', `/api/agents/${agent.id}`, { provider: 'mock', model: '', provider_override: true })
  for (const issue of text.issues) await call('POST', `/api/projects/${projectId}/issues`, ticket(issue))
  // A PATCH replaces the settings as a whole, so the template's own ones go back along with the language.
  await call('PATCH', `/api/projects/${projectId}`, {
    paused: false,
    settings: { ...board.project.settings, language: LANG },
  })
}

if (!existsSync('dist/index.html')) {
  console.error(text.notBuilt)
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
    AGENTDECK_LANG: LANG,
  },
  stdio: 'inherit',
})
server.on('exit', (code) => process.exit(code ?? 0))
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.kill())

try {
  await waitForServer()
  await seed()
  console.log(`\n${text.running(`http://localhost:${PORT}`)}\n`)
} catch (error) {
  console.error(error.message)
  server.kill()
  process.exit(1)
}
