// Builds what an agent is told for one run. The next agent gets the handoff note and the
// latest comments, not the whole history: that is what keeps handovers cheap.
import { join } from 'node:path'
import { all } from './db.ts'
import { lessonsForPrompt } from './lessons.ts'
import { listShots, shotsDir } from './preview.ts'
import type { Workdir } from './workspace.ts'

export type RunKind = 'work' | 'review'

const ADHD_SUMMARY =
  'STRICT FORMAT, max 45 words total: line 1 = the outcome in one plain sentence. ' +
  'Then at most 3 bullets of max 8 words each. No intro, no explanations, no code.'

const AGENT_CLI = `## Board commands
You can read and write the shared board from the shell:
- \`node "$AGENTDECK_CLI" list [--status todo]\` lists issues.
- \`node "$AGENTDECK_CLI" show <number>\` prints an issue with its comments.
- \`node "$AGENTDECK_CLI" comment <number> "text"\` comments on an issue.
- \`node "$AGENTDECK_CLI" unblock <number> <blocker>\` removes a dependency: issue <number> no longer waits for <blocker>.
- \`node "$AGENTDECK_CLI" learn "text"\` records a lesson for every later run of this project: a build or test command, a pitfall, a tool you had to install. One sentence, only what is not obvious from the repo.
- \`node "$AGENTDECK_CLI" create --title "..." --description "..." [--assignee "Agent name"] [--status backlog|todo] [--blocked-by 12,13] [--reviewers "Name, Name"] [--group "..."]\` files a new issue.
A bug or doubt outside your issue becomes a new issue, it is not fixed on the side.`

const DECIDE_ALONE = `## You decide in the owner's place
This issue got stuck and there is no human to ask. Nobody will answer a question you leave open.
Read the comments to see why it hangs, then take exactly one of these ways:
- Settle what was open (answer the question, make the decision, fix the cause) and hand the issue back to the agent who does the work: status \`handoff:AGENT_NAME\`, with your decision in the handoff note.
- Finish it yourself: status \`done\`.
- Drop it because it is not worth doing or cannot be done: status \`done\`, say why in the summary, and file new issues with the board commands for whatever is still worth doing.
Do not use status \`blocked\`.`

function skillsOf(agent: any) {
  if (!agent.skill_ids.length) return []
  const placeholders = agent.skill_ids.map(() => '?').join(',')
  return all(`SELECT name, content FROM skills WHERE id IN (${placeholders})`, ...agent.skill_ids)
}

function latestComments(issueId: number) {
  return all(
    `SELECT author, body FROM comments WHERE issue_id=? AND kind IN ('comment','watchdog','review')
     ORDER BY id DESC LIMIT 5`,
    issueId,
  ).reverse()
}

function workRules(project: any, branch?: string) {
  const summary = project.settings.adhd
    ? `${ADHD_SUMMARY} Start line 1 with "Done:", "Partial:" or "Blocked:".`
    : 'What you did and the result, concise.'
  const where = branch ? ` (branch ${branch}); commit your changes on this branch, do not push` : ''

  return `## Rules
- Work only inside the current directory${where}.
- Stay within the scope of this issue. If something essential is unclear or needs a human decision, stop and use status "blocked".
- Answer in the language of the issue.
- End your final message with exactly these three blocks:
<summary>${summary}</summary>
<handoff>State of the work, open points, relevant files/commands. Max 120 words. The next worker reads only this.</handoff>
<status>done | review | blocked | handoff:AGENT_NAME</status>`
}

function reviewRules(project: any, makerName: string, branch?: string) {
  const summary = project.settings.adhd
    ? `${ADHD_SUMMARY} Start line 1 with "Approved:" or "Changes:".`
    : 'Your verdict. For "changes": each point concrete enough that the maker can fix it without asking.'
  const where = branch ? ` It holds the state of branch ${branch}.` : ''

  return `## Your task: review
${makerName} finished this issue and you are its reviewer. Check the result in the current directory against the issue and its source docs.${where}
- Review only. Do not change or commit anything.
- "approve" when it meets the issue. "changes" when the maker has to fix something. "blocked" only when a human must decide.
- Answer in the language of the issue.
- End your final message with exactly these two blocks:
<summary>${summary}</summary>
<status>approve | changes | blocked</status>`
}

export function buildPrompt(input: {
  project: any
  issue: any
  agent: any
  team: any[]
  workdir: Workdir
  kind: RunKind
  /** True when this agent got a stuck issue to decide in the owner's place. */
  decides?: boolean
}) {
  const { project, issue, agent, team, workdir, kind } = input
  const skills = skillsOf(agent)
  const comments = latestComments(issue.id)
  const others = team
    .filter((member) => member.id !== agent.id && member.enabled)
    .map((member) => `- ${member.name}${member.role ? ` (${member.role})` : ''}`)
  const maker = team.find((member) => member.id === issue.maker_id)

  const sections = [
    `You are "${agent.name}"${agent.role ? `, ${agent.role},` : ''} working autonomously in the project "${project.name}".`,
    project.description && `Project context: ${project.description}`,
    agent.instructions && `## Your instructions\n${agent.instructions}`,
    skills.length &&
      `## Skills\n${skills.map((skill) => `### ${skill.name}\n${skill.content}`).join('\n\n')}`,
    `## Issue ${project.key}-${issue.number}: ${issue.title}\n${issue.description || '(no description)'}`,
    lessonsForPrompt(project.id),
    issue.handoff && `## Handoff note from the previous worker\n${issue.handoff}`,
    comments.length &&
      `## Latest comments\n${comments.map((comment) => `**${comment.author}:** ${comment.body}`).join('\n\n')}`,
    others.length && `## Team\n${others.join('\n')}`,
    AGENT_CLI,
    input.decides && DECIDE_ALONE,
    kind === 'review' && screenshots(issue.id),
    kind === 'review'
      ? reviewRules(project, maker?.name ?? 'A teammate', workdir.branch)
      : workRules(project, workdir.branch),
  ]
  return sections.filter(Boolean).join('\n\n')
}

/** The newest preview screenshots, so a reviewer sees the app without starting it. */
function screenshots(issueId: number) {
  const latest = listShots(issueId).slice(0, 2)
  if (!latest.length) return ''
  const paths = latest.map((file) => `- ${join(shotsDir(issueId), file)}`).join('\n')
  return `## Screenshots of this branch\nThe server started the app of this branch and captured it. Open the images and judge the visible result too:\n${paths}`
}

export const tag = (text: string, name: string) =>
  text.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'i'))?.[1].trim()
