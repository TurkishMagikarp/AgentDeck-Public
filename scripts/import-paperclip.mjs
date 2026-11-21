// Copies one Paperclip company into AgentDeck: agents, issues with their numbers, comments,
// blockers, review stages and the active routines. Reads Paperclip only, writes AgentDeck only.
//
//   node scripts/import-paperclip.mjs --paperclip http://127.0.0.1:3101 --auth /path/auth.json \
//     --company <company id> --agentdeck http://127.0.0.1:8790 --key ABC --repo /repos/<name>
//
// AGENTDECK_TOKEN must hold the board token of the AgentDeck instance. --dry writes the collected
// data to import-preview.json and sends nothing.
import { readFileSync, writeFileSync } from 'node:fs'

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : process.argv[index + 1]
}
const flag = (name) => process.argv.includes(`--${name}`)

const PAPERCLIP = option('paperclip', 'http://127.0.0.1:3101')
const COMPANY = option('company')
const AGENTDECK = option('agentdeck', 'http://127.0.0.1:8790')
const KEY = option('key')
const REPO = option('repo', '')
const WORKSPACE = option('workspace', 'agent')

if (!COMPANY || !KEY) {
  console.error('Missing --company or --key')
  process.exit(2)
}

const paperclipToken = JSON.parse(readFileSync(option('auth'), 'utf8')).credentials[PAPERCLIP].token

async function paperclip(path) {
  const res = await fetch(PAPERCLIP + path, { headers: { authorization: `Bearer ${paperclipToken}` } })
  if (!res.ok) throw new Error(`Paperclip ${path}: HTTP ${res.status}`)
  return res.json()
}

/** Runs `work` over all items with a few requests in flight; Paperclip gets slow under more. */
async function mapPool(items, parallel, work) {
  const results = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await work(items[index], index)
      if (index % 50 === 49) console.log(`  ${index + 1} / ${items.length}`)
    }
  }
  await Promise.all(Array.from({ length: parallel }, worker))
  return results
}

const numberOf = (identifier) => Number(String(identifier).split('-').pop())

const PROVIDER_OF_ADAPTER = { claude_local: 'anthropic', codex_local: 'openai', opencode_local: 'opencode' }
const PRIORITY = { low: 0, medium: 1, high: 2, urgent: 3, critical: 3 }
// AgentDeck has no "cancelled"; such issues arrive as done with a note. Work that was running is queued again.
const STATUS = {
  backlog: 'backlog',
  todo: 'todo',
  in_progress: 'todo',
  in_review: 'review',
  blocked: 'blocked',
  done: 'done',
  cancelled: 'done',
}

/** "0 7 * * *" becomes a daily routine, "0 *\/3 * * *" one that runs every three hours. */
function scheduleOf(cron) {
  const [minute, hour] = String(cron ?? '').split(' ')
  const everyHours = hour?.match(/^\*\/(\d+)$/)
  if (everyHours) return { schedule: 'interval', every_minutes: Number(everyHours[1]) * 60 }
  if (/^\d+$/.test(minute) && /^\d+$/.test(hour)) {
    return { schedule: 'daily', at: `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}` }
  }
  return null
}

console.log(`Reading company ${COMPANY} from ${PAPERCLIP}`)
const base = `/api/companies/${COMPANY}`
const [company, agents, projects, issueList, routines] = await Promise.all([
  paperclip(base),
  paperclip(`${base}/agents`),
  paperclip(`${base}/projects`),
  paperclip(`${base}/issues?limit=10000`),
  paperclip(`${base}/routines`),
])

const agentName = new Map(agents.map((agent) => [agent.id, agent.name]))

// Pausing an agent makes Paperclip set that agent's open issues to "blocked". Those issues are
// not stuck, they are open work, and must not arrive as something a human has to decide.
const pausedAt = new Map(agents.filter((agent) => agent.pausedAt).map((agent) => [agent.id, agent.pausedAt]))

function blockedOnlyByPause(issue) {
  const paused = pausedAt.get(issue.assigneeAgentId)
  return issue.status === 'blocked' && !!paused && (issue.blockedTransitionAt ?? '') >= paused
}
const projectName = new Map(projects.map((project) => [project.id, project.name]))

console.log(`Reading ${issueList.length} issues with their comments`)
const issues = await mapPool(issueList, 4, async (summary) => {
  const [issue, comments] = await Promise.all([
    paperclip(`/api/issues/${summary.id}`),
    paperclip(`/api/issues/${summary.id}/comments`),
  ])

  const reviewers = (issue.executionPolicy?.stages ?? [])
    .filter((stage) => stage.type === 'review')
    .flatMap((stage) => stage.participants.map((participant) => agentName.get(participant.agentId)))
    .filter(Boolean)

  // In review, Paperclip's assignee is the reviewer and the maker is remembered for the way back.
  const state = issue.executionState ?? {}
  const reviewerNow = agentName.get(state.currentParticipant?.agentId)
  const reviewIndex =
    issue.status === 'in_review' && state.currentStageType === 'review' ? reviewers.indexOf(reviewerNow) : -1
  const maker = agentName.get(state.returnAssignee?.agentId) ?? agentName.get(issue.assigneeAgentId)

  const imported = comments
    .filter((comment) => !comment.deletedAt && comment.body)
    .map((comment) => ({
      author: agentName.get(comment.authorAgentId) ?? (comment.authorType === 'user' ? 'Owner' : 'System'),
      kind: comment.authorAgentId ? 'agent' : comment.authorType === 'user' ? 'comment' : 'system',
      body: comment.body,
      created_at: comment.createdAt,
    }))
  if (issue.status === 'cancelled') {
    imported.push({
      author: 'System',
      kind: 'system',
      body: 'In Paperclip abgebrochen.',
      created_at: issue.cancelledAt,
    })
  }

  return {
    number: issue.issueNumber,
    title: issue.title,
    description: issue.description ?? '',
    status: blockedOnlyByPause(issue) ? 'todo' : (STATUS[issue.status] ?? 'backlog'),
    priority: PRIORITY[issue.priority] ?? 1,
    assignee: reviewIndex >= 0 ? reviewerNow : agentName.get(issue.assigneeAgentId),
    maker,
    review_index: reviewIndex,
    reviewers,
    group: projectName.get(issue.projectId) ?? '',
    model:
      issue.assigneeAdapterOverrides?.adapterConfig?.model ?? issue.assigneeAdapterOverrides?.model ?? '',
    blocked_by: (issue.blockedBy ?? []).map((blocker) => numberOf(blocker.identifier)),
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    comments: imported,
  }
})

const data = {
  project: {
    key: KEY,
    name: company.name ?? KEY,
    description: company.description ?? '',
    repo_path: REPO,
    settings: { workspace: WORKSPACE },
  },
  agents: agents.map((agent) => ({
    name: agent.name,
    role: agent.title ?? agent.role ?? '',
    provider: PROVIDER_OF_ADAPTER[agent.adapterType] ?? 'anthropic',
    model: agent.adapterConfig?.model ?? '',
    effort: agent.adapterConfig?.effort ?? agent.adapterConfig?.modelReasoningEffort ?? '',
    instructions: '',
  })),
  issues,
  routines: routines
    .filter((routine) => routine.status === 'active')
    .map((routine) => {
      const trigger = routine.triggers?.find(
        (candidate) => candidate.enabled && candidate.kind === 'schedule',
      )
      const schedule = scheduleOf(trigger?.cronExpression)
      return (
        schedule && {
          name: routine.title,
          agent: agentName.get(routine.assigneeAgentId),
          prompt: routine.description ?? '',
          ...schedule,
        }
      )
    })
    .filter(Boolean),
}

const byStatus = {}
for (const issue of issues) byStatus[issue.status] = (byStatus[issue.status] ?? 0) + 1
console.log(`Collected ${data.agents.length} agents, ${issues.length} issues`, byStatus)
console.log(
  `  ${issues.reduce((sum, issue) => sum + issue.comments.length, 0)} comments,`,
  `${issues.filter((issue) => issue.reviewers.length).length} issues with reviewers,`,
  `${issues.filter((issue) => issue.blocked_by.length).length} with blockers,`,
  `${data.routines.length} routines`,
)

if (flag('dry')) {
  writeFileSync('import-preview.json', JSON.stringify(data, null, 2))
  console.log('Dry run: wrote import-preview.json, nothing was sent.')
  process.exit(0)
}

const res = await fetch(`${AGENTDECK}/api/import`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    authorization: `Bearer ${process.env.AGENTDECK_TOKEN ?? ''}`,
  },
  body: JSON.stringify(data),
})
const result = await res.json().catch(() => ({}))
if (!res.ok) {
  console.error(`AgentDeck refused the import: ${result.error ?? res.status}`)
  process.exit(1)
}
console.log('Imported, project is paused:', result)
