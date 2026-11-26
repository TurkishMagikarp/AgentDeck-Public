// The scheduler: decides which agent starts on which issue, follows the run and moves the issue
// on when it ends (done, to the next reviewer, back to the maker, or to a human).
import { trace } from './landingTrace.ts'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { oneShot, startRun, type RunHandle, type RunResult } from './adapters.ts'
import {
  arenaOf,
  closeArena,
  dissolveArena,
  holdEntry,
  juryPrompt,
  labelled,
  openArenas,
  parseVerdict,
  type ArenaView,
} from './arena.ts'
import { readyBacklog } from './backlog.ts'
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
  providerOrder,
  routeProvider,
  PROVIDERS,
  takeChangedProjects,
} from './core.ts'
import { connectionsFor } from './mcp.ts'
import { checklistFor, parseReport } from './checklist.ts'
import { issueChanges } from './diff.ts'
import { all, DATA_DIR, get, run, tx } from './db.ts'
import {
  baseBranchOf,
  branchTip,
  githubTokenOf,
  landIssue,
  landings,
  onLandingsChange,
  watchPullRequests,
  type Outcome,
} from './landing.ts'
import { forProject, langOf, t } from './i18n.ts'
import { addLesson } from './lessons.ts'
import { notifyOwner } from './notify.ts'
import { runFailed } from './webhooks.ts'
import { blockerWeights, byBlockerWeight, cycles, type Weight } from './blockers.ts'
import { partialStep, waitingLines } from './partial.ts'
import { overCap } from './issueCap.ts'
import { capturePreview } from './preview.ts'
import { precheck } from './precheck.ts'
import { bigIssues, paceOf, type Pace } from './pacing.ts'
import { buildPrompt, tag, type RunKind } from './prompt.ts'
import { rtkEnv } from './rtk.ts'
import { createRunToken, revokeRunToken } from './runTokens.ts'
import { prepareWorkdir, releaseWorkdir, type Workdir } from './workspace.ts'
import { headOf, knownSecrets, promptHash, recordRun, runChanges, type Recorder } from './runEvents.ts'
import {
  classifyFailure,
  clock,
  hintFor,
  when,
  parkedRest,
  parksSince,
  PROVIDER_FAILURES,
  restOf,
  restProvider,
  retryDelay,
  whenProviderWakes,
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
  /** The replay of the run (runEvents.ts), when the project records them. */
  trace?: Recorder
  /** HEAD of the checkout when the run started, to show what the run changed. */
  startHead?: string
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

function start(p: any, issue: any, agent: any, agents: any[], pick: Pick, skipped: string[]) {
  const kind: RunKind = issue.review_index >= 0 ? 'review' : 'work'
  const model = pick.model
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
      addComment(issue.id, 'System', 'system', checklistNote(items.length, template))
    }
  }
  patchIssue(issue.id, taken)
  if (skipped.length) {
    addComment(
      issue.id,
      'System',
      'system',
      t('Routing: {provider} gewählt. Übersprungen: {skipped}.', {
        provider: PROVIDERS[pick.provider].label,
        skipped: skipped.join(' · '),
      }),
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
      if (l.stop) return finish(l, agent, failed(t('gestoppt')))
      // A reviewer that gets the diff does not spend its context searching for the change.
      const changes =
        kind === 'review' ? await issueChanges(p, issue.number).catch(() => undefined) : undefined
      try {
        const current = getIssue(issue.id)
        const mcp = p.settings.mcpOnDemand ? connectionsFor(agent.mcp_ids, current) : agent.mcp_ids
        const prompt = buildPrompt({
          project: p,
          issue: current,
          heldBack: agent.mcp_ids.filter((id: string) => !mcp.includes(id)),
          agent,
          team: agents,
          workdir,
          kind,
          decides: kind === 'work' && issue.escalated > 0 && deputyOf(p)?.id === agent.id,
          changes,
        })
        const env = {
          AGENTDECK_URL: OWN_URL,
          AGENTDECK_RUN_TOKEN: token,
          AGENTDECK_CLI: AGENT_CLI,
          AGENTDECK_LANG: langOf(p),
          ...noPush(p),
          ...ownGithubToken(p),
          ...rtkEnv(p.key, agent.id),
        }
        if (p.settings.replay) {
          // The run's token and a project GitHub token have no shape the scanner knows.
          l.trace = recordRun(runId, knownSecrets(env))
          if (kind === 'work') l.startHead = await headOf(workdir.cwd)
          if (l.stop) return finish(l, agent, failed(t('gestoppt')))
          l.trace.add({ kind: 'prompt', name: `sha256:${promptHash(prompt)}`, text: prompt })
        }
        const trace = l.trace
        l.handle = startRun({
          provider: pick.provider,
          model,
          effort: agent.effort,
          cwd: workdir.cwd,
          prompt,
          autonomous: true,
          mcp,
          env,
          onEvent: trace ? (event) => trace.add(event) : undefined,
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
        t('Arbeitsverzeichnis konnte nicht vorbereitet werden: {error}', { error: e.message }),
      )
      return finish(l, agent, failed(e.message))
    })
    .catch((e) => console.error('run', e))
}

function checklistNote(count: number, template?: string) {
  if (template) {
    return count === 1
      ? t('Abnahme-Checkliste angelegt (1 Punkt, Vorlage „{template}“).', { template })
      : t('Abnahme-Checkliste angelegt ({count} Punkte, Vorlage „{template}“).', { count, template })
  }
  return count === 1
    ? t('Abnahme-Checkliste angelegt (1 Punkt).')
    : t('Abnahme-Checkliste angelegt ({count} Punkte).', { count })
}

// ---------- ending a run ----------

function endRun(l: Live, status: string, res: RunResult, note = '', failure = '', verdict = '') {
  live.delete(l.runId)
  activity.delete(l.runId)
  revokeRunToken(l.runId)
  if (l.trace) {
    l.trace.add({ kind: 'end', text: endSummary(status, res, note, verdict) })
    l.trace.close()
  }
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
  if (status === 'failed') runFailed(l.projectId, l.issueId)
}

/** The last step of a replay: how the run ended and what it used. */
function endSummary(status: string, res: RunResult, note: string, verdict: string) {
  const ended =
    status === 'done'
      ? t('Lauf abgeschlossen')
      : status === 'failed'
        ? t('Lauf fehlgeschlagen')
        : status === 'stopped'
          ? t('Lauf gestoppt')
          : t('Lauf {status}', { status })
  return [
    `${ended}${verdict ? ` (${verdict})` : ''}.`,
    t('Tokens: {input} rein (davon {cached} aus dem Cache), {output} raus', {
      input: res.usage.input,
      cached: res.usage.cached ?? 0,
      output: res.usage.output,
    }) +
      (res.usage.cost ? `, $${res.usage.cost.toFixed(2)}` : '') +
      '.',
    note || res.error || '',
  ]
    .filter(Boolean)
    .join('\n')
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

/** A run ends long after the pass that started it, so its end sets the project's language again. */
function finish(l: Live, agent: any, res: RunResult) {
  return forProject(getProject(l.projectId), () => finishRun(l, agent, res))
}

async function finishRun(l: Live, agent: any, res: RunResult) {
  const p = getProject(l.projectId)
  const issue = getIssue(l.issueId)
  // What the run left in its checkout, read while it is still the run's.
  if (l.trace && l.startHead && l.workdir) {
    const changes = await runChanges(l.workdir.cwd, l.startHead).catch((e) => t('Änderungen nicht lesbar: {error}', { error: e.message }))
    if (changes) l.trace.add({ kind: 'changes', text: changes })
  }
  // Checked in the maker's checkout before it is let go, while the branch is still checked out there.
  const gate = p && issue && l.kind === 'work' && !l.stop && res.ok ? await gateWork(l, p, issue, res) : null
  if (p && l.workdir) await releaseWorkdir(p, l.workdir)
  if (!p || !issue) return void endRun(l, 'failed', res, t('Issue gelöscht'))

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
  const note = t(
    'Kosten-Deckel erreicht: {reason}. Das Issue ist geparkt. Mit „Weitere Runde freigeben“ oder durch Zurückschieben auf To Do darf es noch einmal so viel verbrauchen.',
    { reason },
  )
  addComment(issue.id, 'Kosten-Deckel', 'watchdog', note)
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
    t('An {name} zur Entscheidung: {reason}\n\nLies, warum es hängt, und entscheide, wie es weitergeht.', {
      name: deputy.name,
      reason,
    }),
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
      addComment(issue.id, 'System', 'system', t('Zur Prüfung an {name}.', { name: deputy.name }))
      return patchIssue(issue.id, { reviewers: [deputy.id], review_index: 0, assignee_id: deputy.id })
    }
    addComment(
      issue.id,
      'System',
      'system',
      t('Kein weiterer Prüfer vorhanden, die Arbeit gilt als abgenommen.'),
    )
    patchIssue(issue.id, { status: 'done' })
    return landByHand(issue.id)
  }

  const deputyGaveUp = !deputy || issue.assignee_id === deputy.id || issue.escalated >= MAX_DEPUTY_DECISIONS
  if (!deputyGaveUp) return handToDeputy(issue, deputy, reason)

  // A parked issue rests before anything pulls it out of the backlog again, longer each time.
  // Without the rest an issue that fails at once (a checkout git refuses) is parked and started
  // again every second, see parkedRest.
  const parkedUntil = Date.now() + parkedRest(issue.id)
  // The note starts with "Geparkt:" in either language; parksSince and the reports find it by that.
  const rest = t(
    'Das Issue liegt im Backlog und hält nichts auf. Es kommt frühestens {when} wieder dran, sobald die offene Arbeit erledigt ist. Zurück auf To Do geschoben, startet es sofort.',
    { when: when(parkedUntil) },
  )
  const note = `${t('Geparkt:')} ${reason}\n\n${rest}`
  addComment(issue.id, 'Watchdog', 'watchdog', note)
  patchIssue(issue.id, {
    status: 'backlog',
    review_index: -1,
    assignee_id: issue.maker_id ?? issue.assignee_id,
    parked_until: parkedUntil,
  })
  notifyOwner(p, issue, note)
}

/**
 * The safety net of an autonomous project: whatever still sits in a state that waits for a
 * person (moved there by hand, imported that way, or left by an older version) is settled.
 */
let lastSweep = 0

function sweepWaitingIssues(everyProject: boolean) {
  // What the sweep looks at only changes with the board, so a project nobody touched is skipped,
  // unless a parked issue came free since the last sweep. The full pass catches writes that went
  // around the event bus.
  const now = Date.now()
  const unparked = all(
    "SELECT DISTINCT project_id AS id FROM issues WHERE status='backlog' AND parked_until>? AND parked_until<=?",
    lastSweep,
    now,
  ).map((row) => row.id)
  lastSweep = now
  const changed = [...new Set([...takeChangedProjects(), ...unparked])]
  const ids = everyProject ? all('SELECT id FROM projects WHERE paused=0').map((row) => row.id) : changed
  for (const id of ids) {
    const p = getProject(id)
    if (!p || p.paused || !p.settings.autonomous) continue
    forProject(p, () => sweepProject(p))
  }
}

function sweepProject(p: any) {
  const waiting = all(
    `SELECT id FROM issues WHERE project_id=?
     AND ((status='blocked' AND landing!='approval') OR (status='review' AND review_index<0 AND landing=''))`,
    p.id,
  )
  for (const { id } of waiting) {
    const issue = getIssue(id)
    const reason =
      issue.status === 'review'
        ? t('Wartete auf eine Prüfung durch einen Menschen.')
        : t('Stand auf „Wartet auf Mensch“.')
    settleWithoutHuman(p, issue, reason)
  }
  if (waiting.length + pullBlockersFromBacklog(p) + resolveRings(p)) kick()
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
      title: t('Ring-Abhängigkeit auflösen: {ring}', { ring: ringText(p.key, ring) }),
      description:
        t('Diese Issues warten im Kreis aufeinander und starten deshalb nie (A → B heißt: A wartet auf B):') +
        `\n${ringText(p.key, ring)}\n\n` +
        t(
          'Lies die Issues und entferne die Abhängigkeit, die am wenigsten Sinn ergibt, mit `node "$AGENTDECK_CLI" unblock <number> <blocker>`. Schließe dieses Issue dann mit `done`. Bleibt der Kreis bestehen, löst AgentDeck ihn danach selbst auf.',
        ) +
        `\n\n${marker}`,
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
        t('Steckt in einer Ring-Abhängigkeit ({ring}). {name} entscheidet in {issue}.', {
          ring: ringText(p.key, ring),
          name: deputy.name,
          issue: `${p.key}-${created.number}`,
        }),
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
  const note = t('Ring-Abhängigkeit aufgelöst ({ring}): {waiter} wartet nicht mehr auf {blocker}.', {
    ring: ringText(p.key, ring),
    waiter: `${p.key}-${edge.waiter}`,
    blocker: `${p.key}-${edge.blocker}`,
  })
  addComment(
    waiter.id,
    'Watchdog',
    'watchdog',
    `${note} ${t('Prüf, ob dadurch etwas fehlt, und lege dafür bei Bedarf ein neues Issue an.')}`,
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
    `SELECT id FROM issues WHERE project_id=? AND status='backlog' AND capped=0 AND parked_until<=?
     AND number IN (${[...waitingOn.keys()].map(() => '?').join(',')})`,
    p.id,
    Date.now(),
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
          t(
            '{blocker} ließ sich nicht erledigen und hält dieses Issue nicht mehr auf. Prüf, ob ohne es etwas fehlt, und lege dafür bei Bedarf ein neues Issue an.',
            { blocker: `${p.key}-${blocker.number}` },
          ),
        )
      }
      addComment(
        blocker.id,
        'Watchdog',
        'watchdog',
        t('Hält nicht mehr auf: {issues}. Die warten nicht länger auf dieses Issue.', { issues: keys }),
      )
      continue
    }

    const parked = parksSince(blocker.id) > 0
    const decider = parked && deputy ? deputy : null
    const back = {
      count: dependents.length,
      issues: keys,
      attempt: blocker.blocker_returns + 1,
      max: MAX_BLOCKER_RETURNS,
    }
    addComment(
      blocker.id,
      'Watchdog',
      'watchdog',
      decider
        ? t(
            'Lag im Backlog, aber {count} Issues warten darauf ({issues}). Zurück in die Warteschlange, {name} entscheidet. Versuch {attempt} von {max}.',
            { ...back, name: decider.name },
          )
        : t(
            'Lag im Backlog, aber {count} Issues warten darauf ({issues}). Zurück in die Warteschlange. Versuch {attempt} von {max}.',
            back,
          ),
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

/** Writes the result of a landing attempt onto the issue, in the project's language. */
function applyLanding(p: any, issueId: number, outcome: Outcome) {
  forProject(p, () => writeLanding(p, issueId, outcome))
}

function writeLanding(p: any, issueId: number, outcome: Outcome) {
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
      addComment(
        issueId,
        'Watchdog',
        'watchdog',
        t('Die Landung ist mehrfach gescheitert. Bitte entscheiden, wie es weitergeht.'),
      )
    }
  }

  // 'review' here means: a pull request is open and its checks decide. Everything else ends the wait.
  // 'approval': held at a gate until the owner approves this commit (gates.ts).
  if (outcome.status !== 'review') patch.landing = outcome.gate ? 'approval' : ''
  patch.gate_sha = outcome.gate?.sha ?? ''
  patchIssue(issueId, patch)
  // A gate asks the owner, never the deputy: an agent must not approve its own landing.
  if (outcome.gate) notifyOwner(p, getIssue(issueId), outcome.note)
  else if (needsOwner) needsHuman(p, issueId, outcome.note)
}

/**
 * The owner approves a landing held at a gate. sha is the commit the owner saw; the approval
 * holds only while the branch still points there, and lets that commit land once.
 */
export async function approveLanding(issueId: number, sha: string, actor: string) {
  const issue = getIssue(issueId)
  const p = issue && getProject(issue.project_id)
  if (!p) throw new Error(t('nicht gefunden'))
  if (issue.landing !== 'approval' || !issue.gate_sha) throw new Error(t('Das Issue wartet auf keine Freigabe.'))
  if (sha !== issue.gate_sha || (await branchTip(p, issue)) !== sha) {
    throw new Error(t('Der Branch hat sich seit dem Anhalten bewegt. Bitte neu laden und den neuen Stand prüfen.'))
  }
  // The errors above answer the owner; what stays on the issue is in the project's language.
  forProject(p, () => {
    const shown = { actor, sha: sha.slice(0, 10) }
    addComment(issue.id, actor, 'system', t('Landung von Stand {sha} freigegeben.', { sha: shown.sha }))
    trace(issue.id, 'approval', t('{actor} hat Stand {sha} freigegeben (gilt einmal, nur für diesen Commit).', shown), 'warn')
  })
  patchIssue(issue.id, { approved_sha: sha, gate_sha: '', landing: '', status: 'done' }, actor)
  landByHand(issue.id)
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
  forProject(p, () =>
    landIssue(p, issue)
      .then((outcome) => {
        if (outcome.status !== 'done' || outcome.note) applyLanding(p, issueId, outcome)
        kick()
      })
      .catch((e) => console.error('landing', e)),
  )
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
    return t(
      'Zweimal derselbe Fehler auf {provider}. Der nächste Lauf nimmt einen anderen Anbieter, falls einer eingerichtet ist.',
      { provider: label },
    )
  }

  if (failure.kind === 'toolchain') {
    addLesson(
      p.id,
      t('`{missing}` war in einem Lauf nicht installiert. Vor Gebrauch prüfen und bei Bedarf installieren.', {
        missing: failure.missing ?? '',
      }),
      'Selbstheilung',
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
      'Selbstheilung',
      'watchdog',
      `${t('Lauf von {name} fehlgeschlagen: {cause}', { name: agent.name, cause: failure!.cause })}\n\n${hint}`,
    )
  } else if (failure) {
    addComment(
      issue.id,
      'System',
      'system',
      t('Lauf von {name} fehlgeschlagen: {cause}', {
        name: agent.name,
        cause: res.error ?? t('unbekannter Fehler'),
      }),
    )
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
        t('{streak} Läufe in Folge ohne Ergebnis. Issue blockiert, bitte prüfen.', { streak }),
      )
    } else {
      const delay = (failure && retryDelay(failure)) ?? 15_000 * 2 ** streak
      retryAfter.set(issue.id, Date.now() + delay)
    }
  }
  moveIssue(issue.id, { status: to })
  if (to === 'blocked') needsHuman(p, issue.id, t('Mehrere Läufe sind ohne Ergebnis geblieben.'))
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
      note: t(
        'Deine Abgabe enthält keinen <checklist>-Block. Melde zu jedem Punkt der Abnahme-Checkliste "ok" mit Nachweis oder "open" und gib erneut ab.',
      ),
      report: '',
    }
  }
  if (report?.open.length) {
    return {
      result: 'partial',
      note: t('Teilabgabe, offen: Punkt {items}.', { items: report.open.join(', ') }),
      report: block ?? '',
    }
  }
  if (!p.settings.precheck.enabled || !l.workdir) return { result: 'passed', note: '', report: block ?? '' }

  l.checking = true
  const text = t('Vorcheck läuft: Nachweise, Merge, Projektprüfung…')
  l.lastActivity = Date.now()
  emit(p.id, { t: 'activity', runId: l.runId, issueId: issue.id, text, at: l.lastActivity })
  const outcome = await precheck({
    cwd: l.workdir.cwd,
    branch: l.workdir.branch,
    base: await baseBranchOf(p),
    command:
      p.settings.precheck.commandAt === 'landing'
        ? p.settings.precheck.quickCommand
        : p.settings.precheck.command,
    timeoutMin: p.settings.precheck.timeoutMin,
    report,
  }).catch((error) => ({
    ok: true,
    note: t('Vorcheck nicht möglich, die Prüfer sehen die Arbeit trotzdem: {error}', { error: error.message }),
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
  addComment(issue.id, 'Vorcheck', 'watchdog', gate.note)
  const fails = issue.precheck_fails + 1
  if (fails >= MAX_PRECHECK_FAILS) {
    patchIssue(issue.id, { ...patch, status: 'blocked', precheck_fails: 0 })
    return needsHuman(
      p,
      issue.id,
      t('{name} scheitert {fails}-mal in Folge am Vorcheck. Zuletzt: {note}', {
        name: agent.name,
        fails,
        note: gate.note,
      }),
    )
  }
  patchIssue(issue.id, { ...patch, status: 'todo', precheck_fails: fails, assignee_id: agent.id })
}

/**
 * Checklist items are still open. The rules are in partial.ts: wait for a named issue, an interim
 * look by the first reviewer only the first time, later straight on, and a human when nothing moved.
 */
function handInPartial(
  p: any,
  issue: any,
  agent: any,
  agents: any[],
  gate: Gate,
  patch: Record<string, any>,
  text: string,
) {
  const streak = partialStreak(issue.id)
  if (streak >= MAX_PARTIALS) {
    patchIssue(issue.id, { ...patch, status: 'blocked' })
    return needsHuman(
      p,
      issue.id,
      t('{name} hat {streak} Teilabgaben in Folge geliefert, ohne die Checkliste abzuschließen. {note}', {
        name: agent.name,
        streak,
        note: gate.note,
      }),
    )
  }

  const count = issue.checklist?.length ?? 0
  const step = partialStep({
    waitsFor: namedOpenIssues(p, issue, waitingLines(text)),
    openBefore: issue.checklist_report ? (parseReport(issue.checklist_report, count)?.open ?? null) : null,
    openNow: parseReport(gate.report, count)?.open ?? [],
  })
  if (step.kind === 'wait') {
    addComment(
      issue.id,
      'System',
      'system',
      `${gate.note} ${waitsNote(p.key, step.on)}`,
    )
    return patchIssue(issue.id, {
      ...patch,
      status: 'todo',
      blocked_by: [...new Set([...issue.blocked_by, ...step.on])],
    })
  }
  if (step.kind === 'stuck') {
    patchIssue(issue.id, { ...patch, status: 'blocked' })
    return needsHuman(
      p,
      issue.id,
      t(
        '{name} hat erneut teilweise abgegeben, ohne einen weiteren Punkt zu erfüllen, und nennt kein offenes Issue, auf das es wartet. {note}',
        { name: agent.name, note: gate.note },
      ),
    )
  }
  if (step.kind === 'goOn') {
    addComment(
      issue.id,
      'System',
      'system',
      `${gate.note} ${t('Weiter mit den offenen Punkten, ohne Zwischenprüfung.')}`,
    )
    return patchIssue(issue.id, { ...patch, status: 'todo' })
  }

  const first = nextReviewer(issue, 0, agent.id, agents)
  if (first < 0) {
    addComment(issue.id, 'System', 'system', `${gate.note} ${t('Weiter mit den offenen Punkten.')}`)
    return patchIssue(issue.id, { ...patch, status: 'todo' })
  }
  const reviewer = agents.find((a) => a.id === issue.reviewers[first])
  addComment(
    issue.id,
    'System',
    'system',
    `${gate.note} ${t('Zwischenprüfung durch {name}.', { name: reviewer.name })}`,
  )
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

  addComment(issue.id, agent.name, 'agent', summary || t('(keine Zusammenfassung)'))

  if (answer.startsWith('handoff:')) {
    const name = answer.slice('handoff:'.length).trim()
    const target = agents.find((a) => a.enabled && a.name.toLowerCase() === name)
    if (target) {
      status = 'todo'
      patch.assignee_id = target.id
      addComment(
        issue.id,
        'System',
        'system',
        t('Übergabe von {from} an {to}.', { from: agent.name, to: target.name }),
      )
    }
  }

  // "Blocked, waits for SHOP-12": the issue waits for it and goes on by itself, nobody has to decide.
  if (status === 'blocked') {
    const waitsFor = namedOpenIssues(p, issue, `${summary}\n${patch.handoff}`)
    if (waitsFor.length) {
      status = 'todo'
      patch.blocked_by = [...new Set([...issue.blocked_by, ...waitsFor])]
      addComment(issue.id, 'System', 'system', waitsNote(p.key, waitsFor))
    }
  }

  if (gate) patch.checklist_report = gate.report
  if (gate && gate.result !== 'passed') {
    endRun(l, 'done', res, '', '', gate.result === 'partial' ? 'partial' : 'precheck')
    if (getIssue(issue.id)?.status !== 'in_progress')
      return void patchIssue(issue.id, { handoff: patch.handoff })
    return gate.result === 'partial'
      ? handInPartial(p, issue, agent, agents, gate, patch, `${summary}\n${patch.handoff}`)
      : sendBackFromPrecheck(p, issue, agent, gate, patch)
  }
  if (gate?.note) addComment(issue.id, 'Vorcheck', 'system', gate.note)
  if (gate) patch.precheck_fails = 0

  const isFinished = status === 'done' || status === 'review'

  // An arena entry is held for the jury instead of being reviewed or landed (arena.ts).
  if (isFinished && isOpenEntry(issue)) {
    endRun(l, 'done', res, '', '', 'arena')
    if (getIssue(issue.id)?.status === 'in_progress') holdEntry(issue.id, patch)
    return
  }

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
      addComment(issue.id, 'System', 'system', t('Zur Prüfung an {name}.', { name: reviewer.name }))
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
  if (status === 'blocked') needsHuman(p, issue.id, t('{name} kommt nicht weiter: {summary}', { name: agent.name, summary }))
  if (status === 'review' && patch.review_index === undefined) {
    needsHuman(
      p,
      issue.id,
      t('{name} ist fertig und bittet um deine Prüfung: {summary}', { name: agent.name, summary }),
    )
  }
}

/** Screenshots of the branch for owner and reviewer, see preview.ts. A failure only leaves a note. */
async function takeScreenshots(l: Live, p: any, issue: any) {
  const text = t('Vorschau wird aufgenommen…')
  emit(p.id, { t: 'activity', runId: l.runId, issueId: issue.id, text, at: Date.now() })
  l.lastActivity = Date.now()
  try {
    const files = await capturePreview({
      issueId: issue.id,
      runId: l.runId,
      cwd: l.workdir!.cwd,
      settings: p.settings.preview,
    })
    addComment(issue.id, 'System', 'system', t('Vorschau aufgenommen ({count} Screenshots).', { count: files.length }))
    emit(p.id, { t: 'shots', issueId: issue.id })
  } catch (error: any) {
    addComment(issue.id, 'System', 'system', t('Vorschau nicht möglich: {error}', { error: error.message }))
  }
}

/** Optional check by the watchdog's own LLM prompt before the issue leaves "in progress". */
async function watchdogRejects(l: Live, p: any, issue: any, summary: string) {
  const { enabled, llm } = p.settings.watchdog
  if (!enabled || !llm.enabled || !PROVIDERS[llm.provider]) return false

  emit(p.id, { t: 'activity', runId: l.runId, issueId: issue.id, text: t('Watchdog prüft das Ergebnis…') })
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
    addComment(issue.id, 'Watchdog', 'system', t('Prüfung nicht möglich: {error}', { error: verdict.error ?? '' }))
    return false
  }
  if (!/^\s*FAIL/i.test(verdict.text)) return false
  addComment(issue.id, 'Watchdog', 'watchdog', verdict.text.trim())
  return true
}

/**
 * The reviewer's verdict from its status block. A reviewer that forgot the block but started its
 * summary the way the ADHD format asks ("Passt:", "Ändern:", in English "Approved:", "Changes:") has still said what it means.
 */
function reviewVerdict(text: string, summary: string) {
  const stated = (tag(text, 'status') ?? '').toLowerCase().trim()
  if (stated) return stated
  if (/^\s*(passt|fine|approved?)\s*:/i.test(summary)) return 'approve'
  if (/^\s*(ändern|changes?)\s*:/i.test(summary)) return 'changes'
  return ''
}

async function finishReview(l: Live, p: any, issue: any, reviewer: any, res: RunResult) {
  const agents = all('SELECT * FROM agents WHERE project_id=?', p.id).map(mapAgent)
  const maker = agents.find((a) => a.id === issue.maker_id)
  const summary = tag(res.text, 'summary') ?? res.text.replace(/<status>[\s\S]*?<\/status>/gi, '').trim()
  const verdict = reviewVerdict(res.text, summary)
  const backToMaker = { review_index: -1, assignee_id: maker?.id ?? null }

  addComment(issue.id, reviewer.name, 'review', summary || t('(keine Begründung)'))
  endRun(l, 'done', res, '', '', ['approve', 'changes'].includes(verdict) ? verdict : 'blocked')

  if (issue.review_interim && verdict === 'approve') {
    addComment(
      issue.id,
      'System',
      'system',
      t('{name} hat den Zwischenstand freigegeben. Weiter mit den offenen Punkten.', { name: reviewer.name }),
    )
    return moveIssue(issue.id, { status: 'todo', review_interim: 0, ...backToMaker })
  }

  if (verdict === 'approve') {
    const next = nextReviewer(issue, issue.review_index + 1, issue.maker_id, agents)
    if (next >= 0) {
      const following = agents.find((a) => a.id === issue.reviewers[next])
      addComment(
        issue.id,
        'System',
        'system',
        t('{name} hat freigegeben. Weiter an {next}.', { name: reviewer.name, next: following.name }),
      )
      return moveIssue(issue.id, { status: 'review', review_index: next, assignee_id: following.id })
    }
    addComment(issue.id, 'System', 'system', t('{name} hat freigegeben.', { name: reviewer.name }))
    return landAndClose(p, issue)
  }

  if (verdict === 'changes') {
    const rounds = issue.review_rounds + 1
    if (rounds >= p.settings.maxReviewRounds) {
      addComment(
        issue.id,
        'Watchdog',
        'watchdog',
        t('{rounds} Änderungsrunden ohne Freigabe. Bitte entscheiden, wie es weitergeht.', { rounds }),
      )
      moveIssue(issue.id, { status: 'blocked', review_rounds: 0, review_interim: 0, ...backToMaker })
      return needsHuman(
        p,
        issue.id,
        t('{rounds} Änderungsrunden ohne Freigabe. Letzter Einwand: {summary}', { rounds, summary }),
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
  needsHuman(p, issue.id, t('{name} braucht deine Entscheidung: {summary}', { name: reviewer.name, summary }))
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

// ---------- arena ----------

/** True for an entry whose arena is still undecided. The winner goes its normal way again. */
function isOpenEntry(issue: any) {
  if (!issue.arena_of) return false
  const parent = getIssue(issue.arena_of)
  return !!parent && parent.arena_winner === 0
}

const JURY_TRIES = 3
const JURY_RETRY_MS = 5 * 60_000
/** Originals whose jury is deciding right now, and when a jury that failed may try again. */
const judging = new Set<number>()
const juryFails = new Map<number, { count: number; retryAt: number }>()

/** Moves every open arena of the project one step: judge, close the original, or dissolve. */
function settleArenas(p: any) {
  for (const parentId of openArenas(p.id)) {
    const arena = arenaOf({ id: parentId })
    if (!arena || arena.winnerId < 0) continue
    if (arena.winnerId) {
      const winner = arena.entries.find((entry) => entry.id === arena.winnerId)
      if (!winner) dissolveArena(parentId)
      else if (winner.status === 'done') {
        patchIssue(parentId, { status: 'done' })
        addComment(
          parentId,
          'Arena',
          'system',
          t('Erledigt durch den Gewinner-Beitrag #{number}.', { number: winner.number }),
        )
      }
      continue
    }
    if (arena.phase === 'empty') dissolveArena(parentId)
    if (arena.phase !== 'judge' || judging.has(parentId)) continue
    const retryAt = juryFails.get(parentId)?.retryAt ?? 0
    if (retryAt > Date.now()) {
      if (Number.isFinite(retryAt)) wakeAt(retryAt)
      continue
    }
    judging.add(parentId)
    judgeArena(p, arena)
      .catch((error) => console.error('arena', error))
      .finally(() => {
        judging.delete(parentId)
        kick()
      })
  }
}

/** The provider that judges: the deputy's, otherwise the one of the first entry's agent. */
function juryProvider(p: any, arena: ArenaView) {
  const deputy = deputyOf(p)
  if (deputy && PROVIDERS[deputy.provider]) return deputy.provider
  return getAgent(arena.entries[0].agentId ?? 0)?.provider ?? ''
}

async function judgeArena(p: any, arena: ArenaView) {
  const parent = getIssue(arena.parent.id)
  const handedIn = arena.entries.filter((entry) => entry.state === 'handed-in')
  if (!parent || !handedIn.length) return
  if (handedIn.length === 1)
    return pickArenaWinner(parent.id, handedIn[0].id, t('Als einziger Beitrag abgegeben.'), t('Die Arena'))

  const entries = await Promise.all(
    labelled(handedIn).map(async ({ label, entry }) => ({
      label,
      entryId: entry.id,
      costUsd: entry.costUsd,
      summary:
        get("SELECT body FROM comments WHERE issue_id=? AND kind='agent' ORDER BY id DESC LIMIT 1", entry.id)
          ?.body ?? '',
      files: await issueChanges(p, entry.number).then(
        (changes) => changes.files,
        () => [],
      ),
    })),
  )
  const provider = juryProvider(p, arena)
  const repo = p.repo_path || join(DATA_DIR, 'workspaces', p.key)
  const started = Date.now()
  const verdict = PROVIDERS[provider]
    ? await oneShot(provider, juryPrompt(parent, entries), existsSync(repo) ? repo : '.')
    : failed(t('kein Anbieter für die Jury'))
  run(
    `INSERT INTO runs (project_id, issue_id, agent_id, agent_name, provider, kind, status, started_at, ended_at,
       input_tokens, output_tokens, cost_usd, verdict)
     VALUES (?,?,NULL,'Jury',?,'review',?,?,?,?,?,?,'arena')`,
    p.id,
    parent.id,
    provider || 'none',
    verdict.ok ? 'done' : 'failed',
    started,
    Date.now(),
    verdict.usage.input,
    verdict.usage.output,
    verdict.usage.cost,
  )

  const choice = verdict.ok
    ? parseVerdict(
        verdict.text,
        entries.map((entry) => entry.label),
      )
    : undefined
  if (choice) {
    const winner = entries.find((entry) => entry.label === choice.label)!
    return pickArenaWinner(parent.id, winner.entryId, choice.reason, t('Die Jury'))
  }

  const fails = (juryFails.get(parent.id)?.count ?? 0) + 1
  if (fails < JURY_TRIES) {
    juryFails.set(parent.id, { count: fails, retryAt: Date.now() + JURY_RETRY_MS })
    if (fails === 1)
      addComment(
        parent.id,
        'Arena',
        'system',
        t('Die Jury kam zu keiner Entscheidung ({error}). Neuer Versuch in fünf Minuten.', {
          error: verdict.error || t('Antwort nicht lesbar'),
        }),
      )
    return
  }
  // Nothing may stay stuck in an autonomous project: the first entry in line wins, and it says so.
  if (p.settings.autonomous) {
    return pickArenaWinner(
      parent.id,
      handedIn[0].id,
      t('Die Jury war nicht erreichbar; der erste abgegebene Beitrag wurde genommen.'),
      t('Die Arena'),
    )
  }
  juryFails.set(parent.id, { count: fails, retryAt: Infinity })
  const note = t('Die Jury konnte die Arena nicht entscheiden. Bitte im Issue einen Beitrag wählen.')
  addComment(parent.id, 'Arena', 'system', note)
  notifyOwner(p, parent, note)
}

/**
 * Decides an arena, by the jury or by the owner: the other entries stop, the winner goes on to its
 * reviewers, or lands at once when it has none.
 */
export function pickArenaWinner(parentId: number, entryId: number, reason: string, by: string) {
  const arena = arenaOf({ id: parentId })
  if (!arena) throw new Error(t('Für dieses Issue gibt es keine Arena.'))
  // The owner may decide in another language than the one the project's issues are written in.
  forProject(getProject(getIssue(parentId)?.project_id), () => decideArena(arena, parentId, entryId, reason, by))
}

function decideArena(arena: ArenaView, parentId: number, entryId: number, reason: string, by: string) {
  const { winner } = closeArena(parentId, entryId, reason, by)
  juryFails.delete(parentId)
  for (const entry of arena.entries)
    if (entry.id !== entryId)
      stopIssueRun(entry.id, t('Die Arena ist entschieden, der Lauf wurde gestoppt.'), 'done', 'Arena')

  const p = getProject(winner.project_id)
  const agents = all('SELECT * FROM agents WHERE project_id=?', p.id).map(mapAgent)
  const first = nextReviewer(winner, 0, winner.maker_id, agents)
  if (first >= 0) {
    const reviewer = agents.find((agent) => agent.id === winner.reviewers[first])
    patchIssue(winner.id, { status: 'review', review_index: first, assignee_id: reviewer.id, landing: '' })
    addComment(winner.id, 'System', 'system', t('Zur Prüfung an {name}.', { name: reviewer.name }))
  } else {
    // "In progress" is the state a finished issue has while its branch lands.
    patchIssue(winner.id, { status: 'in_progress', landing: '' })
    landAndClose(p, getIssue(winner.id))
      .then(kick)
      .catch((error) => console.error('landing', error))
  }
  kick()
}

// ---------- scheduler ----------

function tick() {
  for (const row of all('SELECT id FROM projects WHERE paused=0')) {
    // Everything a pass writes or starts belongs to this project, so it runs in its language.
    const p = getProject(row.id)
    forProject(p, () => scheduleProject(p))
  }
}

function scheduleProject(p: any) {
  // A parked issue comes back at its time without any event, so the scheduler wakes for it.
  const parked = get(
    "SELECT MIN(parked_until) AS at FROM issues WHERE project_id=? AND status='backlog' AND parked_until>?",
    p.id,
    Date.now(),
  )?.at
  if (parked) wakeAt(parked)
  settleArenas(p)
  const running = [...live.values()].filter((l) => l.projectId === p.id)
  let slots = p.settings.maxConcurrent - running.length
  if (p.settings.autonomous && slots > 0) pullFromBacklog(p, slots)

  // Waiting work: issues to do, and issues queued for a reviewer agent. Only the front of the
  // queue matters; the full issue is loaded when a run actually starts.
  const queue = all(
    `SELECT id, number, priority, assignee_id, blocked_by, review_index, model FROM issues
     WHERE project_id=? AND (status='todo' OR (status='review' AND review_index>=0))
     ORDER BY priority DESC, rank, id LIMIT 500`,
    p.id,
  ).map(mapIssue)
  if (!queue.length) {
    if (!running.length && !p.settings.autonomous) openNextGroup(p)
    setWaiting(p.id, landingReasons(p.id))
    return setNotice(p.id, '')
  }
  const landingNumbers = new Set(
    [...landings.values()].filter((l) => l.projectId === p.id).map((l) => l.number),
  )

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
  if (paced && big.size && agents.some((agent) => paceFor(providerOrder(p.settings, agent)[0]) === 'spend')) {
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
      // Approved blockers only need to land: say so, so nobody has to look why it still waits.
      if (blockers.every((number: number) => landingNumbers.has(number)))
        wait(issue, 'merge', t('Wartet auf Merge von {issues}', { issues: issueList(p.key, blockers) }))
      else wait(issue, 'blocked', t('Wartet auf {issues}', { issues: issueList(p.key, blockers) }))
      continue
    }
    const retryAt = retryAfter.get(issue.id) ?? 0
    if (retryAt > Date.now()) {
      wait(
        issue,
        'retry',
        t('Neuer Versuch ab {when}, der letzte Lauf ist fehlgeschlagen', { when: when(retryAt) }),
      )
      wakeAt(retryAt)
      continue
    }

    const agent = issue.assignee_id ? agents.find((a) => a.id === issue.assignee_id) : agents.find(isFree)
    if (!agent) {
      wait(
        issue,
        'agent',
        issue.assignee_id ? t('Der zugewiesene Agent existiert nicht mehr') : t('Kein Agent frei'),
      )
      continue
    }
    if (!agent.enabled) {
      wait(issue, 'agent', t('{name} ist ausgeschaltet', { name: agent.name }))
      continue
    }
    if (!isFree(agent)) {
      wait(
        issue,
        'agent',
        t('{name} arbeitet schon an {busy} von höchstens {max} Issues', {
          name: agent.name,
          busy: busy(agent),
          max: agent.max_instances,
        }),
      )
      continue
    }
    if (slots <= 0) {
      wait(
        issue,
        'full',
        t('Projekt-Limit erreicht: {max} Läufe gleichzeitig', { max: p.settings.maxConcurrent }),
      )
      continue
    }

    const kind = issue.review_index >= 0 ? 'review' : 'work'
    const { pick, skipped } = routeProvider(p, agent, avoidProvider.get(issue.id), kind, issue.model)
    if (!pick) {
      exhausted = true
      wait(issue, 'provider', t('Kein Anbieter verfügbar. {skipped}', { skipped: skipped.join(' · ') }))
      continue
    }
    const full = getIssue(issue.id)
    // The cap may have been lowered since the last run, so it is checked before every start too.
    if (parkIfOverCap(p, full)) continue
    avoidProvider.delete(issue.id)
    start(p, full, agent, agents, pick, skipped)
    startedNow.push(agent.id)
    startedOn.push(pick.provider)
    slots--
  }

  // A resting provider takes runs again on its own, so the scheduler comes back then.
  if (exhausted)
    for (const provider of Object.keys(PROVIDERS)) {
      const rest = restOf(provider)
      if (rest) wakeAt(rest.until)
    }
  setWaiting(p.id, { ...reasons, ...landingReasons(p.id) })
  setNotice(p.id, exhausted ? exhaustedNotice(agents) : '')
}

/** Approved issues on their way into the base branch: their place in line, or the running test. */
function landingReasons(projectId: number): Record<number, Reason> {
  const reasons: Record<number, Reason> = {}
  let place = 0
  for (const [issueId, landing] of landings) {
    if (landing.projectId !== projectId) continue
    const minutes = Math.floor((Date.now() - landing.since) / 60_000)
    reasons[issueId] =
      landing.step === 'testing'
        ? { kind: 'landing', text: t('Freigegeben, Landung läuft (Merge und Test, seit {minutes} min)', { minutes }) }
        : {
            kind: 'landing',
            text: t('Freigegeben, wartet auf Landung: Platz {place} in der Schlange', { place: ++place }),
          }
  }
  return reasons
}

export type Reason = {
  kind: 'blocked' | 'merge' | 'landing' | 'retry' | 'agent' | 'full' | 'provider' | 'saving'
  text: string
}

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
  return numbers.length > 3
    ? t('{issues} und {count} weitere', { issues: shown.join(', '), count: numbers.length - 3 })
    : shown.join(', ')
}

const waitsNote = (key: string, numbers: number[]) =>
  t('Wartet jetzt auf {issues} und geht von selbst weiter, sobald das erledigt ist.', {
    issues: issueList(key, numbers),
  })

function exhaustedNotice(agents: any[]) {
  const resting = [...new Set(agents.map((a) => a.provider))]
    .map((provider) => ({ provider, rest: restOf(provider) }))
    .filter((r) => r.rest)
    .map((r) =>
      t('{provider}: {reason} bis {when}', {
        provider: PROVIDERS[r.provider]?.label ?? r.provider,
        reason: r.rest!.reason,
        when: when(r.rest!.until),
      }),
    )
  if (resting.length) return t('Agenten pausieren. {providers}.', { providers: resting.join(', ') })
  return t('Usage-Limit erreicht: kein Provider liegt über seiner Schwelle. Agenten pausieren.')
}

/** Fill free slots with eligible work. A parked-only group must not stall an autonomous project. */
function pullFromBacklog(p: any, slots: number) {
  const issues = all(
    `SELECT id, number, status, grp, blocked_by, capped, parked_until, review_index FROM issues
     WHERE project_id=? AND status!='done' ORDER BY priority DESC, rank, id`,
    p.id,
  ).map(mapIssue)
  const pulled = readyBacklog(issues, slots, p.settings.openGroupsInOrder)
  for (const issue of pulled) patchIssue(issue.id, { status: 'todo' })
  if (pulled.length) console.log(`${p.key}: pulled from backlog: ${pulled.map((i) => `${p.key}-${i.number}`).join(', ')}`)
}

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
    "SELECT id FROM issues WHERE project_id=? AND status='backlog' AND grp=? AND capped=0 AND parked_until<=?",
    p.id,
    next,
    Date.now(),
  )
  if (!waiting.length) return
  for (const issue of waiting) patchIssue(issue.id, { status: 'todo' })
  console.log(`${p.key}: nothing left to work on, group "${next}" opened (${waiting.length} issues)`)
  kick()
}

// ---------- watchdog ----------

// The watchdog wakes when the first rule of a live run can fire, not on a fixed beat. Activity
// only pushes a stall deadline back, so an early wake-up finds nothing and sets the next one.
// It never sleeps longer than this, so changed rules take effect without an event.
const WATCHDOG_MAX_SLEEP_MS = 60_000
let watchdogTimer: ReturnType<typeof setTimeout> | undefined

function armWatchdog() {
  clearTimeout(watchdogTimer)
  watchdogTimer = undefined
  if (!live.size) return
  const now = Date.now()
  let next = now + WATCHDOG_MAX_SLEEP_MS
  for (const l of live.values()) {
    const settings = getProject(l.projectId)?.settings.watchdog
    if (!settings?.enabled || l.stop || l.checking) continue
    for (const rule of settings.rules) {
      if (rule.action === 'comment' && l.warned.has(rule.type)) continue
      const from = rule.type === 'stall' ? l.lastActivity : rule.type === 'runtime' ? l.startedAt : null
      if (from !== null) next = Math.min(next, from + rule.value * 60_000)
    }
  }
  // A little late rather than early: a deadline met by a millisecond fires on this wake-up.
  watchdogTimer = setTimeout(
    () => {
      try {
        watchdog()
      } catch (e) {
        console.error('watchdog', e)
      }
      armWatchdog()
    },
    Math.max(1_000, next - now + 50),
  )
  watchdogTimer.unref()
}

function watchdog() {
  const now = Date.now()
  for (const l of [...live.values()]) {
    const p = getProject(l.projectId)
    const settings = p?.settings.watchdog
    if (!settings?.enabled || l.stop || l.checking) continue
    forProject(p, () => applyRules(l, settings.rules, now))
  }
}

function applyRules(l: Live, rules: any[], now: number) {
  for (const rule of rules) {
    const minutes =
      rule.type === 'stall'
        ? (now - l.lastActivity) / 60_000
        : rule.type === 'runtime'
          ? (now - l.startedAt) / 60_000
          : -1
    if (minutes < rule.value) continue

    const message =
      rule.type === 'stall'
        ? t('Keine Aktivität seit {minutes} Minuten.', { minutes: rule.value })
        : t('Lauf dauert länger als {minutes} Minuten.', { minutes: rule.value })
    if (rule.action === 'comment') {
      if (!l.warned.has(rule.type)) addComment(l.issueId, 'Watchdog', 'watchdog', message)
      l.warned.add(rule.type)
    } else {
      stopRun(l.runId, `${message} ${t('Lauf gestoppt.')}`, rule.action === 'block' ? 'blocked' : 'todo')
      return
    }
  }
}

// Many things ask for a scheduling pass (every edit, every finished run). Under load they arrive
// in bursts, so passes are spaced out instead of running once per request.
const MIN_TICK_GAP_MS = 40
let pending = false
let lastTick = 0

// Between kicks the scheduler sleeps until a waiting issue can start on its own (a retry time, a
// provider's rest running out). Time-based changes nobody announces, like a quota window that
// reset, are caught by a slow safety pass.
const SAFETY_PASS_MS = 60_000
let wakeTimer: ReturnType<typeof setTimeout> | undefined
let nextWake = Infinity
const wakeAt = (at: number) => void (nextWake = Math.min(nextWake, at))

function armWake() {
  clearTimeout(wakeTimer)
  wakeTimer = setTimeout(kick, Math.max(MIN_TICK_GAP_MS, nextWake - Date.now()))
  wakeTimer.unref()
}

export function kick() {
  if (pending) return
  pending = true
  const wait = Math.max(0, lastTick + MIN_TICK_GAP_MS - Date.now())
  setTimeout(() => {
    pending = false
    lastTick = Date.now()
    nextWake = lastTick + SAFETY_PASS_MS
    try {
      tick()
    } catch (e) {
      console.error('tick', e)
    } finally {
      armWake()
      armWatchdog()
    }
  }, wait)
}

/** Every this many sweeps, all autonomous projects are swept, changed or not. */
const FULL_SWEEP_EVERY = 20

export function startEngine() {
  whenProviderWakes(kick)
  onLandingsChange(() => kick())
  let sweeps = 0
  setInterval(() => {
    try {
      sweepWaitingIssues(sweeps++ % FULL_SWEEP_EVERY === 0)
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
