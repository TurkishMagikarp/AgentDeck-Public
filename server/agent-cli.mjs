#!/usr/bin/env node
// Board commands for a running agent. AgentDeck sets AGENTDECK_URL and AGENTDECK_RUN_TOKEN for
// the run; the token stops working when the run ends.
const BASE = process.env.AGENTDECK_URL
const TOKEN = process.env.AGENTDECK_RUN_TOKEN

// The CLI speaks the language of the run's project (AGENTDECK_LANG), English when it is not set.
const TEXTS = {
  en: {
    commented: 'commented',
    unblocked: (number, blocker) => `issue ${number} no longer waits for ${blocker}`,
    installed: 'installed',
    learned: 'learned',
    created: (key) => `created ${key}`,
    connected: (id) => `${id} is loaded in the next run on this issue; end this run with status handoff:<your name>`,
    outsideRun: 'agentdeck: only available inside an AgentDeck run',
    usage: 'Usage',
  },
  de: {
    commented: 'kommentiert',
    unblocked: (number, blocker) => `Issue ${number} wartet nicht mehr auf ${blocker}`,
    installed: 'installiert',
    learned: 'gemerkt',
    created: (key) => `${key} angelegt`,
    connected: (id) =>
      `${id} ist im nächsten Lauf an diesem Issue geladen; beende diesen Lauf mit dem Status handoff:<dein Name>`,
    outsideRun: 'agentdeck: nur innerhalb eines AgentDeck-Laufs verfügbar',
    usage: 'Aufruf',
  },
}
const text = TEXTS[process.env.AGENTDECK_LANG === 'de' ? 'de' : 'en']

async function call(method, path, body) {
  const res = await fetch(`${BASE}/api/agent${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
  return data
}

/** Splits "show 12 --status todo" into positional arguments and --options. */
function parse(argv) {
  const positional = []
  const options = {}
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) options[argv[i].slice(2).replace(/-/g, '_')] = argv[++i] ?? ''
    else positional.push(argv[i])
  }
  return { positional, options }
}

const commands = {
  async list(_, options) {
    const query = options.status ? `?status=${encodeURIComponent(options.status)}` : ''
    for (const issue of await call('GET', `/issues${query}`)) {
      console.log(`${issue.number}\t${issue.status}\t${issue.assignee ?? '-'}\t${issue.title}`)
    }
  },

  async show([number]) {
    const { issue, comments } = await call('GET', `/issues/${number}`)
    console.log(`#${issue.number} [${issue.status}] ${issue.title}\n\n${issue.description}`)
    if (issue.handoff) console.log(`\nHandoff: ${issue.handoff}`)
    for (const comment of comments) console.log(`\n--- ${comment.author} (${comment.kind})\n${comment.body}`)
  },

  async comment([number, ...words]) {
    await call('POST', `/issues/${number}/comments`, { body: words.join(' ') })
    console.log(text.commented)
  },

  async unblock([number, blocker]) {
    await call('POST', `/issues/${number}/unblock`, { blocker: Number(blocker) })
    console.log(text.unblocked(number, blocker))
  },

  async install(names) {
    const { output } = await call('POST', '/packages', { names: names.join(' ') })
    console.log(output || text.installed)
  },

  async connect([id]) {
    await call('POST', '/connections', { id })
    console.log(text.connected(id))
  },

  async learn(words) {
    await call('POST', '/lessons', { body: words.join(' ') })
    console.log(text.learned)
  },

  async create(_, options) {
    const created = await call('POST', '/issues', options)
    console.log(text.created(created.key))
  },
}

const [name, ...rest] = process.argv.slice(2)
const command = commands[name]

if (!BASE || !TOKEN) {
  console.error(text.outsideRun)
  process.exit(2)
}
if (!command) {
  console.error(`${text.usage}: agent-cli.mjs <${Object.keys(commands).join('|')}> ...`)
  process.exit(2)
}

const { positional, options } = parse(rest)
command(positional, options).catch((err) => {
  console.error(`agentdeck: ${err.message}`)
  process.exit(1)
})
