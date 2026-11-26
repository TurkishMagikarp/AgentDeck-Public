// Builds what an agent is told for one run. The next agent gets the handoff note and the
// latest comments, not the whole history: that is what keeps handovers cheap.
import { join } from 'node:path'
import { checklistSection, MAKER_RULES, reviewSection } from './checklist.ts'
import { all } from './db.ts'
import { lessonsForPrompt } from './lessons.ts'
import { ownerNote } from './ownerNote.ts'
import { CONNECTIONS } from './mcp.ts'
import { listShots, shotsDir } from './preview.ts'
import type { FileChange } from './diff.ts'
import type { Workdir } from './workspace.ts'
import { TICKET_FORMAT } from './ticket.ts'
import { SANDBOX } from './sandbox.ts'
import { forProject } from './i18n.ts'
import { prompts } from './prompts/index.ts'

export type RunKind = 'work' | 'review'

// The texts live in server/prompts, once per language, and are picked when a prompt is built.
// Caveman is the same idea as the Caveman skill (github.com/JuliusBrussee/caveman): fewer output
// tokens, same technical content. Only prose shrinks, everything an agent or tool parses stays exact.
export const ADHD_SUMMARY = () => prompts().adhdSummary
export const CAVEMAN = () => prompts().caveman
export const AGENT_CLI = (issueTokens?: number) =>
  prompts().agentCli(SANDBOX ? prompts().install : '', TICKET_FORMAT(issueTokens))
export const DECIDE_ALONE = () => prompts().decideAlone

/** Connections this run does not carry (mcp.ts, connectionsFor) and how the agent gets them. */
function heldBackSection(ids: string[], agentName: string) {
  if (!ids.length) return ''
  const names = ids.map((id) => `${CONNECTIONS[id]?.label ?? id} (\`${id}\`)`).join(', ')
  return prompts().heldBack(names, agentName)
}

/** The diff a reviewer gets in its prompt. Larger changes are cut; the file list stays complete. */
const MAX_REVIEW_DIFF_CHARS = 40_000
const MAX_LISTED_FILES = 150

export type ReviewChanges = {
  base: string
  commits: { hash: string; subject: string }[]
  files: FileChange[]
}

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
  return kind === 'work' ? prompts().testRuleWork(check.command) : prompts().testRuleReview(check.command)
}

function workRules(project: any, branch?: string, checklist = false) {
  const text = prompts()
  return text.workRules({
    where: branch ? text.onBranch(branch) : '',
    testRule: testRule(project, 'work'),
    makerRules: checklist ? `${MAKER_RULES()}\n` : '',
    summary: project.settings.adhd ? `${text.adhdSummary} ${text.adhdWorkStart}` : text.workSummary,
  })
}

function reviewRules(project: any, makerName: string, branch?: string) {
  const text = prompts()
  return text.reviewRules({
    maker: makerName,
    where: branch ? text.holdsBranch(branch) : '',
    testRule: testRule(project, 'review'),
    summary: project.settings.adhd ? `${text.adhdSummary} ${text.adhdReviewStart}` : text.reviewSummary,
  })
}

type PromptInput = {
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
  /** Connections of the agent that this run does not load. */
  heldBack?: string[]
}

/** The prompt comes in the project's language, whatever language the caller runs in. */
export const buildPrompt = (input: PromptInput) => forProject(input.project, () => promptFor(input))

function promptFor(input: PromptInput) {
  const { project, issue, agent, team, workdir, kind } = input
  const text = prompts()
  const skills = skillsOf(agent)
  const comments = latestComments(issue.id)
  const others = team
    .filter((member) => member.id !== agent.id && member.enabled)
    .map((member) => `- ${member.name}${member.role ? ` (${member.role})` : ''}`)
  const maker = team.find((member) => member.id === issue.maker_id)
  const checklist: string[] = project.settings.checklists.enabled ? (issue.checklist ?? []) : []

  const sections = [
    text.intro(agent.name, agent.role, project.name),
    project.description && text.projectContext(project.description),
    ownerNote() && `${text.ownerNote}\n${ownerNote()}`,
    agent.instructions && `${text.yourInstructions}\n${agent.instructions}`,
    skills.length &&
      `${text.skills}\n${skills.map((skill) => `### ${skill.name}\n${skill.content}`).join('\n\n')}`,
    // "## Issue KEY-1: title" is the same in every language: the run's title is read from it.
    `## Issue ${project.key}-${issue.number}: ${issue.title}\n${issue.description || text.noDescription}`,
    kind === 'work' && checklistSection(checklist),
    lessonsForPrompt(project.id),
    issue.handoff && `${text.handoffNote}\n${issue.handoff}`,
    comments.length &&
      `${text.latestComments}\n${comments.map((comment) => `**${comment.author}:** ${comment.body}`).join('\n\n')}`,
    others.length && `${text.team}\n${others.join('\n')}`,
    AGENT_CLI(project.settings?.issueCap?.tokens || undefined),
    kind === 'work' && heldBackSection(input.heldBack ?? [], agent.name),
    input.decides && DECIDE_ALONE(),
    kind === 'review' && input.changes && changesSection(input.changes),
    kind === 'review' && screenshots(issue.id),
    kind === 'review' &&
      checklist.length &&
      reviewSection(checklist, issue.checklist_report ?? '', !!issue.review_interim),
    project.settings.caveman && CAVEMAN(),
    kind === 'review'
      ? reviewRules(project, maker?.name ?? text.teammate, workdir.branch)
      : workRules(project, workdir.branch, checklist.length > 0),
  ]
  return sections.filter(Boolean).join('\n\n')
}

function changesSection({ base, commits, files }: ReviewChanges) {
  if (!files.length) return ''
  const text = prompts()
  const list = files
    .slice(0, MAX_LISTED_FILES)
    .map((file) =>
      file.binary ? `- ${file.path} (${text.binary})` : `- ${file.path} (+${file.added} −${file.removed})`,
    )
  if (files.length > MAX_LISTED_FILES) list.push(text.moreFiles(files.length - MAX_LISTED_FILES))
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
    text.changesHeading(base),
    text.changesIntro,
    commits.length &&
      `${text.commits}\n${commits.map((commit) => `- ${commit.hash} ${commit.subject}`).join('\n')}`,
    `${text.files}\n${list.join('\n')}`,
    tooBig.length && text.notShown(tooBig.join(', ')),
    patches.length && '```diff\n' + patches.join('\n') + '\n```',
  ]
  return parts.filter(Boolean).join('\n')
}

/** The newest preview screenshots, so a reviewer sees the app without starting it. */
function screenshots(issueId: number) {
  const latest = listShots(issueId).slice(0, 2)
  if (!latest.length) return ''
  const paths = latest.map((file) => `- ${join(shotsDir(issueId), file)}`).join('\n')
  return prompts().screenshots(paths)
}

export const tag = (text: string, name: string) =>
  text.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'i'))?.[1].trim()
