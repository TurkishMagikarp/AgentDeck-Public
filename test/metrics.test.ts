import './setup.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { run } from '../server/db.ts'
import { collect, expose } from '../server/metrics.ts'
import { setQuota } from './helpers.ts'

const project = Number(
  run("INSERT INTO projects (key, name, paused, created_at) VALUES ('MET', 'Metrics', 1, 0)").lastInsertRowid,
)
const issue = Number(
  run(
    "INSERT INTO issues (project_id, number, title, status, created_at, updated_at) VALUES (?, 1, 'a', 'blocked', 0, 0)",
    project,
  ).lastInsertRowid,
)
run(
  "INSERT INTO issues (project_id, number, title, status, created_at, updated_at) VALUES (?, 2, 'b', 'done', 0, 0)",
  project,
)
const finishedRun = (status: string, cost: number, input: number) =>
  run(
    `INSERT INTO runs (project_id, issue_id, provider, status, started_at, ended_at, input_tokens, output_tokens, cached_tokens, cost_usd)
     VALUES (?, ?, 'anthropic', ?, 0, 1, ?, 10, 5, ?)`,
    project,
    issue,
    status,
    input,
    cost,
  )
finishedRun('done', 0.5, 100)
finishedRun('done', 0.25, 200)
finishedRun('failed', 0.1, 50)
run(
  "INSERT INTO runs (project_id, issue_id, provider, status, started_at) VALUES (?, ?, 'openai', 'running', 0)",
  project,
  issue,
)
setQuota('anthropic', 'week', 0.4)

const text = expose(collect(60_000, 0))

test('issues, runs, cost and tokens are exposed per project and provider', () => {
  assert.match(text, /^agentdeck_up 1$/m)
  assert.match(text, /^agentdeck_uptime_seconds 60$/m)
  assert.match(text, /^agentdeck_project_paused\{project="MET"\} 1$/m)
  assert.match(text, /^agentdeck_issues\{project="MET",status="blocked"\} 1$/m)
  assert.match(text, /^agentdeck_runs_running\{project="MET",provider="openai"\} 1$/m)
  assert.match(text, /^agentdeck_runs_total\{project="MET",provider="anthropic",status="done"\} 2$/m)
  assert.match(text, /^agentdeck_runs_total\{project="MET",provider="anthropic",status="failed"\} 1$/m)
  assert.match(text, /^agentdeck_cost_usd_total\{project="MET",provider="anthropic"\} 0\.85$/m)
  assert.match(text, /^agentdeck_tokens_total\{project="MET",provider="anthropic",kind="input"\} 350$/m)
  assert.match(text, /^agentdeck_tokens_total\{project="MET",provider="anthropic",kind="cached"\} 15$/m)
  assert.match(text, /^agentdeck_quota_utilization\{provider="anthropic",window="week"\} 0\.4$/m)
})

test('every metric has a help and a type line, and label values are escaped', () => {
  for (const name of text.matchAll(/^(agentdeck_\w+)/gm)) {
    assert.ok(text.includes(`# HELP ${name[1]} `), name[1])
    assert.ok(text.includes(`# TYPE ${name[1]} `), name[1])
  }
  const odd = expose([
    {
      name: 'x',
      help: 'h',
      type: 'gauge',
      samples: [{ labels: { a: String.raw`q"u\o` + '\nte' }, value: 1 }],
    },
  ])
  assert.ok(odd.includes(String.raw`x{a="q\"u\\o\nte"} 1`))
})
