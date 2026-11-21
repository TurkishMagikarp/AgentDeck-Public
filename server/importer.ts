// Takes over a project from another tracker: issues keep their numbers, dates and comments.
// Unlike a blueprint this never starts anything, the imported project is always paused.
import {
  defaultSettings,
  EFFORTS,
  forgetBoards,
  mergeSettings,
  MODEL_RE,
  PROVIDERS,
  STATUSES,
} from './core.ts'
import { get, run, tx } from './db.ts'
import { CONNECTIONS } from './mcp.ts'
import { createRoutine } from './routines.ts'

const text = (value: unknown, max = 60_000) => String(value ?? '').slice(0, max)
const time = (value: unknown) => new Date(String(value ?? '')).getTime() || Date.now()

export function importProject(data: any) {
  const key = text(data?.project?.key, 8).toUpperCase()
  if (!/^[A-Z][A-Z0-9]{1,7}$/.test(key)) throw new Error('project.key: 2-8 characters, A-Z/0-9')
  if (get('SELECT 1 FROM projects WHERE key=?', key)) throw new Error(`Project ${key} already exists`)

  return tx(() => {
    const project = data.project
    const settings = mergeSettings({ ...defaultSettings(), ...(project.settings ?? {}) })
    const projectId = Number(
      run(
        `INSERT INTO projects (key, name, description, repo_path, settings, paused, created_at)
         VALUES (?,?,?,?,?,1,?)`,
        key,
        text(project.name || key, 120),
        text(project.description, 4000),
        text(project.repo_path, 500),
        JSON.stringify(settings),
        Date.now(),
      ).lastInsertRowid,
    )

    const agentIds = new Map<string, number>()
    for (const agent of data.agents ?? []) {
      if (!PROVIDERS[agent.provider])
        throw new Error(`Agent ${agent.name}: unknown provider "${agent.provider}"`)
      const model = text(agent.model, 80)
      if (!MODEL_RE.test(model)) throw new Error(`Agent ${agent.name}: invalid model name`)
      const inserted = run(
        `INSERT INTO agents (project_id, name, role, provider, model, instructions, max_instances, effort, mcp_ids)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        projectId,
        text(agent.name, 80),
        text(agent.role, 200),
        agent.provider,
        model,
        text(agent.instructions),
        Math.max(1, Math.min(20, Number(agent.max_instances) || 1)),
        EFFORTS.includes(agent.effort) ? agent.effort : '',
        JSON.stringify((agent.mcp ?? []).filter((id: string) => CONNECTIONS[id])),
      )
      agentIds.set(agent.name, Number(inserted.lastInsertRowid))
    }
    const agentId = (name: unknown) => agentIds.get(String(name ?? '')) ?? null

    let highest = 0
    let comments = 0
    for (const issue of data.issues ?? []) {
      const number = Math.floor(Number(issue.number))
      if (!(number > 0)) throw new Error(`Issue without a valid number: ${text(issue.title, 60)}`)
      highest = Math.max(highest, number)

      const created = time(issue.created_at)
      const reviewers = (issue.reviewers ?? []).map(agentId).filter(Boolean)
      // Waiting for a reviewer only makes sense while that reviewer exists; otherwise a human looks.
      const reviewIndex =
        issue.status === 'review' && reviewers[issue.review_index] === agentId(issue.assignee)
          ? Number(issue.review_index)
          : -1
      const issueId = Number(
        run(
          `INSERT INTO issues (project_id, number, title, description, status, priority, assignee_id, maker_id,
             review_index, rank, blocked_by, reviewers, grp, model, created_at, updated_at, done_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          projectId,
          number,
          text(issue.title, 300) || `Issue ${number}`,
          text(issue.description),
          STATUSES.includes(issue.status) && issue.status !== 'in_progress' ? issue.status : 'todo',
          Math.max(0, Math.min(3, Number(issue.priority ?? 1))),
          agentId(issue.assignee),
          agentId(issue.maker ?? issue.assignee),
          reviewIndex,
          created,
          JSON.stringify((issue.blocked_by ?? []).map(Number).filter(Boolean)),
          JSON.stringify(reviewers),
          text(issue.group, 80),
          MODEL_RE.test(text(issue.model, 80)) ? text(issue.model, 80) : '',
          created,
          time(issue.updated_at ?? issue.created_at),
          issue.status === 'done' ? time(issue.updated_at ?? issue.created_at) : null,
        ).lastInsertRowid,
      )

      for (const comment of issue.comments ?? []) {
        run(
          'INSERT INTO comments (issue_id, author, kind, body, created_at) VALUES (?,?,?,?,?)',
          issueId,
          text(comment.author || 'Unknown', 60),
          ['comment', 'agent', 'review', 'system'].includes(comment.kind) ? comment.kind : 'comment',
          text(comment.body),
          time(comment.created_at),
        )
        comments++
      }
    }
    run('UPDATE projects SET next_number=? WHERE id=?', highest + 1, projectId)

    for (const routine of data.routines ?? []) {
      createRoutine(projectId, { ...routine, agent_id: agentId(routine.agent) })
    }

    forgetBoards(projectId)
    return {
      projectId,
      key,
      agents: agentIds.size,
      issues: (data.issues ?? []).length,
      comments,
      routines: (data.routines ?? []).length,
    }
  })
}
