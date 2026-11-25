// The showcase: a read-only public page that shows a project's agents at work. It is meant for
// people who should see the team running (a job application, a demo) without a login. It shows
// names, states and counts. Issue titles only if the owner allows it; never code, costs or comments.
import { randomBytes } from 'node:crypto'
import { activity, PROVIDERS, versionOf } from './core.ts'
import { all, get } from './db.ts'

export const newShowcaseSlug = () => randomBytes(9).toString('base64url')

function projectBySlug(slug: string) {
  if (!/^[\w-]{8,40}$/.test(slug)) return undefined
  // The slug lives in the settings JSON; projects are few, so scanning them is cheap.
  return all('SELECT id, key, name, paused, settings FROM projects')
    .map((row) => ({ ...row, settings: JSON.parse(row.settings || '{}') }))
    .find((row) => row.settings.showcase?.enabled && row.settings.showcase.slug === slug)
}

/**
 * Changes whenever the project emits an event, the day turns (the counts are per day) or the
 * owner switches titles on or off. Undefined when there is no such showcase.
 */
export function showcaseTag(slug: string) {
  const project = projectBySlug(slug)
  if (!project) return undefined
  const day = new Date().toDateString()
  return `W/"${project.id}-${versionOf(project.id)}-${day.replace(/ /g, '')}-${project.settings.showcase.titles ? 1 : 0}"`
}

export function showcaseData(slug: string) {
  const project = projectBySlug(slug)
  if (!project) return undefined
  const titles = !!project.settings.showcase.titles
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const weekAgo = today.getTime() - 6 * 86_400_000
  const count = (sql: string, ...params: unknown[]) => get(sql, project.id, ...params)!.count as number

  const running = all(
    `SELECT r.id, r.agent_id, i.number, i.title FROM runs r JOIN issues i ON i.id = r.issue_id
     WHERE r.project_id=? AND r.status='running'`,
    project.id,
  )
  const agents = all(
    'SELECT id, name, role, provider FROM agents WHERE project_id=? AND enabled=1 ORDER BY id',
    project.id,
  ).map((agent) => {
    const run = running.find((candidate) => candidate.agent_id === agent.id)
    const lastActivity = run && activity.get(run.id)
    return {
      name: agent.name,
      role: agent.role,
      provider: PROVIDERS[agent.provider]?.label ?? agent.provider,
      working: !!run,
      on: run ? `${project.key}-${run.number}${titles ? ` ${run.title}` : ''}` : '',
      since: lastActivity?.at ?? null,
    }
  })

  const recent = all(
    "SELECT number, title, done_at FROM issues WHERE project_id=? AND status='done' AND done_at IS NOT NULL ORDER BY done_at DESC LIMIT 10",
    project.id,
  ).map((issue) => ({
    key: `${project.key}-${issue.number}`,
    title: titles ? issue.title : '',
    at: issue.done_at,
  }))

  return {
    name: project.name,
    paused: !!project.paused,
    agents,
    counts: {
      doneToday: count(
        'SELECT COUNT(*) AS count FROM issues WHERE project_id=? AND done_at>=?',
        today.getTime(),
      ),
      doneWeek: count('SELECT COUNT(*) AS count FROM issues WHERE project_id=? AND done_at>=?', weekAgo),
      doneAll: count("SELECT COUNT(*) AS count FROM issues WHERE project_id=? AND status='done'"),
      open: count(
        "SELECT COUNT(*) AS count FROM issues WHERE project_id=? AND status IN ('todo','in_progress','review')",
      ),
      runsToday: count(
        'SELECT COUNT(*) AS count FROM runs WHERE project_id=? AND started_at>=?',
        today.getTime(),
      ),
    },
    recent,
  }
}

/** The page itself. It polls the public endpoint, so it works without the board's login and SSE. */
export const showcasePage = (slug: string, nonce: string) => `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>AgentDeck Showcase</title>
<link rel="icon" href="/icon.svg" type="image/svg+xml" />
<style nonce="${nonce}">
  :root { --bg: #f6f7f9; --surface: #fff; --border: #e1e4ea; --text: #1b1f27; --muted: #677083; --good: #1f9d61; --accent: #3e63dd; }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #0e1014; --surface: #161920; --border: #2a2f3a; --text: #e6e8ec; --muted: #8b93a3; --good: #3fb97f; --accent: #6b8afd; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.5 system-ui, sans-serif; }
  main { max-width: 900px; margin: 0 auto; padding: 32px 16px 48px; }
  h1 { margin: 0 0 4px; font-size: 26px; }
  .muted { color: var(--muted); }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 10px; margin: 24px 0; }
  .stat, .agent { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; }
  .stat strong { display: block; font-size: 24px; font-variant-numeric: tabular-nums; }
  .agents { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 10px; }
  .agent header { display: flex; align-items: center; gap: 8px; }
  .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--border); flex: none; }
  .working .dot { background: var(--good); box-shadow: 0 0 0 4px color-mix(in srgb, var(--good) 25%, transparent); }
  .agent p { margin: 6px 0 0; font-size: 13.5px; }
  ol { padding-left: 20px; }
  li { margin: 4px 0; }
  footer { margin-top: 32px; font-size: 13px; }
  a { color: var(--accent); }
</style>
</head>
<body>
<main>
  <h1 id="name">…</h1>
  <div class="muted" id="state">A team of AI agents, live.</div>
  <section class="stats" id="stats"></section>
  <h2>Agents</h2>
  <section class="agents" id="agents"></section>
  <h2>Recently done</h2>
  <ol id="recent"></ol>
  <footer class="muted">Runs on AgentDeck. Refreshes every 10 seconds.</footer>
</main>
<script nonce="${nonce}">
const slug = ${JSON.stringify(slug).replace(/</g, '\\u003c')}
const esc = (text) => String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
const ago = (at) => { const m = Math.round((Date.now() - at) / 60000); return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : Math.round(m / 60) + ' h ago' }
async function load() {
  const res = await fetch('/api/public/' + slug)
  if (!res.ok) { document.getElementById('name').textContent = 'Not found'; return }
  const data = await res.json()
  document.title = data.name + ' · AgentDeck'
  document.getElementById('name').textContent = data.name
  const working = data.agents.filter((a) => a.working).length
  document.getElementById('state').textContent = data.paused ? 'Paused.' : working + ' of ' + data.agents.length + ' agents are working right now.'
  const c = data.counts
  document.getElementById('stats').innerHTML = [[c.doneToday, 'done today'], [c.doneWeek, 'in 7 days'], [c.doneAll, 'in total'], [c.open, 'open'], [c.runsToday, 'runs today']]
    .map(([v, l]) => '<div class="stat"><strong>' + v + '</strong><span class="muted">' + l + '</span></div>').join('')
  document.getElementById('agents').innerHTML = data.agents.map((a) =>
    '<article class="agent' + (a.working ? ' working' : '') + '"><header><span class="dot"></span><strong>' + esc(a.name) + '</strong></header>' +
    '<p class="muted">' + esc(a.role || a.provider) + '</p>' +
    '<p>' + (a.working ? 'working on ' + esc(a.on) + (a.since ? ' · ' + ago(a.since) : '') : 'waiting') + '</p></article>').join('')
  document.getElementById('recent').innerHTML = data.recent.map((i) =>
    '<li><strong>' + esc(i.key) + '</strong> ' + esc(i.title) + ' <span class="muted">' + ago(i.at) + '</span></li>').join('') || '<li class="muted">Nothing yet.</li>'
}
load()
setInterval(load, 10000)
</script>
</body>
</html>`
