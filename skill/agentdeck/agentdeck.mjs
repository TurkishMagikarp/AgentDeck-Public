#!/usr/bin/env node
// Small zero-dependency client for the AgentDeck API, used by the agentdeck skill.
import { readFileSync } from 'node:fs'

const BASE = (process.env.AGENTDECK_URL ?? 'http://localhost:8790').replace(/\/$/, '')
const TOKEN = process.env.AGENTDECK_TOKEN ?? ''

async function call(method, path, body) {
  const headers = {}
  if (TOKEN) headers.authorization = `Bearer ${TOKEN}`
  if (body) headers['content-type'] = 'application/json'

  const res = await fetch(`${BASE}/api${path}`, { method, headers, body: body && JSON.stringify(body) })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
  return data
}

async function findProject(key) {
  const projects = await call('GET', '/projects')
  const project = projects.find((p) => p.key === key.toUpperCase())
  if (!project) throw new Error(`No project with key ${key}. Known: ${projects.map((p) => p.key).join(', ') || 'none'}`)
  return project
}

const commands = {
  async guide() {
    const meta = await call('GET', '/meta')
    console.log(meta.blueprintGuide)
    console.log(`\nAvailable providers: ${meta.providers.map((p) => p.id).join(', ')}`)
  },

  async projects() {
    for (const p of await call('GET', '/projects')) {
      console.log(`${p.key}\t${p.name}\topen issues: ${p.open}\trunning agents: ${p.running}`)
    }
  },

  async apply(file) {
    if (!file) throw new Error('Usage: agentdeck.mjs apply <blueprint.json>')
    const blueprint = JSON.parse(readFileSync(file, 'utf8'))
    const result = await call('POST', '/blueprint', blueprint)
    const verb = result.created ? 'Created' : 'Extended'
    console.log(`${verb} project ${result.key}: ${result.agents} agents, ${result.skills} skills, ${result.issues} issues`)
    console.log(`${BASE}/`)
  },

  async board(key) {
    if (!key) throw new Error('Usage: agentdeck.mjs board <KEY>')
    const project = await findProject(key)
    const board = await call('GET', `/projects/${project.id}/board`)
    const agentName = (id) => board.agents.find((a) => a.id === id)?.name ?? '-'

    console.log(`Agents: ${board.agents.map((a) => `${a.name} (${a.provider}, x${a.max_instances})`).join(', ') || 'none'}`)
    for (const issue of board.issues) {
      console.log(`${project.key}-${issue.number}\t${issue.status}\t${agentName(issue.assignee_id)}\t${issue.title}`)
    }
  },
}

const [name, ...args] = process.argv.slice(2)
const command = commands[name]

if (!command) {
  console.error(`Usage: agentdeck.mjs <${Object.keys(commands).join('|')}> [args]`)
  process.exit(2)
}

command(...args).catch((err) => {
  console.error(`agentdeck: ${err.message}`)
  process.exit(1)
})
