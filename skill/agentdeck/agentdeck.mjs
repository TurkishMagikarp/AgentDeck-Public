#!/usr/bin/env node
// Small zero-dependency client for the AgentDeck API, used by the agentdeck skill.
import { readFileSync } from 'node:fs'

const BASE = (process.env.AGENTDECK_URL ?? 'http://localhost:8790').replace(/\/$/, '')
const TOKEN = process.env.AGENTDECK_TOKEN ?? ''
// The language of this script's own lines and of what the server answers: AGENTDECK_LANG=de or en.
const LANG = process.env.AGENTDECK_LANG === 'de' ? 'de' : 'en'

const TEXTS = {
  en: {
    noProject: (key, known) => `No project with key ${key}. Known: ${known || 'none'}`,
    providers: (list) => `\nAvailable providers: ${list}`,
    projectLine: (p) => `${p.key}\t${p.name}\topen issues: ${p.open}\trunning agents: ${p.running}`,
    usage: (rest) => `Usage: agentdeck.mjs ${rest}`,
    applied: (r) =>
      `${r.created ? 'Created' : 'Extended'} project ${r.key}: ${r.agents} agents, ${r.skills} skills, ${r.issues} issues`,
    agents: (list) => `Agents: ${list || 'none'}`,
  },
  de: {
    noProject: (key, known) => `Kein Projekt mit dem Key ${key}. Bekannt: ${known || 'keines'}`,
    providers: (list) => `\nVerfügbare Anbieter: ${list}`,
    projectLine: (p) => `${p.key}\t${p.name}\toffene Issues: ${p.open}\tlaufende Agenten: ${p.running}`,
    usage: (rest) => `Aufruf: agentdeck.mjs ${rest}`,
    applied: (r) =>
      `Projekt ${r.key} ${r.created ? 'angelegt' : 'erweitert'}: ${r.agents} Agenten, ${r.skills} Skills, ${r.issues} Issues`,
    agents: (list) => `Agenten: ${list || 'keine'}`,
  },
}
const text = TEXTS[LANG]

async function call(method, path, body) {
  const headers = { 'x-agentdeck-lang': LANG }
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
  if (!project) throw new Error(text.noProject(key, projects.map((p) => p.key).join(', ')))
  return project
}

const commands = {
  async guide() {
    const meta = await call('GET', '/meta')
    console.log(meta.blueprintGuide)
    console.log(text.providers(meta.providers.map((p) => p.id).join(', ')))
  },

  async projects() {
    for (const p of await call('GET', '/projects')) console.log(text.projectLine(p))
  },

  async apply(file) {
    if (!file) throw new Error(text.usage('apply <blueprint.json>'))
    const blueprint = JSON.parse(readFileSync(file, 'utf8'))
    const result = await call('POST', '/blueprint', blueprint)
    console.log(text.applied(result))
    console.log(`${BASE}/`)
  },

  async board(key) {
    if (!key) throw new Error(text.usage('board <KEY>'))
    const project = await findProject(key)
    const board = await call('GET', `/projects/${project.id}/board`)
    const agentName = (id) => board.agents.find((a) => a.id === id)?.name ?? '-'

    console.log(text.agents(board.agents.map((a) => `${a.name} (${a.provider}, x${a.max_instances})`).join(', ')))
    for (const issue of board.issues) {
      console.log(`${project.key}-${issue.number}\t${issue.status}\t${agentName(issue.assignee_id)}\t${issue.title}`)
    }
  },
}

const [name, ...args] = process.argv.slice(2)
const command = commands[name]

if (!command) {
  console.error(text.usage(`<${Object.keys(commands).join('|')}> [args]`))
  process.exit(2)
}

command(...args).catch((err) => {
  console.error(`agentdeck: ${err.message}`)
  process.exit(1)
})
