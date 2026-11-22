#!/usr/bin/env node
// Board commands for a running agent. AgentDeck sets AGENTDECK_URL and AGENTDECK_RUN_TOKEN for
// the run; the token stops working when the run ends.
const BASE = process.env.AGENTDECK_URL
const TOKEN = process.env.AGENTDECK_RUN_TOKEN

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
    console.log('commented')
  },

  async unblock([number, blocker]) {
    await call('POST', `/issues/${number}/unblock`, { blocker: Number(blocker) })
    console.log(`issue ${number} no longer waits for ${blocker}`)
  },

  async learn(words) {
    await call('POST', '/lessons', { body: words.join(' ') })
    console.log('learned')
  },

  async create(_, options) {
    const created = await call('POST', '/issues', options)
    console.log(`created ${created.key}`)
  },
}

const [name, ...rest] = process.argv.slice(2)
const command = commands[name]

if (!BASE || !TOKEN) {
  console.error('agentdeck: only available inside an AgentDeck run')
  process.exit(2)
}
if (!command) {
  console.error(`Usage: agent-cli.mjs <${Object.keys(commands).join('|')}> ...`)
  process.exit(2)
}

const { positional, options } = parse(rest)
command(positional, options).catch((err) => {
  console.error(`agentdeck: ${err.message}`)
  process.exit(1)
})
