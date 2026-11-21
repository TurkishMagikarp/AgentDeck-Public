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

export const BLUEPRINT_GUIDE = `A blueprint is one JSON object that sets up (or extends) a complete AgentDeck project:

{
  "project": {
    "key": "SHOP",                  // 2-8 uppercase letters, issue prefix. An existing key extends that project.
    "name": "Webshop",
    "description": "One paragraph of context every agent receives.",
    "repo_path": "",                // absolute path of a git repo on the server; "" = managed workspace
    "paused": false,                // true: nothing starts until a human presses "Resume"
    "first_issue_number": 1,        // optional, to continue the numbering of an earlier tracker
    "settings": { "maxConcurrent": 3 }   // optional, see "settings"
  },
  "skills": [                       // reusable know-how, injected into the prompt of agents that list it
    { "name": "testing", "description": "How we test", "content": "Markdown instructions..." }
  ],
  "agents": [
    {
      "name": "Backend-Dev",        // unique per project, used for assignment and handoffs
      "role": "Senior backend engineer",
      "provider": "anthropic",      // ${Object.keys(PROVIDERS).join(' | ')}
      "model": "",                  // "" = CLI default
      "instructions": "How this agent should work.",
      "skills": ["testing"],        // skill names
      "mcp": ["github"],            // optional MCP connections: ${Object.keys(CONNECTIONS).join(' | ')}
      "effort": "",                 // optional reasoning effort: low | medium | high | xhigh | max
      "max_instances": 1            // how many copies of this agent may run in parallel
    }
  ],
  "issues": [
    {
      "title": "Set up project skeleton",
      "description": "Concrete task with acceptance criteria.",
      "status": "todo",             // ${STATUSES.join(' | ')}; agents only pick up "todo"
      "priority": 2,                // 0 low, 1 normal, 2 high, 3 urgent
      "assignee": "Backend-Dev",    // agent name, omit to let any free agent take it
      "reviewers": ["Reviewer"],    // optional: agents that must approve in this order before "done"
      "group": "Milestone 1",       // optional label to group issues on the board
      "blocked_by": [1]             // 1-based positions in THIS issues array that must be done first
    }
  ]
}

"routines" (optional, next to "issues"): [
  { "name": "Daily report", "agent": "Lead", "schedule": "daily", "at": "07:00", "prompt": "What to do each time" },
  { "name": "Check CI", "agent": "QA", "schedule": "interval", "every_minutes": 120, "prompt": "..." }
]

settings (all optional): {
  "maxConcurrent": 3,
  "workspace": "issue",             // "issue": worktree per issue. "agent": one checkout per agent, keeps build caches
  "maxReviewRounds": 3,             // change requests before a human has to decide
  "fallbackEnabled": true,
  "fallback": ["anthropic", "openai", "deepseek"],          // routing order when the agent's own provider is below its threshold
  "budgets": { "openai": { "limit": 5000000, "unit": "tokens", "window": "week", "stopAtPct": 10, "scope": "global" } },
  "watchdog": { "enabled": true,
    "rules": [ { "type": "stall", "value": 10, "action": "stop" }, { "type": "runtime", "value": 60, "action": "stop" }, { "type": "attempts", "value": 3, "action": "block" } ],
    "llm": { "enabled": false, "provider": "anthropic", "prompt": "What to verify after each run", "onFail": "todo" } }
}

Guidelines for a good blueprint:
- Small, independently verifiable issues with acceptance criteria; express ordering with blocked_by instead of prose.
- Few agents with clear roles (e.g. one planner/architect, one or two implementers, one reviewer). Give an implementer max_instances > 1 only when issues are truly independent.
- Put conventions that several agents need into a skill instead of repeating them in instructions.
- Give issues reviewers when the result matters: typically the lead or a QA agent. The reviewer only approves or asks for changes.
- Leave issues that need a human decision in "backlog".`

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
  if (!pj || typeof pj !== 'object') throw new Error('blueprint.project is missing')
  const key = str(pj.key, 8).toUpperCase()
  if (!/^[A-Z][A-Z0-9]{1,7}$/.test(key))
    throw new Error('project.key: 2-8 characters, A-Z/0-9, starting with a letter')

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
      if (!PROVIDERS[a.provider]) throw new Error(`Agent ${name}: unknown provider "${a.provider}"`)
      const model = str(a.model, 80)
      if (!MODEL_RE.test(model)) throw new Error(`Agent ${name}: invalid model name`)
      const skills = JSON.stringify(
        (a.skills ?? [])
          .map(
            (n: string) =>
              skillId.get(n) ?? get('SELECT id FROM skills WHERE project_id=? AND name=?', pid, n)?.id,
          )
          .filter(Boolean),
      )
      const max = Math.max(1, Math.min(20, Number(a.max_instances) || 1))
      const ex = get('SELECT id FROM agents WHERE project_id=? AND name=?', pid, name)
      if (ex)
        run(
          'UPDATE agents SET role=?, provider=?, model=?, instructions=?, skill_ids=?, max_instances=? WHERE id=?',
          str(a.role, 200),
          a.provider,
          model,
          str(a.instructions),
          skills,
          max,
          ex.id,
        )
      const id =
        ex?.id ??
        Number(
          run(
            'INSERT INTO agents (project_id, name, role, provider, model, instructions, skill_ids, max_instances) VALUES (?,?,?,?,?,?,?,?)',
            pid,
            name,
            str(a.role, 200),
            a.provider,
            model,
            str(a.instructions),
            skills,
            max,
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
  if (a < 0 || b <= a) throw new Error('The AI returned no JSON')
  return JSON.parse(text.slice(a, b + 1))
}
