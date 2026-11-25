// Builds what an agent is told for one run. The next agent gets the handoff note and the
// latest comments, not the whole history: that is what keeps handovers cheap.
import { join } from 'node:path'
import { checklistSection, MAKER_RULES, reviewSection } from './checklist.ts'
import { all } from './db.ts'
import { lessonsForPrompt } from './lessons.ts'
import { listShots, shotsDir } from './preview.ts'
import type { FileChange } from './diff.ts'
import type { Workdir } from './workspace.ts'
import { TICKET_FORMAT } from './ticket.ts'
import { SANDBOX } from './sandbox.ts'

export type RunKind = 'work' | 'review'

const ADHD_SUMMARY =
  'STRICT FORMAT, max 45 words total: line 1 = the outcome in one plain sentence. ' +
  'Then at most 3 bullets of max 8 words each. No intro, no explanations, no code.'

// Same idea as the Caveman skill (github.com/JuliusBrussee/caveman): fewer output tokens,
// same technical content. Only prose shrinks, everything an agent or tool parses stays exact.
const CAVEMAN = `## Writing style: caveman
Write all prose terse, like a caveman: drop articles, filler, pleasantries, hedging and restating. Fragments are fine, short words over long ones.
Keep exact and unchanged: code, commands, paths, identifiers, error messages, numbers, and the required blocks and status values.
Use full sentences only for security warnings and irreversible actions.`

const INSTALL = `- \`node "$AGENTDECK_CLI" install <package> [...]\` installs Debian packages (apt names, e.g. \`ffmpeg libsdl2-dev\`). You have no sudo; this is how system packages get in. Python and Node packages need no root: use uv, venv or npm.
`

const AGENT_CLI = `## Board commands
You can read and write the shared board from the shell:
- \`node "$AGENTDECK_CLI" list [--status todo]\` lists issues.
- \`node "$AGENTDECK_CLI" show <number>\` prints an issue with its comments.
- \`node "$AGENTDECK_CLI" comment <number> "text"\` comments on an issue.
- \`node "$AGENTDECK_CLI" unblock <number> <blocker>\` removes a dependency: issue <number> no longer waits for <blocker>.
- \`node "$AGENTDECK_CLI" learn "text"\` records a lesson for every later run of this project: a build or test command, a pitfall, a tool you had to install. One sentence, only what is not obvious from the repo.
- \`node "$AGENTDECK_CLI" create --title "..." --description "..." [--assignee "Agent name"] [--status backlog|todo] [--blocked-by 12,13] [--reviewers "Name, Name"] [--group "..."] [--checklist "item | item"]\` files a new issue. \`--checklist\` lists what "done" means, each item checkable with a file or a command result. Give the issues it waits for with \`--blocked-by\`. If a similar open issue exists, the command names it and refuses; add \`--force yes\` only when yours is really different.
${SANDBOX ? INSTALL : ''}A bug or doubt outside your issue becomes a new issue, it is not fixed on the side.
If your issue cannot go on until another issue is done, name that issue as KEY-number in your summary and end with status "blocked": your issue then waits for it and goes on by itself.

${TICKET_FORMAT}`

/** The diff a reviewer gets in its prompt. Larger changes are cut; the file list stays complete. */
const MAX_REVIEW_DIFF_CHARS = 40_000
const MAX_LISTED_FILES = 150

export type ReviewChanges = {
  base: string
  commits: { hash: string; subject: string }[]
  files: FileChange[]
}

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

/**
 * When the server tests at landing, nobody else has to run the full suite: the maker only checks
 * what it changed, the reviewer judges the result. This line wins over role files that say otherwise.
 */
function testRule(project: any, kind: RunKind) {
  const check = project.settings.precheck
  if (!check?.enabled || !check.command || check.commandAt !== 'landing') return ''
  return kind === 'work'
    ? `\n- Do not run \`${check.command}\` or other full test suites: the server runs it on the merged state after the review and sends the issue back if it fails. Run only quick checks of what you changed. This overrides any instruction to run the full tests yourself.`
    : `\n- Do not run \`${check.command}\` or other full test suites: the server runs it after your approval and before landing. Judge the result against the issue. This overrides any instruction to run the tests yourself.`
}

function workRules(project: any, branch?: string, checklist = false) {
  const summary = project.settings.adhd
    ? `${ADHD_SUMMARY} Start line 1 with "Done:", "Partial:" or "Blocked:".`
    : 'What you did and the result, concise.'
  const where = branch ? ` (branch ${branch}); commit your changes on this branch, do not push` : ''

  return `## Rules
- Work only inside the current directory${where}.
- Stay within the scope of this issue. If something essential is unclear or needs a human decision, stop and use status "blocked".${testRule(project, 'work')}
- Answer in the language of the issue.
${checklist ? `${MAKER_RULES}\n` : ''}- End your final message with exactly these three blocks:
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
- Review only. Do not change or commit anything.${testRule(project, 'review')}
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
  /** For a review: what the branch changed, so the reviewer does not have to search for it. */
  changes?: ReviewChanges
}) {
  const { project, issue, agent, team, workdir, kind } = input
  const skills = skillsOf(agent)
  const comments = latestComments(issue.id)
  const others = team
    .filter((member) => member.id !== agent.id && member.enabled)
    .map((member) => `- ${member.name}${member.role ? ` (${member.role})` : ''}`)
  const maker = team.find((member) => member.id === issue.maker_id)
  const checklist: string[] = project.settings.checklists.enabled ? (issue.checklist ?? []) : []

  const sections = [
    `You are "${agent.name}"${agent.role ? `, ${agent.role},` : ''} working autonomously in the project "${project.name}".`,
    project.description && `Project context: ${project.description}`,
    agent.instructions && `## Your instructions\n${agent.instructions}`,
    skills.length &&
      `## Skills\n${skills.map((skill) => `### ${skill.name}\n${skill.content}`).join('\n\n')}`,
    `## Issue ${project.key}-${issue.number}: ${issue.title}\n${issue.description || '(no description)'}`,
    kind === 'work' && checklistSection(checklist),
    lessonsForPrompt(project.id),
    issue.handoff && `## Handoff note from the previous worker\n${issue.handoff}`,
    comments.length &&
      `## Latest comments\n${comments.map((comment) => `**${comment.author}:** ${comment.body}`).join('\n\n')}`,
    others.length && `## Team\n${others.join('\n')}`,
    AGENT_CLI,
    input.decides && DECIDE_ALONE,
    kind === 'review' && input.changes && changesSection(input.changes),
    kind === 'review' && screenshots(issue.id),
    kind === 'review' &&
      checklist.length &&
      reviewSection(checklist, issue.checklist_report ?? '', !!issue.review_interim),
    project.settings.caveman && CAVEMAN,
    kind === 'review'
      ? reviewRules(project, maker?.name ?? 'A teammate', workdir.branch)
      : workRules(project, workdir.branch, checklist.length > 0),
  ]
  return sections.filter(Boolean).join('\n\n')
}

function changesSection({ base, commits, files }: ReviewChanges) {
  if (!files.length) return ''
  const list = files
    .slice(0, MAX_LISTED_FILES)
    .map((file) =>
      file.binary ? `- ${file.path} (binary)` : `- ${file.path} (+${file.added} −${file.removed})`,
    )
  if (files.length > MAX_LISTED_FILES) list.push(`- and ${files.length - MAX_LISTED_FILES} more files`)
  let budget = MAX_REVIEW_DIFF_CHARS
  const patches: string[] = []
  const tooBig: string[] = []
  for (const file of files.filter((file) => !file.binary && file.patch)) {
    if (file.cut || file.patch.length > budget) {
      tooBig.push(file.path)
      continue
    }
    patches.push(`--- ${file.path}\n${file.patch.trimEnd()}`)
    budget -= file.patch.length
  }

  const parts = [
    `## What the branch changed against ${base}`,
    'This is the complete change. Review it here; open other files only where the diff is not enough.',
    commits.length && `Commits:\n${commits.map((commit) => `- ${commit.hash} ${commit.subject}`).join('\n')}`,
    `Files:\n${list.join('\n')}`,
    tooBig.length && `Not shown because of size, read them yourself if needed: ${tooBig.join(', ')}`,
    patches.length && '```diff\n' + patches.join('\n') + '\n```',
  ]
  return parts.filter(Boolean).join('\n')
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
