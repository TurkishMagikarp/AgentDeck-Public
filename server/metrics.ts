// Prometheus metrics at GET /api/metrics: the fleet as numbers a monitoring stack can scrape and
// alert on (issues per status, running agents, runs, cost and tokens per provider, quotas).
// Counters come straight from the runs table, so they survive restarts. The answer is kept for a
// few seconds: a scrape every 15 s from two servers costs one set of queries, not two.
import { all } from './db.ts'

const KEEP_MS = 5_000

type Sample = { labels?: Record<string, string>; value: number }
type Metric = { name: string; help: string; type: 'gauge' | 'counter'; samples: Sample[] }
type Spend = {
  project: string
  provider: string
  cost: number
  input: number
  output: number
  cached: number
}

const escaped = (value: string) => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')

function line(name: string, { labels, value }: Sample) {
  const pairs = Object.entries(labels ?? {}).map(([key, label]) => `${key}="${escaped(String(label))}"`)
  return `${name}${pairs.length ? `{${pairs.join(',')}}` : ''} ${Number.isFinite(value) ? value : 0}`
}

/** The text exposition format, version 0.0.4. */
export function expose(metrics: Metric[]) {
  const lines = metrics.flatMap((metric) => [
    `# HELP ${metric.name} ${metric.help}`,
    `# TYPE ${metric.name} ${metric.type}`,
    ...metric.samples.map((sample) => line(metric.name, sample)),
  ])
  return lines.join('\n') + '\n'
}

export function collect(now = Date.now(), startedAt = now): Metric[] {
  const projects = all('SELECT id, key, paused FROM projects ORDER BY key')
  const keyOf = new Map<number, string>(projects.map((project) => [project.id, project.key]))
  const project = (row: { project_id: number }) => keyOf.get(row.project_id) ?? String(row.project_id)

  const finished = all(
    `SELECT project_id, provider, status, COUNT(*) AS runs, SUM(cost_usd) AS cost,
       SUM(input_tokens) AS input, SUM(output_tokens) AS output, SUM(cached_tokens) AS cached
     FROM runs WHERE status != 'running' GROUP BY project_id, provider, status`,
  )
  const spendOf = new Map<string, Spend>()
  for (const row of finished) {
    const key = `${row.project_id}/${row.provider}`
    const spend = spendOf.get(key) ?? {
      project: project(row),
      provider: row.provider,
      cost: 0,
      input: 0,
      output: 0,
      cached: 0,
    }
    spend.cost += row.cost ?? 0
    spend.input += row.input ?? 0
    spend.output += row.output ?? 0
    spend.cached += row.cached ?? 0
    spendOf.set(key, spend)
  }
  const spends = [...spendOf.values()]

  return [
    {
      name: 'agentdeck_up',
      help: 'Always 1 while the server answers.',
      type: 'gauge',
      samples: [{ value: 1 }],
    },
    {
      name: 'agentdeck_uptime_seconds',
      help: 'Seconds since the server started.',
      type: 'gauge',
      samples: [{ value: Math.round((now - startedAt) / 1000) }],
    },
    {
      name: 'agentdeck_project_paused',
      help: '1 while the project is paused.',
      type: 'gauge',
      samples: projects.map((row) => ({ labels: { project: row.key }, value: row.paused ? 1 : 0 })),
    },
    {
      name: 'agentdeck_issues',
      help: 'Issues per project and status. Status "blocked" waits for a human.',
      type: 'gauge',
      samples: all('SELECT project_id, status, COUNT(*) AS n FROM issues GROUP BY project_id, status').map(
        (row) => ({
          labels: { project: project(row), status: row.status },
          value: row.n,
        }),
      ),
    },
    {
      name: 'agentdeck_runs_running',
      help: 'Agent runs in progress.',
      type: 'gauge',
      samples: all(
        "SELECT project_id, provider, COUNT(*) AS n FROM runs WHERE status='running' GROUP BY project_id, provider",
      ).map((row) => ({ labels: { project: project(row), provider: row.provider }, value: row.n })),
    },
    {
      name: 'agentdeck_runs_total',
      help: 'Finished agent runs by outcome.',
      type: 'counter',
      samples: finished.map((row) => ({
        labels: { project: project(row), provider: row.provider, status: row.status },
        value: row.runs,
      })),
    },
    {
      name: 'agentdeck_cost_usd_total',
      help: 'Cost of finished runs in US dollars.',
      type: 'counter',
      samples: spends.map((spend) => ({
        labels: { project: spend.project, provider: spend.provider },
        value: Math.round(spend.cost * 10_000) / 10_000,
      })),
    },
    {
      name: 'agentdeck_tokens_total',
      help: 'Tokens of finished runs. "cached" is the part of "input" read from the prompt cache.',
      type: 'counter',
      samples: spends.flatMap((spend) =>
        (['input', 'output', 'cached'] as const).map((kind) => ({
          labels: { project: spend.project, provider: spend.provider, kind },
          value: spend[kind],
        })),
      ),
    },
    {
      name: 'agentdeck_quota_utilization',
      help: 'Used share of a subscription window as the provider reports it, 0 to 1.',
      type: 'gauge',
      samples: all('SELECT provider, window, utilization FROM quota').map((row) => ({
        labels: { provider: row.provider, window: row.window },
        value: row.utilization,
      })),
    },
  ]
}

const STARTED_AT = Date.now()
let kept = { at: 0, text: '' }

export function metricsText(now = Date.now()) {
  if (now - kept.at > KEEP_MS) kept = { at: now, text: expose(collect(now, STARTED_AT)) }
  return kept.text
}
