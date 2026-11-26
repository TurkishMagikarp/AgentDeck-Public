import { get, run, tx } from './db.ts'
import { CONNECTIONS } from './mcp.ts'
import { createRoutine } from './routines.ts'
import {
  createIssue,
  defaultSettings,
  mergeSettings,
  MODEL_RE,
  PROVIDERS,
  STATUSES,
  touch,
  forgetBoards,
  EFFORTS,
} from './core.ts'
import { t } from './i18n.ts'
import { en as english } from './prompts/en.ts'
import { prompts } from './prompts/index.ts'

const lists = () => ({
  providers: Object.keys(PROVIDERS).join(' | '),
  connections: Object.keys(CONNECTIONS).join(' | '),
  statuses: STATUSES.join(' | '),
})

/** The blueprint format, explained in the language of whoever asks for it. */
export const blueprintGuide = () => prompts().blueprintGuide(lists())

/** The English guide, for callers that hold it as a constant. */
export const BLUEPRINT_GUIDE = english.blueprintGuide(lists())

/** The question to a model that turns a plain wish into a blueprint. */
export const blueprintRequest = (wish: string) => prompts().blueprintRequest(blueprintGuide(), wish)

const str = (v: any, max = 20000) => String(v ?? '').slice(0, max)

/** Issues are cached as they are created; if the transaction rolls back the cache must go too. */
function transaction<T>(work: () => T): T {
  try {
    return tx(work)
  } catch (err) {
    forgetBoards()
    throw err
  }
}

export function applyBlueprint(bp: any) {
  const pj = bp?.project
  if (!pj || typeof pj !== 'object') throw new Error(t('blueprint.project fehlt'))
  const key = str(pj.key, 8).toUpperCase()
  if (!/^[A-Z][A-Z0-9]{1,7}$/.test(key))
    throw new Error(t('project.key: 2-8 Zeichen, A-Z/0-9, beginnt mit Buchstabe'))

  return transaction(() => {
    let p = get('SELECT * FROM projects WHERE key=?', key)
    const created = !p
    if (!p) {
      const settings = mergeSettings({ ...defaultSettings(), ...(pj.settings ?? {}) })
      const r = run(
        'INSERT INTO projects (key, name, description, repo_path, settings, paused, created_at) VALUES (?,?,?,?,?,?,?)',
        key,
        str(pj.name || key, 120),
        str(pj.description, 4000),
        str(pj.repo_path, 500),
        JSON.stringify(settings),
        pj.paused ? 1 : 0,
        Date.now(),
      )
      p = { id: Number(r.lastInsertRowid) }
      // Lets a project continue the numbering of an earlier tracker.
      const firstNumber = Math.floor(Number(pj.first_issue_number))
      if (firstNumber > 1) run('UPDATE projects SET next_number=? WHERE id=?', firstNumber, p.id)
    } else if (pj.settings) {
      run(
        'UPDATE projects SET settings=? WHERE id=?',
        JSON.stringify(mergeSettings({ ...JSON.parse(p.settings), ...pj.settings })),
        p.id,
      )
    }
    const pid = p.id as number

    const skillId = new Map<string, number>()
    for (const s of bp.skills ?? []) {
      const name = str(s.name, 80)
      if (!name) continue
      const ex = get('SELECT id FROM skills WHERE project_id=? AND name=?', pid, name)
      if (ex)
        run(
          'UPDATE skills SET description=?, content=? WHERE id=?',
          str(s.description, 400),
          str(s.content),
          ex.id,
        )
      const id =
        ex?.id ??
        Number(
          run(
            'INSERT INTO skills (project_id, name, description, content) VALUES (?,?,?,?)',
            pid,
            name,
            str(s.description, 400),
            str(s.content),
          ).lastInsertRowid,
        )
      skillId.set(name, id)
    }

    const agentId = new Map<string, number>()
    for (const a of bp.agents ?? []) {
      const name = str(a.name, 80)
      if (!name) continue
      if (!PROVIDERS[a.provider]) throw new Error(t('Agent {name}: unbekannter Provider "{provider}"', { name, provider: String(a.provider) }))
      const model = str(a.model, 80)
      if (!MODEL_RE.test(model)) throw new Error(t('Agent {name}: ungültiger Modellname', { name }))
      const skills = JSON.stringify(
        (a.skills ?? [])
          .map(
            (n: string) =>
              skillId.get(n) ?? get('SELECT id FROM skills WHERE project_id=? AND name=?', pid, n)?.id,
          )
          .filter(Boolean),
      )
      const max = Math.max(1, Math.min(20, Number(a.max_instances) || 1))
      const ex = get('SELECT id, provider_override FROM agents WHERE project_id=? AND name=?', pid, name)
      const override = typeof a.provider_override === 'boolean' ? Number(a.provider_override) : ex?.provider_override ?? 0
      if (ex)
        run(
          'UPDATE agents SET role=?, provider=?, model=?, instructions=?, skill_ids=?, max_instances=?, provider_override=? WHERE id=?',
          str(a.role, 200),
          a.provider,
          model,
          str(a.instructions),
          skills,
          max,
          override,
          ex.id,
        )
      const id =
        ex?.id ??
        Number(
          run(
            'INSERT INTO agents (project_id, name, role, provider, model, instructions, skill_ids, max_instances, provider_override) VALUES (?,?,?,?,?,?,?,?,?)',
            pid,
            name,
            str(a.role, 200),
            a.provider,
            model,
            str(a.instructions),
            skills,
            max,
            override,
          ).lastInsertRowid,
        )
      if (Array.isArray(a.mcp)) {
        const mcpIds = a.mcp.filter((connection: string) => CONNECTIONS[connection])
        run('UPDATE agents SET mcp_ids=? WHERE id=?', JSON.stringify(mcpIds), id)
      }
      if (typeof a.effort === 'string' && EFFORTS.includes(a.effort)) {
        run('UPDATE agents SET effort=? WHERE id=?', a.effort, id)
      }
      agentId.set(name, id)
    }

    const agentByName = (name: string) =>
      agentId.get(name) ?? get('SELECT id FROM agents WHERE project_id=? AND name=?', pid, name)?.id ?? null

    const numbers: number[] = []
    for (const i of bp.issues ?? []) {
      const title = str(i.title, 300)
      if (!title) {
        numbers.push(0)
        continue
      }
      const assignee = i.assignee
        ? (agentId.get(i.assignee) ??
          get('SELECT id FROM agents WHERE project_id=? AND name=?', pid, i.assignee)?.id ??
          null)
        : null
      const issue = createIssue(pid, {
        title,
        description: str(i.description),
        status: i.status,
        priority: Math.max(0, Math.min(3, Number(i.priority ?? 1))),
        assignee_id: assignee,
        blocked_by: (i.blocked_by ?? []).map((n: number) => numbers[n - 1]).filter(Boolean),
        reviewers: (i.reviewers ?? []).map(agentByName).filter(Boolean),
        grp: str(i.group, 80),
      })
      numbers.push(issue.number)
    }
    for (const routine of bp.routines ?? []) {
      const exists = get('SELECT 1 FROM routines WHERE project_id=? AND name=?', pid, str(routine.name, 120))
      if (!exists) createRoutine(pid, { ...routine, agent_id: agentByName(routine.agent) })
    }

    touch(pid)
    return {
      projectId: pid,
      key,
      created,
      skills: skillId.size,
      agents: agentId.size,
      issues: numbers.filter(Boolean).length,
    }
  })
}

export function extractJson(text: string) {
  const a = text.indexOf('{')
  const b = text.lastIndexOf('}')
  if (a < 0 || b <= a) throw new Error(t('Die KI hat kein JSON geliefert'))
  return JSON.parse(text.slice(a, b + 1))
}
