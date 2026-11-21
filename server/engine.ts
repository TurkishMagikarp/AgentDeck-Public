// The scheduler: decides which agent starts on which issue, follows the run and moves the issue
// on when it ends (done, to the next reviewer, back to the maker, or to a human).
import { join } from 'node:path'
import { oneShot, startRun, type RunHandle, type RunResult } from './adapters.ts'
import {
  activity,
  addComment,
  emit,
  getAgent,
  getIssue,
  getProject,
  invalidate,
  mapAgent,
  mapIssue,
  patchIssue,
  pickProvider,
  PROVIDERS,
} from './core.ts'
import { all, get, run } from './db.ts'
import { landIssue, watchPullRequests, type Outcome } from './landing.ts'
import { notifyOwner } from './notify.ts'
import { buildPrompt, tag, type RunKind } from './prompt.ts'
import { rtkEnv } from './rtk.ts'
import { createRunToken, revokeRunToken } from './runTokens.ts'
import { prepareWorkdir, releaseWorkdir, type Workdir } from './workspace.ts'

type Live = {
  runId: number
  issueId: number
  projectId: number
  agentId: number
  /** Which parallel copy of the agent this is. Decides the checkout in the agent layout. */
  slot: number
  kind: RunKind
  handle: RunHandle
  workdir?: Workdir
  startedAt: number
  lastActivity: number
  warned: Set<string>
  stop?: { to: string }
}

type Pick = { provider: string; model: string; fallback: boolean }

const live = new Map<number, Live>()
const retryAfter = new Map<number, number>()
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
  patchIssue(issue.id, taken)
  if (pick.fallback) {
    const preferred = PROVIDERS[agent.provider]?.label ?? agent.provider
    addComment(
      issue.id,
      'System',
      'system',
      `Routing: ${preferred} liegt unter der Schwelle, dieser Lauf nutzt ${PROVIDERS[pick.provider].label}.`,
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
      if (l.stop) return finish(l, agent, failed('gestoppt'))
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
          }),
          autonomous: true,
          mcp: agent.mcp_ids,
          env: {
            AGENTDECK_URL: OWN_URL,
            AGENTDECK_RUN_TOKEN: token,
            AGENTDECK_CLI: AGENT_CLI,
            ...noPush(p),
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
      addComment(
        issue.id,
        'System',
        'system',
        `Arbeitsverzeichnis konnte nicht vorbereitet werden: ${e.message}`,
      )
      return finish(l, agent, failed(e.message))
    })
    .catch((e) => console.error('run', e))
}

// ---------- ending a run ----------

function endRun(l: Live, status: string, res: RunResult, note = '') {
  live.delete(l.runId)
  activity.delete(l.runId)
  revokeRunToken(l.runId)
  run(
    `UPDATE runs SET status=?, ended_at=?, input_tokens=?, output_tokens=?, cached_tokens=?, cost_usd=?, note=?
     WHERE id=?`,
    status,
    Date.now(),
    res.usage.input,
    res.usage.output,
    res.usage.cached ?? 0,
    res.usage.cost,
    note,
    l.runId,
  )
  invalidate(l.projectId)
  emit(l.projectId, { t: 'run.end', id: l.runId, issueId: l.issueId })
}

function failedStreak(issueId: number) {
  const recent = all(
    "SELECT status FROM runs WHERE issue_id=? AND agent_name!='Watchdog' ORDER BY id DESC LIMIT 20",
    issueId,
  )
  const firstGood = recent.findIndex((r) => r.status === 'done')
  return firstGood === -1 ? recent.length : firstGood
}

async function finish(l: Live, agent: any, res: RunResult) {
  const p = getProject(l.projectId)
  const issue = getIssue(l.issueId)
  if (p && l.workdir) await releaseWorkdir(p, l.workdir)
  if (!p || !issue) return void endRun(l, 'failed', res, 'Issue gelöscht')

  if (l.stop || !res.ok) finishFailed(l, p, issue, agent, res)
  else if (l.kind === 'review') await finishReview(l, p, issue, agent, res)
  else await finishWork(l, p, issue, agent, res)
  kick()
}

/** The issue changes only if nobody moved it by hand while the agent was running. */
function moveIssue(issueId: number, patch: Record<string, any>) {
  if (getIssue(issueId)?.status === 'in_progress') patchIssue(issueId, patch)
}

/** How often the deputy may take the same issue before it is parked. */
const MAX_DEPUTY_DECISIONS = 3

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
    `An ${deputy.name} zur Entscheidung: ${reason}\n\nLies, warum es hängt, und entscheide, wie es weitergeht.`,
  )
  patchIssue(issue.id, {
    status: 'todo',
    assignee_id: deputy.id,
    review_index: -1,
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
      addComment(issue.id, 'System', 'system', `Zur Prüfung an ${deputy.name}.`)
      return patchIssue(issue.id, { reviewers: [deputy.id], review_index: 0, assignee_id: deputy.id })
    }
    addComment(
      issue.id,
      'System',
      'system',
      'Kein weiterer Prüfer vorhanden, die Arbeit gilt als abgenommen.',
    )
    patchIssue(issue.id, { status: 'done' })
    return landByHand(issue.id)
  }

  const deputyGaveUp = !deputy || issue.assignee_id === deputy.id || issue.escalated >= MAX_DEPUTY_DECISIONS
  if (!deputyGaveUp) return handToDeputy(issue, deputy, reason)

  const note = `Geparkt: ${reason}\n\nDas Issue liegt im Backlog und hält nichts auf. Es kommt wieder dran, sobald die offene Arbeit erledigt ist.`
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
        issue.status === 'review'
          ? 'Wartete auf eine Prüfung durch einen Menschen.'
          : 'Stand auf „Wartet auf Mensch“.'
      settleWithoutHuman(p, issue, reason)
    }
    if (waiting.length) kick()
  }
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
      addComment(
        issueId,
        'Watchdog',
        'watchdog',
        'Die Landung ist mehrfach gescheitert. Bitte entscheiden, wie es weitergeht.',
      )
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

function finishFailed(l: Live, p: any, issue: any, agent: any, res: RunResult) {
  endRun(l, l.stop ? 'stopped' : 'failed', res, res.error ?? '')
  if (!l.stop) {
    addComment(
      issue.id,
      'System',
      'system',
      `Lauf von ${agent.name} fehlgeschlagen: ${res.error ?? 'unbekannter Fehler'}`,
    )
  }

  // Back into the queue it came from: a failed review stays a review.
  const queue = l.kind === 'review' ? 'review' : 'todo'
  let to = l.stop?.to === 'todo' ? queue : (l.stop?.to ?? queue)
  if (to === queue) {
    const watchdog = p.settings.watchdog
    const streak = failedStreak(issue.id)
    const limit = (watchdog.enabled && watchdog.rules.find((r: any) => r.type === 'attempts')?.value) || 5
    if (streak >= limit) {
      to = 'blocked'
      addComment(
        issue.id,
        'Watchdog',
        'watchdog',
        `${streak} Läufe in Folge ohne Ergebnis. Issue blockiert, bitte prüfen.`,
      )
    } else {
      retryAfter.set(issue.id, Date.now() + 15_000 * 2 ** streak)
    }
  }
  moveIssue(issue.id, { status: to })
  if (to === 'blocked') needsHuman(p, issue.id, 'Mehrere Läufe sind ohne Ergebnis geblieben.')
}

/** Position of the next reviewer who can actually review: enabled, and not the maker. */
function nextReviewer(issue: any, from: number, makerId: number, agents: any[]) {
  for (let index = from; index < issue.reviewers.length; index++) {
    const reviewer = agents.find((a) => a.id === issue.reviewers[index])
    if (reviewer?.enabled && reviewer.id !== makerId) return index
  }
  return -1
}

async function finishWork(l: Live, p: any, issue: any, agent: any, res: RunResult) {
  const agents = all('SELECT * FROM agents WHERE project_id=?', p.id).map(mapAgent)
  const summary =
    tag(res.text, 'summary') ?? res.text.replace(/<(handoff|status)>[\s\S]*?<\/\1>/gi, '').trim()
  const answer = (tag(res.text, 'status') ?? 'review').toLowerCase()
  const patch: Record<string, any> = { handoff: tag(res.text, 'handoff') ?? '' }
  let status = ['done', 'review', 'blocked'].includes(answer) ? answer : 'review'

  addComment(issue.id, agent.name, 'agent', summary || '(keine Zusammenfassung)')

  if (answer.startsWith('handoff:')) {
    const name = answer.slice('handoff:'.length).trim()
    const target = agents.find((a) => a.enabled && a.name.toLowerCase() === name)
    if (target) {
      status = 'todo'
      patch.assignee_id = target.id
      addComment(issue.id, 'System', 'system', `Übergabe von ${agent.name} an ${target.name}.`)
    }
  }

  const isFinished = status === 'done' || status === 'review'

  if (isFinished && (await watchdogRejects(l, p, issue, summary))) {
    status = p.settings.watchdog.llm.onFail
    delete patch.assignee_id
  } else if (isFinished) {
    const first = nextReviewer(issue, 0, agent.id, agents)
    if (first >= 0) {
      const reviewer = agents.find((a) => a.id === issue.reviewers[first])
      status = 'review'
      patch.review_index = first
      patch.assignee_id = reviewer.id
      addComment(issue.id, 'System', 'system', `Zur Prüfung an ${reviewer.name}.`)
    }
  }

  endRun(l, 'done', res)
  if (getIssue(issue.id)?.status !== 'in_progress')
    return void patchIssue(issue.id, { handoff: patch.handoff })

  // "done" without reviewers is final, so the branch lands now. The issue stays in progress until then.
  if (status === 'done') {
    patchIssue(issue.id, { handoff: patch.handoff })
    return landAndClose(p, issue)
  }

  patchIssue(issue.id, { ...patch, status })
  if (status === 'blocked') needsHuman(p, issue.id, `${agent.name} kommt nicht weiter: ${summary}`)
  if (status === 'review' && patch.review_index === undefined) {
    needsHuman(p, issue.id, `${agent.name} ist fertig und bittet um deine Prüfung: ${summary}`)
  }
}

/** Optional check by the watchdog's own LLM prompt before the issue leaves "in progress". */
async function watchdogRejects(l: Live, p: any, issue: any, summary: string) {
  const { enabled, llm } = p.settings.watchdog
  if (!enabled || !llm.enabled || !PROVIDERS[llm.provider]) return false

  emit(p.id, { t: 'activity', runId: l.runId, issueId: issue.id, text: 'Watchdog prüft das Ergebnis…' })
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
    addComment(issue.id, 'Watchdog', 'system', `Prüfung nicht möglich: ${verdict.error}`)
    return false
  }
  if (!/^\s*FAIL/i.test(verdict.text)) return false
  addComment(issue.id, 'Watchdog', 'watchdog', verdict.text.trim())
  return true
}

async function finishReview(l: Live, p: any, issue: any, reviewer: any, res: RunResult) {
  const agents = all('SELECT * FROM agents WHERE project_id=?', p.id).map(mapAgent)
  const maker = agents.find((a) => a.id === issue.maker_id)
  const summary = tag(res.text, 'summary') ?? res.text.replace(/<status>[\s\S]*?<\/status>/gi, '').trim()
  const verdict = (tag(res.text, 'status') ?? '').toLowerCase()
  const backToMaker = { review_index: -1, assignee_id: maker?.id ?? null }

  addComment(issue.id, reviewer.name, 'review', summary || '(keine Begründung)')
  endRun(l, 'done', res)

  if (verdict === 'approve') {
    const next = nextReviewer(issue, issue.review_index + 1, issue.maker_id, agents)
    if (next >= 0) {
      const following = agents.find((a) => a.id === issue.reviewers[next])
      addComment(
        issue.id,
        'System',
        'system',
        `${reviewer.name} hat freigegeben. Weiter an ${following.name}.`,
      )
      return moveIssue(issue.id, { status: 'review', review_index: next, assignee_id: following.id })
    }
    addComment(issue.id, 'System', 'system', `${reviewer.name} hat freigegeben.`)
    return landAndClose(p, issue)
  }

  if (verdict === 'changes') {
    const rounds = issue.review_rounds + 1
    if (rounds >= p.settings.maxReviewRounds) {
      addComment(
        issue.id,
        'Watchdog',
        'watchdog',
        `${rounds} Änderungsrunden ohne Freigabe. Bitte entscheiden, wie es weitergeht.`,
      )
      moveIssue(issue.id, { status: 'blocked', review_rounds: 0, ...backToMaker })
      return needsHuman(p, issue.id, `${rounds} Änderungsrunden ohne Freigabe. Letzter Einwand: ${summary}`)
    }
    return moveIssue(issue.id, { status: 'todo', review_rounds: rounds, ...backToMaker })
  }

  // "blocked", or no verdict at all: a human decides, and the issue stays with this reviewer.
  moveIssue(issue.id, { status: 'blocked' })
  needsHuman(p, issue.id, `${reviewer.name} braucht deine Entscheidung: ${summary}`)
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
  if (slots <= 0) return

  // Waiting work: issues to do, and issues queued for a reviewer agent. Only the front of the
  // queue matters; the full issue is loaded when a run actually starts.
  const queue = all(
    `SELECT id, number, assignee_id, blocked_by, review_index FROM issues
     WHERE project_id=? AND (status='todo' OR (status='review' AND review_index>=0))
     ORDER BY priority DESC, rank, id LIMIT 500`,
    p.id,
  ).map(mapIssue)
  if (!queue.length) {
    if (!running.length) openNextGroup(p)
    return setNotice(p.id, '')
  }

  const agents = all('SELECT * FROM agents WHERE project_id=? ORDER BY id', p.id).map(mapAgent)
  const startedNow: number[] = []
  const busy = (agent: any) =>
    running.filter((l) => l.agentId === agent.id).length + startedNow.filter((id) => id === agent.id).length
  const isFree = (agent: any) => agent.enabled && busy(agent) < agent.max_instances

  const waitsOnOthers = (issue: any) =>
    issue.blocked_by.length > 0 &&
    !!get(
      `SELECT 1 FROM issues WHERE project_id=? AND status!='done'
       AND number IN (${issue.blocked_by.map(() => '?').join(',')}) LIMIT 1`,
      p.id,
      ...issue.blocked_by,
    )

  let exhausted = false
  for (const issue of queue) {
    if (slots <= 0) break
    if (waitsOnOthers(issue)) continue
    if ((retryAfter.get(issue.id) ?? 0) > Date.now()) continue

    const agent = issue.assignee_id ? agents.find((a) => a.id === issue.assignee_id) : agents.find(isFree)
    if (!agent || !isFree(agent)) continue

    const pick = pickProvider(p, agent)
    if (!pick) {
      exhausted = true
      continue
    }
    start(p, getIssue(issue.id), agent, agents, pick)
    startedNow.push(agent.id)
    slots--
  }

  setNotice(
    p.id,
    exhausted ? 'Usage-Limit erreicht: kein Provider liegt über seiner Schwelle. Agenten pausieren.' : '',
  )
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

  const waiting = all("SELECT id FROM issues WHERE project_id=? AND status='backlog' AND grp=?", p.id, next)
  for (const issue of waiting) patchIssue(issue.id, { status: 'todo' })
  console.log(`${p.key}: nothing left to work on, group "${next}" opened (${waiting.length} issues)`)
  kick()
}

// ---------- watchdog ----------

function watchdog() {
  const now = Date.now()
  for (const l of [...live.values()]) {
    const settings = getProject(l.projectId)?.settings.watchdog
    if (!settings?.enabled || l.stop) continue

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
          ? `Keine Aktivität seit ${rule.value} Minuten.`
          : `Lauf dauert länger als ${rule.value} Minuten.`
      if (rule.action === 'comment') {
        if (!l.warned.has(rule.type)) addComment(l.issueId, 'Watchdog', 'watchdog', message)
        l.warned.add(rule.type)
      } else {
        stopRun(l.runId, `${message} Lauf gestoppt.`, rule.action === 'block' ? 'blocked' : 'todo')
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
