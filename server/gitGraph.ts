// The git workflow of a project as data for a graph: the base branch with its newest commits,
// and one lane per issue branch with the point it left the base, its own commits, whether it
// has landed, who made it and which agent is on it right now.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { all } from './db.ts'
import { DATA_DIR } from './db.ts'
import { t } from './i18n.ts'
import { gitIn } from './sandbox.ts'
import { Lru } from './lru.ts'


const BASE_COMMITS = 25
const BRANCH_COMMITS = 15
const MAX_BRANCHES = 40

// Git answers by commit id do not change, so they are cached by commit id: the base's history by
// the base's tip, a branch's history and distance by both tips. A graph request then spawns git
// only to read the refs, not once or twice per branch.
type BaseInfo = { baseCommits: Commit[]; mainLine: Map<string, Commit>; mergedBy: Map<string, string> }
const baseCache = new Lru<BaseInfo>({ maxEntries: 50 })
const branchCache = new Lru<{ history: Commit[]; ahead: number }>({ maxEntries: 5000 })

type Project = {
  id: number
  key: string
  repo_path: string
  settings: { workspace: 'issue' | 'agent'; landing: { baseBranch: string } }
}

export type Commit = { hash: string; at: number; subject: string }

async function git(repo: string, ...args: string[]) {
  const { stdout } = await gitIn(repo, args, { maxBuffer: 32 * 1024 * 1024 })
  return stdout.trim()
}

const attempt = <T>(command: Promise<T>, fallback: T) => command.catch(() => fallback)

const parseLog = (text: string): Commit[] =>
  text
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [hash, at, ...subject] = line.split('\t')
      return { hash, at: Number(at) * 1000, subject: subject.join('\t') }
    })

const LOG_FORMAT = '--format=%h%x09%ct%x09%s'

/** Which branch every per-agent checkout has checked out right now, by agent id. */
async function agentCheckouts(project: Project) {
  const checkouts = new Map<number, string>()
  if (project.settings.workspace !== 'agent') return checkouts
  const agents = all('SELECT id FROM agents WHERE project_id=?', project.id)
  for (const agent of agents) {
    for (let slot = 0; slot < 4; slot++) {
      const dir = join(DATA_DIR, 'worktrees', project.key, `agent-${agent.id}-${slot}`)
      if (!existsSync(dir)) break
      const branch = await attempt(git(dir, 'branch', '--show-current'), '')
      if (branch) checkouts.set(agent.id, branch)
    }
  }
  return checkouts
}

export async function gitGraph(project: Project) {
  const repo = project.repo_path || join(DATA_DIR, 'workspaces', project.key)
  if (!existsSync(repo) || !(await attempt(git(repo, 'rev-parse', '--verify', 'HEAD'), ''))) {
    return { repo: false as const }
  }

  const base = project.settings.landing.baseBranch || (await git(repo, 'symbolic-ref', '--short', 'HEAD'))
  const [baseSha, refLines] = await Promise.all([
    git(repo, 'rev-parse', '--verify', `${base}^{commit}`),
    git(repo, 'for-each-ref', '--format=%(refname:short)%09%(objectname)', `refs/heads/agentdeck/${project.key}-*`),
  ])
  const refs = refLines
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [branch, sha] = line.split('\t')
      return { branch, sha }
    })

  const issues = new Map(
    all(
      `SELECT i.number, i.title, i.status, i.maker_id, i.done_at, a.name AS maker FROM issues i
       LEFT JOIN agents a ON a.id = i.maker_id WHERE i.project_id=?`,
      project.id,
    ).map((row) => [row.number as number, row]),
  )
  const running = all(
    `SELECT r.agent_id, r.agent_name, r.kind, i.number FROM runs r JOIN issues i ON i.id = r.issue_id
     WHERE r.project_id=? AND r.status='running'`,
    project.id,
  )
  const checkouts = await agentCheckouts(project)

  const { baseCommits, mainLine, mergedBy } = await baseCache.remember(`${repo}\0${baseSha}`, async () => {
    const [recent, line, merges] = await Promise.all([
      git(repo, 'log', '--first-parent', LOG_FORMAT, `-${BASE_COMMITS}`, baseSha),
      // The base's own line of history. A branch's commits are the ones above the first commit
      // that lies on this line; that commit is where it forked. This also works after a merge has
      // landed the branch, when "base..branch" would be empty.
      git(repo, 'log', '--first-parent', LOG_FORMAT, '-400', baseSha),
      // Merge commits on the base line, by the branch tip they brought in (their second parent).
      git(repo, 'log', '--first-parent', '--merges', '--format=%h %p', '-400', baseSha),
    ])
    const mergedBy = new Map<string, string>()
    for (const entry of merges.split('\n').filter(Boolean)) {
      const [merge, , brought] = entry.split(' ')
      if (brought) mergedBy.set(brought.slice(0, 7), merge)
    }
    return {
      baseCommits: parseLog(recent),
      mainLine: new Map(parseLog(line).map((commit) => [commit.hash, commit])),
      mergedBy,
    }
  })

  const branches = await Promise.all(
    refs.map(async ({ branch, sha }) => {
      const number = Number(branch.split('-').pop())
      const issue = issues.get(number)
      const { history, ahead } = await branchCache.remember(`${repo}\0${baseSha}\0${sha}`, async () => {
        const [log, count] = await Promise.all([
          git(repo, 'log', '--first-parent', LOG_FORMAT, `-${BRANCH_COMMITS + 1}`, sha),
          attempt(git(repo, 'rev-list', '--count', `${baseSha}..${sha}`), '0'),
        ])
        return { history: parseLog(log), ahead: Number(count) }
      })
      const forkIndex = history.findIndex((commit) => mainLine.has(commit.hash))
      const own = (
        forkIndex === -1 ? history.slice(0, BRANCH_COMMITS) : history.slice(0, forkIndex)
      ).reverse()
      const fork = forkIndex === -1 ? { hash: '', at: 0 } : history[forkIndex]
      const working = running.filter((run) => run.number === number)
      const tip = own.at(-1)?.hash.slice(0, 7) ?? ''
      return {
        branch,
        number,
        title: issue?.title ?? t('(Issue gelöscht)'),
        status: issue?.status ?? 'done',
        maker: issue?.maker ?? '',
        commits: own,
        fork: { hash: fork.hash, at: fork.at },
        landed: ahead === 0 && own.length > 0,
        landedAt: ahead === 0 ? (issue?.done_at ?? null) : null,
        /** The merge commit on the base that landed the branch; empty for squash, rebase or fast-forward. */
        mergeHash: (tip && mergedBy.get(tip)) || '',
        working: working.map((run) => ({ agent: run.agent_name, kind: run.kind })),
      }
    }),
  )

  // Active lanes first, then the ones with the newest work.
  const newest = (lane: (typeof branches)[number]) =>
    Math.max(lane.commits.at(-1)?.at ?? 0, lane.landedAt ?? 0, lane.fork.at)
  branches.sort((a, b) => b.working.length - a.working.length || newest(b) - newest(a))

  const agents = all('SELECT id, name, enabled FROM agents WHERE project_id=? ORDER BY id', project.id).map(
    (agent) => {
      const run = running.find((candidate) => candidate.agent_id === agent.id)
      return {
        name: agent.name,
        enabled: !!agent.enabled,
        branch: run ? `agentdeck/${project.key}-${run.number}` : (checkouts.get(agent.id) ?? ''),
        kind: run?.kind ?? '',
        working: !!run,
      }
    },
  )

  return {
    repo: true as const,
    base,
    baseCommits: [...baseCommits].reverse(),
    branches: branches.slice(0, MAX_BRANCHES),
    agents,
  }
}
