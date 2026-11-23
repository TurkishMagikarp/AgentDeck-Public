// The scheduler: decides which agent starts on which issue, follows the run and moves the issue
// on when it ends (done, to the next reviewer, back to the maker, or to a human).
import { join } from 'node:path'
import { oneShot, startRun, type RunHandle, type RunResult } from './adapters.ts'
import {
  activity,
  addComment,
  createIssue,
  emit,
  getAgent,
  getIssue,
  getProject,
  invalidate,
  mapAgent,
  mapIssue,
  patchIssue,
  pickProvider,
  providerLeft,
  PROVIDERS,
} from './core.ts'
import { checklistFor, parseReport } from './checklist.ts'
import { issueChanges } from './diff.ts'
import { all, get, run, tx } from './db.ts'
import { baseBranchOf, githubTokenOf, landIssue, watchPullRequests, type Outcome } from './landing.ts'
import { addLesson } from './lessons.ts'
import { notifyOwner } from './notify.ts'
import { blockerWeights, byBlockerWeight, cycles, type Weight } from './blockers.ts'
import { overCap } from './issueCap.ts'
import { capturePreview } from './preview.ts'
import { precheck } from './precheck.ts'
import { bigIssues, paceOf, type Pace } from './pacing.ts'
import { buildPrompt, tag, type RunKind } from './prompt.ts'
import { rtkEnv } from './rtk.ts'
import { createRunToken, revokeRunToken } from './runTokens.ts'
import { prepareWorkdir, releaseWorkdir, type Workdir } from './workspace.ts'
import {
  classifyFailure,
  clock,
  hintFor,
  when,
  PROVIDER_FAILURES,
  restOf,
  restProvider,
  retryDelay,
  type Failure,
} from './recovery.ts'

type Live = {
  runId: number
  issueId: number
  projectId: number
  agentId: number
  provider: string
  /** Which parallel copy of the agent this is. Decides the checkout in the agent layout. */
  slot: number
  kind: RunKind
  handle: RunHandle
  workdir?: Workdir
  startedAt: number
  lastActivity: number
  warned: Set<string>
  stop?: { to: string }
  /** The agent has ended and the server checks its work (precheck.ts); the watchdog leaves it alone. */
  checking?: boolean
}

type Pick = { provider: string; model: string; fallback: boolean }

/**
 * What the server found when a maker handed in: a partial delivery (checklist items open), a
 * failed server check, or a pass. `report` is the maker's checklist block for the reviewers.
 */
type Gate = { result: 'partial' | 'failed' | 'passed'; note: string; report: string }

const live = new Map<number, Live>()
const retryAfter = new Map<number, number>()
/** Issues whose next run should try another provider, because this one failed the same way twice. */
const avoidProvider = new Map<number, string>()
export const notices = new Map<number, string>()

const AGENT_CLI = join(import.meta.dirname, 'agent-cli.mjs')
const OWN_URL = `http://127.0.0.1:${process.env.PORT ?? 8790}`

const liveFor = (issueId: number) => [...live.values()].find((l) => l.issueId === issueId)

const failed = (message: string): RunResult => ({
  ok: false,
  text: '',
  usage: { input: 0, output: 0, cost: 0 },
  error: message,
})

function setNotice(pid: number, text: string) {
  if ((notices.get(pid) ?? '') === text) return
  if (text) notices.set(pid, text)
  else notices.delete(pid)
  emit(pid, { t: 'notice', text })
}

function freeSlot(agentId: number) {
  const taken = new Set([...live.values()].filter((l) => l.agentId === agentId).map((l) => l.slot))
  let slot = 0
  while (taken.has(slot)) slot++
  return slot
}

/**
 * Where the server lands the work, an agent must not be able to push on its own: a push would
 * bypass review and the protected paths. Git takes this override from the environment, so it
 * holds for every git call of the run and leaves the repository's own config alone.
 */
function noPush(p: any): Record<string, string> {
  if (p.settings.landing.mode === 'off') return {}
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'remote.origin.pushurl',
    GIT_CONFIG_VALUE_0: 'file:///agents-do-not-push--the-server-lands-approved-work',
  }
}

/** A project with its own GitHub token gives it to its agents, so gh never uses the wider login. */
function ownGithubToken(p: any): Record<string, string> {
  if (!p.settings.landing.githubTokenFile) return {}
  return { GH_TOKEN: githubTokenOf(p)! }
}

// ---------- starting a run ----------

function start(p: any, issue: any, agent: any, agents: any[], pick: Pick) {
  const kind: RunKind = issue.review_index >= 0 ? 'review' : 'work'
  // A model set on the issue wins, but only on the agent's own provider: on a fallback
  // provider that model name would mean nothing.
  const model = issue.model && !pick.fallback ? issue.model : pick.model
  const now = Date.now()

  const inserted = run(
    `INSERT INTO runs (project_id, issue_id, agent_id, agent_name, provider, model, kind, started_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    p.id,
    issue.id,
    agent.id,
    agent.name,
    pick.provider,
    model,
    kind,
    now,
  )
  const runId = Number(inserted.lastInsertRowid)

  const l: Live = {
    runId,
    issueId: issue.id,
    projectId: p.id,
    agentId: agent.id,
    provider: pick.provider,
    slot: freeSlot(agent.id),
    kind,
    startedAt: now,
    lastActivity: now,
    warned: new Set(),
    // Until the working directory is ready there is no process yet; the real handle replaces this.
    handle: { kill() {}, done: new Promise(() => {}) },
  }
  live.set(runId, l)

  const taken: Record<string, any> = { status: 'in_progress', assignee_id: agent.id }
  if (kind === 'work') taken.maker_id = agent.id
  if (kind === 'work' && p.settings.checklists.enabled && !issue.checklist?.length) {
    const { items, template } = checklistFor(issue, agent.name, p.settings.checklists.templates)
    if (items.length) {
      taken.checklist = items
      addComment(
        issue.id,
        'System',
        'system',
        `Acceptance checklist created (${items.length === 1 ? '1 item' : `${items.length} items`}${template ? `, template "${template}"` : ''}).`,
      )
    }
  }
  patchIssue(issue.id, taken)
  if (pick.fallback) {
    const preferred = PROVIDERS[agent.provider]?.label ?? agent.provider
    addComment(
      issue.id,
      'System',
      'system',
      `Routing: ${preferred} is below its threshold, this run uses ${PROVIDERS[pick.provider].label}.`,
    )
  }

  invalidate(p.id)
  emit(p.id, {
    t: 'run.start',
    run: {
      id: runId,
      issue_id: issue.id,
      agent_id: agent.id,
      agent_name: agent.name,
      provider: pick.provider,
      model,
      started_at: now,
    },
  })

  const token = createRunToken({
    runId,
    projectId: p.id,
    issueId: issue.id,
    agentId: agent.id,
    agentName: agent.name,
  })

  // Preparing the checkout runs in the background so one slow git call cannot hold up the scheduler.
  prepareWorkdir({
    project: p,
    issueNumber: issue.number,
    agentId: agent.id,
    slot: l.slot,
    readOnly: kind === 'review',
  })
    .then(async (workdir) => {
      l.workdir = workdir
      if (l.stop) return finish(l, agent, failed('stopped'))
      // A reviewer that gets the diff does not spend its context searching for the change.
      const changes =
        kind === 'review' ? await issueChanges(p, issue.number).catch(() => undefined) : undefined
      try {
        l.handle = startRun({
          provider: pick.provider,
          model,
          effort: agent.effort,
          cwd: workdir.cwd,
          prompt: buildPrompt({
            project: p,
            issue: getIssue(issue.id),
            agent,
            team: agents,
            workdir,
            kind,
            decides: kind === 'work' && issue.escalated > 0 && deputyOf(p)?.id === agent.id,
            changes,
          }),
          autonomous: true,
          mcp: agent.mcp_ids,
          env: {
            AGENTDECK_URL: OWN_URL,
            AGENTDECK_RUN_TOKEN: token,
            AGENTDECK_CLI: AGENT_CLI,
            ...noPush(p),
            ...ownGithubToken(p),
            ...rtkEnv(p.key, agent.id),
          },
          onActivity: (output) => {
            const text = output.slice(0, 1200)
            l.lastActivity = Date.now()
            activity.set(runId, { issueId: issue.id, text, at: l.lastActivity })
            run('INSERT INTO run_log (run_id, at, text) VALUES (?,?,?)', runId, l.lastActivity, text)
            emit(p.id, { t: 'activity', runId, issueId: issue.id, text, at: l.lastActivity })
          },
        })
      } catch (e: any) {
        return finish(l, agent, failed(e.message))
      }
      return finish(l, agent, await l.handle.done)
    })
    .catch((e) => {
      // Without a working directory a retry would fail the same way, so a human has to look.
      l.stop = { to: 'blocked' }
      addComment(issue.id, 'System', 'system', `Could not prepare the working directory: ${e.message}`)
      return finish(l, agent, failed(e.message))
    })
    .catch((e) => console.error('run', e))
}

// ---------- ending a run ----------

function endRun(l: Live, status: string, res: RunResult, note = '', failure = '', verdict = '') {
  live.delete(l.runId)
  activity.delete(l.runId)
  revokeRunToken(l.runId)
  run(
    `UPDATE runs SET status=?, ended_at=?, input_tokens=?, output_tokens=?, cached_tokens=?, cost_usd=?, note=?,
       failure=?, verdict=?
     WHERE id=?`,
    status,
    Date.now(),
    res.usage.input,
    res.usage.output,
    res.usage.cached ?? 0,
    res.usage.cost,
    note,
    failure,
    verdict,
    l.runId,
  )
  invalidate(l.projectId)
  emit(l.projectId, { t: 'run.end', id: l.runId, issueId: l.issueId })
}

/** Failed runs in a row on this issue. A limit or a broken login is the provider's fault and does not count. */
function failedStreak(issueId: number) {
  const providerFaults = PROVIDER_FAILURES.map(() => '?').join(',')
  const recent = all(
    `SELECT status FROM runs WHERE issue_id=? AND agent_name!='Watchdog' AND failure NOT IN (${providerFaults})
     ORDER BY id DESC LIMIT 20`,
    issueId,
    ...PROVIDER_FAILURES,
  )
  const firstGood = recent.findIndex((r) => r.status === 'done')
  return firstGood === -1 ? recent.length : firstGood
}

async function finish(l: Live, agent: any, res: RunResult) {
  const p = getProject(l.projectId)
  const issue = getIssue(l.issueId)
  // Checked in the maker's checkout before it is let go, while the branch is still checked out there.
  const gate = p && issue && l.kind === 'work' && !l.stop && res.ok ? await gateWork(l, p, issue, res) : null
  if (p && l.workdir) await releaseWorkdir(p, l.workdir)
  if (!p || !issue) return void endRun(l, 'failed', res, 'Issue deleted')

  if (l.stop || !res.ok) finishFailed(l, p, issue, agent, res)
  else if (l.kind === 'review') await finishReview(l, p, issue, agent, res)
  else await finishWork(l, p, issue, agent, res, gate)

  // Only an issue that waits for its next run is parked; landing and human decisions go on.
  const after = getIssue(issue.id)
  const waitsForRun = after?.status === 'todo' || (after?.status === 'review' && after.review_index >= 0)
  if (waitsForRun) parkIfOverCap(p, after)
  kick()
}

/** Parks an issue that used up its cost cap, see issueCap.ts. Returns true when it was parked. */
function parkIfOverCap(p: any, issue: any) {
  const reason = overCap(p.settings.issueCap, issue)
  if (!reason) return false
  const note = `Cost cap reached: ${reason}. The issue is parked. With "Allow another round", or by moving it back to To Do, it may use the same amount once more.`
  addComment(issue.id, 'Cost cap', 'watchdog', note)
  patchIssue(issue.id, {
    status: 'backlog',
    capped: 1,
    review_index: -1,
    assignee_id: issue.maker_id ?? issue.assignee_id,
  })
  notifyOwner(p, issue, note)
  return true
}

/** The issue changes only if nobody moved it by hand while the agent was running. */
function moveIssue(issueId: number, patch: Record<string, any>) {
  if (getIssue(issueId)?.status === 'in_progress') patchIssue(issueId, patch)
}

/**
 * How often the deputy may take the same issue before it is parked. A maker that blocks again
 * right after a decision mostly blocks for the same reason, and every round costs two runs.
 */
const MAX_DEPUTY_DECISIONS = 2

/** The agent that decides in the owner's place. An autonomous project always has one. */
function deputyOf(p: any) {
  const named = getAgent(p.settings.escalationAgentId)
  if (named?.enabled && named.project_id === p.id) return named
  if (!p.settings.autonomous) return undefined
  return mapAgent(get('SELECT * FROM agents WHERE project_id=? AND enabled=1 ORDER BY id LIMIT 1', p.id))
}

function handToDeputy(issue: any, deputy: any, reason: string) {
  addComment(
    issue.id,
    'System',
    'system',
    `Handed to ${deputy.name} to decide: ${reason}\n\nRead why it is stuck and decide how it goes on.`,
  )
  patchIssue(issue.id, {
    status: 'todo',
    assignee_id: deputy.id,
    review_index: -1,
    review_interim: 0,
    escalated: issue.escalated + 1,
  })
}

/**
 * An issue is stuck. If the project names an agent for that (usually the lead), it gets the
 * issue once to decide how it goes on. Only what that agent cannot settle reaches a human.
 * An autonomous project never asks a human, see settleWithoutHuman.
 */
function needsHuman(p: any, issueId: number, reason: string) {
  const issue = getIssue(issueId)
  if (!issue) return
  if (p.settings.autonomous) return settleWithoutHuman(p, issue, reason)

  const deputy = deputyOf(p)
  const canEscalate = deputy && !issue.escalated && issue.assignee_id !== deputy.id
  if (!canEscalate || issue.status !== 'blocked') return notifyOwner(p, issue, reason)
  handToDeputy(issue, deputy, reason)
}

/**
 * Autonomous projects: nothing waits for a person.
 *  - Work that asks for a human review is reviewed by the deputy, or accepted if the deputy made it.
 *  - A blocked issue goes to the deputy, who decides in the owner's place.
 *  - What the deputy cannot settle either is parked in the backlog. It blocks nobody there and
 *    comes up again when the open work is done.
 */
function settleWithoutHuman(p: any, issue: any, reason: string) {
  const deputy = deputyOf(p)

  if (issue.status === 'review') {
    if (deputy && deputy.id !== issue.maker_id) {
      addComment(issue.id, 'System', 'system', `Sent to ${deputy.name} for review.`)
      return patchIssue(issue.id, { reviewers: [deputy.id], review_index: 0, assignee_id: deputy.id })
    }
    addComment(issue.id, 'System', 'system', 'No other reviewer available, the work counts as approved.')
    patchIssue(issue.id, { status: 'done' })
    return landByHand(issue.id)
  }

  const deputyGaveUp = !deputy || issue.assignee_id === deputy.id || issue.escalated >= MAX_DEPUTY_DECISIONS
  if (!deputyGaveUp) return handToDeputy(issue, deputy, reason)

  const note = `Parked: ${reason}\n\nThe issue waits in the backlog and holds nothing up. It comes up again once the open work is done.`
  addComment(issue.id, 'Watchdog', 'watchdog', note)
  patchIssue(issue.id, {
    status: 'backlog',
    review_index: -1,
    assignee_id: issue.maker_id ?? issue.assignee_id,
  })
  notifyOwner(p, issue, note)
}

/**
 * The safety net of an autonomous project: whatever still sits in a state that waits for a
 * person (moved there by hand, imported that way, or left by an older version) is settled.
 */
function sweepWaitingIssues() {
  for (const row of all('SELECT id FROM projects WHERE paused=0')) {
    const p = getProject(row.id)
    if (!p.settings.autonomous) continue
    const waiting = all(
      `SELECT id FROM issues WHERE project_id=?
       AND (status='blocked' OR (status='review' AND review_index<0 AND landing=''))`,
      p.id,
    )
    for (const { id } of waiting) {
      const issue = getIssue(id)
      const reason =
        issue.status === 'review' ? 'Was waiting for a review by a human.' : 'Was set to "Waits for a human".'
      settleWithoutHuman(p, issue, reason)
    }
    if (waiting.length + pullBlockersFromBacklog(p) + resolveRings(p)) kick()
  }
}

/**
 * Issues that wait on each other in a ring never start. First the deputy gets a small issue of its
 * own to decide which dependency goes (the issues in the ring cannot start, so it is not one of
 * them). If the ring is still there when that issue is settled, or there is no deputy, the
 * dependency on the newest issue in the ring is removed. Both sides get a comment.
 */
function resolveRings(p: any) {
  const open = all(
    "SELECT number, priority, status, blocked_by FROM issues WHERE project_id=? AND status!='done'",
    p.id,
  ).map(mapIssue)
  const rings = cycles(open)
  if (!rings.length) return 0

  const deputy = deputyOf(p)
  let changed = 0
  for (const ring of rings) {
    const marker = `[ring:${[...ring].sort((a, b) => a - b).join(',')}]`
    const decision = get(
      'SELECT id, status FROM issues WHERE project_id=? AND instr(description, ?) > 0 ORDER BY id DESC LIMIT 1',
      p.id,
      marker,
    )
    if (!decision && deputy) {
      handRingToDeputy(p, ring, deputy, marker)
      changed++
      continue
    }
    // Still being decided: wait for it.
    if (decision && !['done', 'backlog'].includes(decision.status)) continue
    breakRing(p, ring)
    changed++
  }
  return changed
}

function ringText(key: string, ring: number[]) {
  return [...ring, ring[0]].map((number) => `${key}-${number}`).join(' → ')
}

function handRingToDeputy(p: any, ring: number[], deputy: any, marker: string) {
  const created = tx(() =>
    createIssue(p.id, {
      title: `Resolve ring dependency: ${ringText(p.key, ring)}`,
      description:
        `These issues wait on each other in a circle and so never start (A → B means: A waits for B):\n` +
        `${ringText(p.key, ring)}\n\n` +
        'Read the issues and remove the dependency that makes the least sense with ' +
        '`node "$AGENTDECK_CLI" unblock <number> <blocker>`. Then close this issue with `done`. ' +
        'If the circle remains, AgentDeck resolves it on its own afterwards.\n\n' +
        marker,
      status: 'todo',
      priority: 3,
      assignee_id: deputy.id,
      created_by: 'Watchdog',
    }),
  )
  for (const number of ring) {
    const issue = get('SELECT id FROM issues WHERE project_id=? AND number=?', p.id, number)
    if (issue) {
      addComment(
        issue.id,
        'Watchdog',
        'watchdog',
        `Stuck in a ring dependency (${ringText(p.key, ring)}). ${deputy.name} decides in ${p.key}-${created.number}.`,
      )
    }
  }
}

/** Removes the dependency on the newest issue of the ring: usually the one added last. */
function breakRing(p: any, ring: number[]) {
  // In the ring each issue waits on the next one, the last one on the first.
  const edges = ring.map((number, index) => ({ waiter: number, blocker: ring[(index + 1) % ring.length] }))
  const edge = edges.reduce((newest, candidate) => (candidate.blocker > newest.blocker ? candidate : newest))
  const waiter = mapIssue(get('SELECT * FROM issues WHERE project_id=? AND number=?', p.id, edge.waiter))
  const blocker = get('SELECT id FROM issues WHERE project_id=? AND number=?', p.id, edge.blocker)
  if (!waiter) return
  patchIssue(waiter.id, { blocked_by: waiter.blocked_by.filter((number: number) => number !== edge.blocker) })
  const note = `Ring dependency resolved (${ringText(p.key, ring)}): ${p.key}-${edge.waiter} no longer waits for ${p.key}-${edge.blocker}.`
  addComment(
    waiter.id,
    'Watchdog',
    'watchdog',
    `${note} Check whether something is missing now, and create a new issue for it if needed.`,
  )
  if (blocker) addComment(blocker.id, 'Watchdog', 'watchdog', note)
}

/** How often a blocker is taken out of the backlog again before the issues behind it go on without it. */
const MAX_BLOCKER_RETURNS = 2

/**
 * A backlog issue that blocks open work would wait forever: parked issues come back only when
 * nothing else is open, and the open work waits for them. So in an autonomous project such a
 * blocker goes back into the queue (a parked one to the deputy, who decides). If it lands in the
 * backlog again too often, the issues behind it are released from it and go on without it.
 * An issue over its cost cap stays where it is; that waits for the owner on purpose.
 */
function pullBlockersFromBacklog(p: any) {
  const open = all(
    `SELECT id, number, blocked_by FROM issues WHERE project_id=?
     AND status IN ('todo','in_progress','review','blocked')`,
    p.id,
  ).map(mapIssue)
  const waitingOn = new Map<number, any[]>()
  for (const issue of open) {
    for (const number of issue.blocked_by) waitingOn.set(number, [...(waitingOn.get(number) ?? []), issue])
  }
  if (!waitingOn.size) return 0

  const stuck = all(
    `SELECT id FROM issues WHERE project_id=? AND status='backlog' AND capped=0
     AND number IN (${[...waitingOn.keys()].map(() => '?').join(',')})`,
    p.id,
    ...waitingOn.keys(),
  )
  const deputy = deputyOf(p)
  for (const { id } of stuck) {
    const blocker = getIssue(id)
    const dependents = waitingOn.get(blocker.number)!
    const keys = dependents.map((issue) => `${p.key}-${issue.number}`).join(', ')

    if (blocker.blocker_returns >= MAX_BLOCKER_RETURNS) {
      for (const issue of dependents) {
        patchIssue(issue.id, {
          blocked_by: issue.blocked_by.filter((number: number) => number !== blocker.number),
        })
        addComment(
          issue.id,
          'Watchdog',
          'watchdog',
          `${p.key}-${blocker.number} could not be finished and no longer holds up this issue. Check whether something is missing without it, and create a new issue for it if needed.`,
        )
      }
      addComment(
        blocker.id,
        'Watchdog',
        'watchdog',
        `No longer holds up: ${keys}. They no longer wait for this issue.`,
      )
      continue
    }

    const parked = !!get(
      "SELECT 1 FROM comments WHERE issue_id=? AND kind='watchdog' AND body LIKE 'Parked:%' LIMIT 1",
      blocker.id,
    )
    const decider = parked && deputy ? deputy : null
    addComment(
      blocker.id,
      'Watchdog',
      'watchdog',
      `Was in the backlog, but ${dependents.length} issues wait for it (${keys}). Back into the queue` +
        (decider ? `, ${decider.name} decides.` : '.') +
        ` Attempt ${blocker.blocker_returns + 1} of ${MAX_BLOCKER_RETURNS}.`,
    )
    patchIssue(blocker.id, {
      status: 'todo',
      review_index: -1,
      blocker_returns: blocker.blocker_returns + 1,
      // The deputy decides once more. If the maker blocks again after that, the issue is parked
      // at once instead of starting a new round of decisions.
      ...(decider ? { assignee_id: decider.id, escalated: MAX_DEPUTY_DECISIONS } : {}),
    })
  }
  return stuck.length
}

// ---------- landing ----------

/** Writes the result of a landing attempt onto the issue. */
function applyLanding(p: any, issueId: number, outcome: Outcome) {
  const issue = getIssue(issueId)
  if (!issue) return
  if (outcome.note) addComment(issueId, 'System', 'system', outcome.note)

  const patch: Record<string, any> = {
    status: outcome.status,
    review_index: -1,
    review_rounds: 0,
    review_from: 0,
    review_interim: 0,
    assignee_id: issue.maker_id ?? issue.assignee_id,
  }
  let needsOwner = !!outcome.needsOwner

  // Sent back to the maker (merge conflict, failed checks): that counts as a round, so an agent
  // that cannot fix it does not try forever.
  if (outcome.status === 'todo') {
    patch.review_rounds = issue.review_rounds + 1
    if (patch.review_rounds >= p.settings.maxReviewRounds) {
      patch.status = 'blocked'
      patch.review_rounds = 0
      needsOwner = true
      addComment(issueId, 'Watchdog', 'watchdog', 'Landing failed several times. Please decide how to go on.')
    }
  }

  // 'review' here means: a pull request is open and its checks decide. Everything else ends the wait.
  if (outcome.status !== 'review') patch.landing = ''
  patchIssue(issueId, patch)
  if (needsOwner) needsHuman(p, issueId, outcome.note)
}

/** The work is approved: bring it into the base branch, then close the issue. */
async function landAndClose(p: any, issue: any) {
  if (getIssue(issue.id)?.status !== 'in_progress') return
  applyLanding(p, issue.id, await landIssue(p, issue))
}

/** A human closed the issue on the board. Its branch is landed in the background. */
export function landByHand(issueId: number) {
  const issue = getIssue(issueId)
  const p = issue && getProject(issue.project_id)
  if (!p || p.settings.landing.mode === 'off') return
  landIssue(p, issue)
    .then((outcome) => {
      if (outcome.status !== 'done' || outcome.note) applyLanding(p, issueId, outcome)
      kick()
    })
    .catch((e) => console.error('landing', e))
}

/**
 * The way out for a failed run, by kind of failure. Returns the comment the next agent reads;
 * the provider and the retry timing are set here as well.
 */
function heal(l: Live, p: any, issue: any, failure: Failure) {
  const label = PROVIDERS[l.provider]?.label ?? l.provider

  if (PROVIDER_FAILURES.includes(failure.kind)) {
    const wasResting = !!restOf(l.provider)
    const until = restProvider(l.provider, failure)
    const hint = hintFor(failure, label, until)
    // A broken login does not fix itself. One mail per outage, not one per issue that ran into it.
    if (failure.kind === 'access' && !wasResting) notifyOwner(p, issue, hint)
    return hint
  }

  // The same unexplained failure twice in a row on one provider: the next run tries another one.
  if (failure.kind === 'unknown') {
    const lastTwo = all(
      "SELECT provider, note FROM runs WHERE issue_id=? AND status='failed' ORDER BY id DESC LIMIT 2",
      issue.id,
    )
    const sameTwice =
      lastTwo.length === 2 && lastTwo.every((r) => r.provider === l.provider && r.note === lastTwo[0].note)
    if (!sameTwice) return ''
    avoidProvider.set(issue.id, l.provider)
    return `The same error twice on ${label}. The next run takes another provider, if one is set up.`
  }

  if (failure.kind === 'toolchain') {
    addLesson(
      p.id,
      `\`${failure.missing}\` was not installed in a run. Check before use and install it if needed.`,
      'Self-healing',
    )
  }
  return hintFor(failure, label)
}

function finishFailed(l: Live, p: any, issue: any, agent: any, res: RunResult) {
  const failure = l.stop ? undefined : classifyFailure(l.runId, l.provider, res.error ?? '')
  endRun(l, l.stop ? 'stopped' : 'failed', res, res.error ?? '', failure?.kind ?? '')

  const hint = failure ? heal(l, p, issue, failure) : ''
  if (hint) {
    // Kind "watchdog", so the next agent finds it among the latest comments of its prompt.
    addComment(
      issue.id,
      'Self-healing',
      'watchdog',
      `Run of ${agent.name} failed: ${failure!.cause}\n\n${hint}`,
    )
  } else if (failure) {
    addComment(issue.id, 'System', 'system', `Run of ${agent.name} failed: ${res.error ?? 'unknown error'}`)
  }

  // Back into the queue it came from: a failed review stays a review.
  const queue = l.kind === 'review' ? 'review' : 'todo'
  let to = l.stop?.to === 'todo' ? queue : (l.stop?.to ?? queue)
  const providersFault = failure && PROVIDER_FAILURES.includes(failure.kind)
  if (to === queue && !providersFault) {
    const watchdog = p.settings.watchdog
    const streak = failedStreak(issue.id)
    const limit = (watchdog.enabled && watchdog.rules.find((r: any) => r.type === 'attempts')?.value) || 5
    if (streak >= limit) {
      to = 'blocked'
      addComment(
        issue.id,
        'Watchdog',
        'watchdog',
        `${streak} runs in a row without a result. Issue blocked, please take a look.`,
      )
    } else {
      const delay = (failure && retryDelay(failure)) ?? 15_000 * 2 ** streak
      retryAfter.set(issue.id, Date.now() + delay)
    }
  }
  moveIssue(issue.id, { status: to })
  if (to === 'blocked') needsHuman(p, issue.id, 'Several runs ended without a result.')
}

/** Position of the next reviewer who can actually review: enabled, and not the maker. */
function nextReviewer(issue: any, from: number, makerId: number, agents: any[]) {
  for (let index = from; index < issue.reviewers.length; index++) {
    const reviewer = agents.find((a) => a.id === issue.reviewers[index])
    if (reviewer?.enabled && reviewer.id !== makerId) return index
  }
  return -1
}

/** Failed server checks in a row before the deputy (or a human) is asked. */
const MAX_PRECHECK_FAILS = 3
/** Partial deliveries in a row before the deputy looks at why the issue does not get finished. */
const MAX_PARTIALS = 4

/**
 * Before a reviewer sees finished work: is the checklist complete, do the named proof files
 * exist, does the base branch merge in and does the project's check pass? See precheck.ts.
 * Null when there is nothing to check (blocked, handed over, or neither feature is on).
 */
async function gateWork(l: Live, p: any, issue: any, res: RunResult): Promise<Gate | null> {
  const answer = (tag(res.text, 'status') ?? 'review').toLowerCase()
  if (answer === 'blocked' || answer.startsWith('handoff:')) return null
  const items: string[] = p.settings.checklists.enabled ? (issue.checklist ?? []) : []
  if (!items.length && !p.settings.precheck.enabled) return null

  const block = tag(res.text, 'checklist')
  const report = items.length ? parseReport(block, items.length) : null
  if (items.length && !report) {
    return {
      result: 'failed',
      note: 'Your handoff has no <checklist> block. Report every item of the acceptance checklist as "ok" with proof or as "open", and hand in again.',
      report: '',
    }
  }
  if (report?.open.length) {
    return {
      result: 'partial',
      note: `Partial handoff, open: item ${report.open.join(', ')}.`,
      report: block ?? '',
    }
  }
  if (!p.settings.precheck.enabled || !l.workdir) return { result: 'passed', note: '', report: block ?? '' }

  l.checking = true
  const text = 'Precheck running: proof, merge, project check…'
  l.lastActivity = Date.now()
  emit(p.id, { t: 'activity', runId: l.runId, issueId: issue.id, text, at: l.lastActivity })
  const outcome = await precheck({
    cwd: l.workdir.cwd,
    branch: l.workdir.branch,
    base: await baseBranchOf(p),
    command: p.settings.precheck.commandAt === 'landing' ? '' : p.settings.precheck.command,
    timeoutMin: p.settings.precheck.timeoutMin,
    report,
  }).catch((error) => ({
    ok: true,
    note: `Precheck not possible, the reviewers see the work anyway: ${error.message}`,
  }))
  return { result: outcome.ok ? 'passed' : 'failed', note: outcome.note, report: block ?? '' }
}

/** Partial deliveries in a row on this issue. */
function partialStreak(issueId: number) {
  const recent = all(
    "SELECT verdict FROM runs WHERE issue_id=? AND kind='work' AND status='done' ORDER BY id DESC LIMIT 10",
    issueId,
  )
  const firstOther = recent.findIndex((r) => r.verdict !== 'partial')
  return firstOther === -1 ? recent.length : firstOther
}

/** Open issues of the project that a text names as KEY-n, other than this one and its dependents. */
function namedOpenIssues(p: any, issue: any, text: string) {
  const numbers = [...text.matchAll(new RegExp(`\\b${p.key}-(\\d+)\\b`, 'g'))]
    .map((match) => Number(match[1]))
    .filter((number) => number !== issue.number)
  if (!numbers.length) return []
  return all(
    `SELECT number, blocked_by FROM issues WHERE project_id=? AND status!='done'
     AND number IN (${numbers.map(() => '?').join(',')})`,
    p.id,
    ...numbers,
  )
    .map(mapIssue)
    .filter((other) => !other.blocked_by.includes(issue.number))
    .map((other) => other.number as number)
}

/** The server check failed: back to the maker with what failed, without spending a review. */
function sendBackFromPrecheck(p: any, issue: any, agent: any, gate: Gate, patch: Record<string, any>) {
  addComment(issue.id, 'Precheck', 'watchdog', gate.note)
  const fails = issue.precheck_fails + 1
  if (fails >= MAX_PRECHECK_FAILS) {
    patchIssue(issue.id, { ...patch, status: 'blocked', precheck_fails: 0 })
    return needsHuman(
      p,
      issue.id,
      `${agent.name} failed the precheck ${fails} times in a row. Last: ${gate.note}`,
    )
  }
  patchIssue(issue.id, { ...patch, status: 'todo', precheck_fails: fails, assignee_id: agent.id })
}

/** Checklist items are still open: an interim look by the first reviewer, or straight on. */
function handInPartial(
  p: any,
  issue: any,
  agent: any,
  agents: any[],
  gate: Gate,
  patch: Record<string, any>,
) {
  const streak = partialStreak(issue.id)
  if (streak >= MAX_PARTIALS) {
    patchIssue(issue.id, { ...patch, status: 'blocked' })
    return needsHuman(
      p,
      issue.id,
      `${agent.name} handed in ${streak} partial results in a row without finishing the checklist. ${gate.note}`,
    )
  }
  const first = nextReviewer(issue, 0, agent.id, agents)
  if (first < 0) {
    addComment(issue.id, 'System', 'system', `${gate.note} Carry on with the open items.`)
    return patchIssue(issue.id, { ...patch, status: 'todo' })
  }
  const reviewer = agents.find((a) => a.id === issue.reviewers[first])
  addComment(issue.id, 'System', 'system', `${gate.note} Interim review by ${reviewer.name}.`)
  patchIssue(issue.id, {
    ...patch,
    status: 'review',
    review_index: first,
    review_interim: 1,
    assignee_id: reviewer.id,
  })
}

async function finishWork(l: Live, p: any, issue: any, agent: any, res: RunResult, gate: Gate | null = null) {
  const agents = all('SELECT * FROM agents WHERE project_id=?', p.id).map(mapAgent)
  const summary =
    tag(res.text, 'summary') ?? res.text.replace(/<(handoff|status)>[\s\S]*?<\/\1>/gi, '').trim()
  const answer = (tag(res.text, 'status') ?? 'review').toLowerCase()
  const patch: Record<string, any> = { handoff: tag(res.text, 'handoff') ?? '' }
  let status = ['done', 'review', 'blocked'].includes(answer) ? answer : 'review'

  addComment(issue.id, agent.name, 'agent', summary || '(no summary)')

  if (answer.startsWith('handoff:')) {
    const name = answer.slice('handoff:'.length).trim()
    const target = agents.find((a) => a.enabled && a.name.toLowerCase() === name)
    if (target) {
      status = 'todo'
      patch.assignee_id = target.id
      addComment(issue.id, 'System', 'system', `Handed over from ${agent.name} to ${target.name}.`)
    }
  }

  // "Blocked, waits for ABC-12": the issue waits for it and goes on by itself, nobody has to decide.
  if (status === 'blocked') {
    const waitsFor = namedOpenIssues(p, issue, `${summary}\n${patch.handoff}`)
    if (waitsFor.length) {
      status = 'todo'
      patch.blocked_by = [...new Set([...issue.blocked_by, ...waitsFor])]
      addComment(
        issue.id,
        'System',
        'system',
        `Now waits for ${issueList(p.key, waitsFor)} and carries on by itself once that is done.`,
      )
    }
  }

  if (gate) patch.checklist_report = gate.report
  if (gate && gate.result !== 'passed') {
    endRun(l, 'done', res, '', '', gate.result === 'partial' ? 'partial' : 'precheck')
    if (getIssue(issue.id)?.status !== 'in_progress')
      return void patchIssue(issue.id, { handoff: patch.handoff })
    return gate.result === 'partial'
      ? handInPartial(p, issue, agent, agents, gate, patch)
      : sendBackFromPrecheck(p, issue, agent, gate, patch)
  }
  if (gate?.note) addComment(issue.id, 'Precheck', 'system', gate.note)
  if (gate) patch.precheck_fails = 0

  const isFinished = status === 'done' || status === 'review'

  if (isFinished && (await watchdogRejects(l, p, issue, summary))) {
    status = p.settings.watchdog.llm.onFail
    delete patch.assignee_id
  } else if (isFinished) {
    // After a change request the review goes on where it stopped, if the project wants that.
    const from = p.settings.resumeReview ? issue.review_from : 0
    const resumed = nextReviewer(issue, from, agent.id, agents)
    const first = resumed >= 0 || from === 0 ? resumed : nextReviewer(issue, 0, agent.id, agents)
    if (first >= 0) {
      const reviewer = agents.find((a) => a.id === issue.reviewers[first])
      status = 'review'
      patch.review_index = first
      patch.assignee_id = reviewer.id
      addComment(issue.id, 'System', 'system', `Sent to ${reviewer.name} for review.`)
    }
  }

  if (['review', 'done'].includes(status) && p.settings.preview.command && l.workdir) {
    await takeScreenshots(l, p, issue)
  }
  endRun(l, 'done', res, '', '', answer.startsWith('handoff:') ? 'handoff' : status)
  if (getIssue(issue.id)?.status !== 'in_progress')
    return void patchIssue(issue.id, { handoff: patch.handoff })

  // "done" without reviewers is final, so the branch lands now. The issue stays in progress until then.
  if (status === 'done') {
    patchIssue(issue.id, patch)
    return landAndClose(p, issue)
  }

  patchIssue(issue.id, { ...patch, status })
  if (status === 'blocked') needsHuman(p, issue.id, `${agent.name} is stuck: ${summary}`)
  if (status === 'review' && patch.review_index === undefined) {
    needsHuman(p, issue.id, `${agent.name} is done and asks for your review: ${summary}`)
  }
}

/** Screenshots of the branch for owner and reviewer, see preview.ts. A failure only leaves a note. */
async function takeScreenshots(l: Live, p: any, issue: any) {
  const text = 'Capturing the preview…'
  emit(p.id, { t: 'activity', runId: l.runId, issueId: issue.id, text, at: Date.now() })
  l.lastActivity = Date.now()
  try {
    const files = await capturePreview({
      issueId: issue.id,
      runId: l.runId,
      cwd: l.workdir!.cwd,
      settings: p.settings.preview,
    })
    addComment(issue.id, 'System', 'system', `Preview captured (${files.length} screenshots).`)
    emit(p.id, { t: 'shots', issueId: issue.id })
  } catch (error: any) {
    addComment(issue.id, 'System', 'system', `Preview not possible: ${error.message}`)
  }
}

/** Optional check by the watchdog's own LLM prompt before the issue leaves "in progress". */
async function watchdogRejects(l: Live, p: any, issue: any, summary: string) {
  const { enabled, llm } = p.settings.watchdog
  if (!enabled || !llm.enabled || !PROVIDERS[llm.provider]) return false

  emit(p.id, { t: 'activity', runId: l.runId, issueId: issue.id, text: 'Watchdog is checking the result…' })
  const started = Date.now()
  const verdict = await oneShot(
    llm.provider,
    `You are a strict reviewer. Check the work in the current directory (read-only; inspect files and git log/diff as needed).\n\n## Criteria\n${llm.prompt}\n\n## Issue\n${issue.title}\n${issue.description}\n\n## Worker summary\n${summary}\n\nReply with a first line that is exactly "PASS" or "FAIL: <reason>", then at most 5 short bullet points.`,
    l.workdir?.cwd ?? '.',
  )
  run(
    `INSERT INTO runs (project_id, issue_id, agent_id, agent_name, provider, kind, status, started_at, ended_at,
       input_tokens, output_tokens, cost_usd)
     VALUES (?,?,NULL,'Watchdog',?,'review','done',?,?,?,?,?)`,
    p.id,
    issue.id,
    llm.provider,
    started,
    Date.now(),
    verdict.usage.input,
    verdict.usage.output,
    verdict.usage.cost,
  )

  if (!verdict.ok) {
    addComment(issue.id, 'Watchdog', 'system', `Could not check: ${verdict.error}`)
    return false
  }
  if (!/^\s*FAIL/i.test(verdict.text)) return false
  addComment(issue.id, 'Watchdog', 'watchdog', verdict.text.trim())
  return true
}

/**
 * The reviewer's verdict from its status block. A reviewer that forgot the block but started its
 * summary the way the ADHD format asks ("Approved:", "Changes:") has still said what it means.
 */
function reviewVerdict(text: string, summary: string) {
  const stated = (tag(text, 'status') ?? '').toLowerCase().trim()
  if (stated) return stated
  if (/^\s*approved?\s*:/i.test(summary)) return 'approve'
  if (/^\s*changes\s*:/i.test(summary)) return 'changes'
  return ''
}

async function finishReview(l: Live, p: any, issue: any, reviewer: any, res: RunResult) {
  const agents = all('SELECT * FROM agents WHERE project_id=?', p.id).map(mapAgent)
  const maker = agents.find((a) => a.id === issue.maker_id)
  const summary = tag(res.text, 'summary') ?? res.text.replace(/<status>[\s\S]*?<\/status>/gi, '').trim()
  const verdict = reviewVerdict(res.text, summary)
  const backToMaker = { review_index: -1, assignee_id: maker?.id ?? null }

  addComment(issue.id, reviewer.name, 'review', summary || '(no reason given)')
  endRun(l, 'done', res, '', '', ['approve', 'changes'].includes(verdict) ? verdict : 'blocked')

  if (issue.review_interim && verdict === 'approve') {
    addComment(
      issue.id,
      'System',
      'system',
      `${reviewer.name} approved the interim state. Carry on with the open items.`,
    )
    return moveIssue(issue.id, { status: 'todo', review_interim: 0, ...backToMaker })
  }

  if (verdict === 'approve') {
    const next = nextReviewer(issue, issue.review_index + 1, issue.maker_id, agents)
    if (next >= 0) {
      const following = agents.find((a) => a.id === issue.reviewers[next])
      addComment(issue.id, 'System', 'system', `${reviewer.name} approved. On to ${following.name}.`)
      return moveIssue(issue.id, { status: 'review', review_index: next, assignee_id: following.id })
    }
    addComment(issue.id, 'System', 'system', `${reviewer.name} approved.`)
    return landAndClose(p, issue)
  }

  if (verdict === 'changes') {
    const rounds = issue.review_rounds + 1
    if (rounds >= p.settings.maxReviewRounds) {
      addComment(
        issue.id,
        'Watchdog',
        'watchdog',
        `${rounds} rounds of changes without approval. Please decide how to go on.`,
      )
      moveIssue(issue.id, { status: 'blocked', review_rounds: 0, review_interim: 0, ...backToMaker })
      return needsHuman(
        p,
        issue.id,
        `${rounds} rounds of changes without approval. Last objection: ${summary}`,
      )
    }
    return moveIssue(issue.id, {
      status: 'todo',
      review_rounds: rounds,
      review_from: p.settings.resumeReview && !issue.review_interim ? issue.review_index : 0,
      review_interim: 0,
      ...backToMaker,
    })
  }

  // "blocked", or no verdict at all: a human decides, and the issue stays with this reviewer.
  moveIssue(issue.id, { status: 'blocked' })
  needsHuman(p, issue.id, `${reviewer.name} needs your decision: ${summary}`)
}

export function stopRun(runId: number, reason: string, to: string, author = 'Watchdog') {
  const l = live.get(runId)
  if (!l || l.stop) return false
  l.stop = { to }
  addComment(l.issueId, author, author === 'Watchdog' ? 'watchdog' : 'system', reason)
  l.handle.kill()
  return true
}

export function stopIssueRun(issueId: number, reason: string, to: string, author: string) {
  const l = liveFor(issueId)
  return l ? stopRun(l.runId, reason, to, author) : false
}

// ---------- scheduler ----------

function tick() {
  for (const row of all('SELECT id FROM projects WHERE paused=0')) scheduleProject(getProject(row.id))
}

function scheduleProject(p: any) {
  const running = [...live.values()].filter((l) => l.projectId === p.id)
  let slots = p.settings.maxConcurrent - running.length

  // Waiting work: issues to do, and issues queued for a reviewer agent. Only the front of the
  // queue matters; the full issue is loaded when a run actually starts.
  const queue = all(
    `SELECT id, number, priority, assignee_id, blocked_by, review_index FROM issues
     WHERE project_id=? AND (status='todo' OR (status='review' AND review_index>=0))
     ORDER BY priority DESC, rank, id LIMIT 500`,
    p.id,
  ).map(mapIssue)
  if (!queue.length) {
    if (!running.length) openNextGroup(p)
    setWaiting(p.id, {})
    return setNotice(p.id, '')
  }

  const agents = all('SELECT * FROM agents WHERE project_id=? ORDER BY id', p.id).map(mapAgent)
  const startedNow: number[] = []

  // Blockers first, see blockers.ts. The sort is stable, so rank and age still decide ties.
  const weights = p.settings.blockerBoost
    ? blockerWeights(
        all(
          "SELECT number, priority, status, blocked_by FROM issues WHERE project_id=? AND status!='done'",
          p.id,
        ).map(mapIssue),
      )
    : new Map<number, Weight>()
  const priorityOf = (issue: any) => weights.get(issue.number)?.effective ?? issue.priority
  if (weights.size) queue.sort(byBlockerWeight(weights))

  // Quota pacing, see pacing.ts. The pace of a provider is asked once per pass.
  const paced = p.settings.quotaPacing
  const big = paced
    ? bigIssues(
        p.id,
        queue.map((issue) => issue.id),
      )
    : new Set<number>()
  const paces = new Map<string, Pace>()
  const paceFor = (provider: string) => {
    if (!paces.has(provider)) paces.set(provider, paceOf(provider).pace)
    return paces.get(provider)!
  }
  if (paced && big.size && agents.some((agent) => paceFor(agent.provider) === 'spend')) {
    // Same priority: big issues first, while the expiring quota can still pay for them.
    queue.sort((a, b) => priorityOf(b) - priorityOf(a) || Number(big.has(b.id)) - Number(big.has(a.id)))
  }
  const startedOn: string[] = []
  const runsOn = (provider: string) =>
    [...live.values()].filter((l) => l.provider === provider).length +
    startedOn.filter((name) => name === provider).length
  const busy = (agent: any) =>
    running.filter((l) => l.agentId === agent.id).length + startedNow.filter((id) => id === agent.id).length
  const isFree = (agent: any) => agent.enabled && busy(agent) < agent.max_instances

  // Every issue that does not start gets the reason, so the board can say why it waits.
  const reasons: Record<number, Reason> = {}
  const wait = (issue: any, kind: Reason['kind'], text: string) => void (reasons[issue.id] = { kind, text })
  const openNumbers = new Set(
    all("SELECT number FROM issues WHERE project_id=? AND status!='done'", p.id).map((row) => row.number),
  )

  let exhausted = false
  for (const issue of queue) {
    const blockers = issue.blocked_by.filter((number: number) => openNumbers.has(number))
    if (blockers.length) {
      wait(issue, 'blocked', `Waits for ${issueList(p.key, blockers)}`)
      continue
    }
    const retryAt = retryAfter.get(issue.id) ?? 0
    if (retryAt > Date.now()) {
      wait(issue, 'retry', `Next attempt from ${when(retryAt)}, the last run failed`)
      continue
    }

    const agent = issue.assignee_id ? agents.find((a) => a.id === issue.assignee_id) : agents.find(isFree)
    if (!agent) {
      wait(issue, 'agent', issue.assignee_id ? 'The assigned agent no longer exists' : 'No agent free')
      continue
    }
    if (!agent.enabled) {
      wait(issue, 'agent', `${agent.name} is switched off`)
      continue
    }
    if (!isFree(agent)) {
      wait(
        issue,
        'agent',
        `${agent.name} already works on ${busy(agent)} of at most ${agent.max_instances} issues`,
      )
      continue
    }
    if (slots <= 0) {
      wait(issue, 'full', `Project limit reached: ${p.settings.maxConcurrent} runs at once`)
      continue
    }

    const kind = issue.review_index >= 0 ? 'review' : 'work'
    const pick = pickProvider(p, agent, avoidProvider.get(issue.id), kind)
    if (!pick) {
      exhausted = true
      wait(issue, 'provider', `No provider available. ${providerProblems(p, agent, kind)}`)
      continue
    }
    const full = getIssue(issue.id)
    // The cap may have been lowered since the last run, so it is checked before every start too.
    if (parkIfOverCap(p, full)) continue
    avoidProvider.delete(issue.id)
    start(p, full, agent, agents, pick)
    startedNow.push(agent.id)
    startedOn.push(pick.provider)
    slots--
  }

  setWaiting(p.id, reasons)
  setNotice(p.id, exhausted ? exhaustedNotice(agents) : '')
}

export type Reason = { kind: 'blocked' | 'retry' | 'agent' | 'full' | 'provider'; text: string }

/** Why each waiting issue of a project does not start, as of the last scheduling pass. */
export const waiting = new Map<number, Record<number, Reason>>()

function setWaiting(projectId: number, reasons: Record<number, Reason>) {
  const before = JSON.stringify(waiting.get(projectId) ?? {})
  if (before === JSON.stringify(reasons)) return
  waiting.set(projectId, reasons)
  emit(projectId, { t: 'waiting', reasons })
}

const issueList = (key: string, numbers: number[]) => {
  const shown = numbers.slice(0, 3).map((number) => `${key}-${number}`)
  return numbers.length > 3 ? `${shown.join(', ')} and ${numbers.length - 3} more` : shown.join(', ')
}

/** For each provider the agent may use: why it cannot take the run right now. */
function providerProblems(p: any, agent: any, kind: 'work' | 'review') {
  const s = p.settings
  const mayFall = s.fallbackEnabled && (kind === 'work' || s.fallbackReviews)
  const chain = [agent.provider, ...(mayFall ? s.fallback : [])]
  const problems = [...new Set(chain)]
    .filter((provider) => PROVIDERS[provider])
    .map((provider) => {
      const state = providerLeft(p, provider)
      const label = PROVIDERS[provider].label
      if (state.resting) return `${label}: ${state.resting.reason} until ${when(state.resting.until)}`
      if (!state.ready) return `${label}: not set up`
      const reset = state.quotas.find((quota: any) => quota.resets_at)?.resets_at
      const stop = provider === agent.provider ? state.budget.stopAtPct : s.fallbackReservePct
      const stopText = provider === agent.provider ? `stops at ${stop}%` : `reserve ${stop}%`
      return `${label}: ${Math.round(state.left)}% left, ${stopText}${reset ? `, reset ${when(reset)}` : ''}`
    })
  const note = !s.fallbackEnabled
    ? ' · Fallback is switched off'
    : kind === 'review' && !s.fallbackReviews
      ? ' · Reviews do not fall back'
      : ''
  return problems.join(' · ') + note
}

function exhaustedNotice(agents: any[]) {
  const resting = [...new Set(agents.map((a) => a.provider))]
    .map((provider) => ({ provider, rest: restOf(provider) }))
    .filter((r) => r.rest)
    .map(
      (r) => `${PROVIDERS[r.provider]?.label ?? r.provider}: ${r.rest!.reason} until ${when(r.rest!.until)}`,
    )
  if (resting.length) return `Agents are paused. ${resting.join(', ')}.`
  return 'Usage limit reached: no provider is above its threshold. Agents are paused.'
}

/**
 * Groups are worked one after the other: "1 Refactor" before "2 Polish". When no issue is open
 * any more, the backlog of the next group moves to "todo". Blockers keep the order inside it.
 */
function openNextGroup(p: any) {
  if (!p.settings.openGroupsInOrder) return
  const open = get(
    "SELECT 1 FROM issues WHERE project_id=? AND status IN ('todo','in_progress','review','blocked') LIMIT 1",
    p.id,
  )
  if (open) return
  const next = get(
    "SELECT MIN(grp) AS grp FROM issues WHERE project_id=? AND status='backlog' AND grp!=''",
    p.id,
  )?.grp
  if (!next) return

  const waiting = all(
    "SELECT id FROM issues WHERE project_id=? AND status='backlog' AND grp=? AND capped=0",
    p.id,
    next,
  )
  for (const issue of waiting) patchIssue(issue.id, { status: 'todo' })
  console.log(`${p.key}: nothing left to work on, group "${next}" opened (${waiting.length} issues)`)
  kick()
}

// ---------- watchdog ----------

function watchdog() {
  const now = Date.now()
  for (const l of [...live.values()]) {
    const settings = getProject(l.projectId)?.settings.watchdog
    if (!settings?.enabled || l.stop || l.checking) continue

    for (const rule of settings.rules) {
      const minutes =
        rule.type === 'stall'
          ? (now - l.lastActivity) / 60_000
          : rule.type === 'runtime'
            ? (now - l.startedAt) / 60_000
            : -1
      if (minutes < rule.value) continue

      const message =
        rule.type === 'stall'
          ? `No activity for ${rule.value} minutes.`
          : `Run is taking longer than ${rule.value} minutes.`
      if (rule.action === 'comment') {
        if (!l.warned.has(rule.type)) addComment(l.issueId, 'Watchdog', 'watchdog', message)
        l.warned.add(rule.type)
      } else {
        stopRun(l.runId, `${message} Run stopped.`, rule.action === 'block' ? 'blocked' : 'todo')
        break
      }
    }
  }
}

// Many things ask for a scheduling pass (every edit, every finished run). Under load they arrive
// in bursts, so passes are spaced out instead of running once per request.
const MIN_TICK_GAP_MS = 40
let pending = false
let lastTick = 0

export function kick() {
  if (pending) return
  pending = true
  const wait = Math.max(0, lastTick + MIN_TICK_GAP_MS - Date.now())
  setTimeout(() => {
    pending = false
    lastTick = Date.now()
    try {
      tick()
    } catch (e) {
      console.error('tick', e)
    }
  }, wait)
}

export function startEngine() {
  setInterval(kick, 5_000).unref()
  setInterval(() => {
    try {
      watchdog()
    } catch (e) {
      console.error('watchdog', e)
    }
  }, 10_000).unref()
  setInterval(() => {
    try {
      sweepWaitingIssues()
    } catch (e) {
      console.error('sweep', e)
    }
  }, 30_000).unref()
  watchPullRequests(getProject, (issueId, outcome) => {
    const issue = getIssue(issueId)
    if (issue) applyLanding(getProject(issue.project_id), issueId, outcome)
    kick()
  })
  kick()
}

export function shutdown() {
  for (const l of live.values()) l.handle.kill()
}
