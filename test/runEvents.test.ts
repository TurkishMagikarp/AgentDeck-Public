import './setup.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { newState, parse } from '../server/adapters.ts'
import { run } from '../server/db.ts'
import {
  clean,
  EVENT_CAP,
  knownSecrets,
  pruneRunEvents,
  recordRun,
  redact,
  RUN_CAP,
  runEvents,
  type TraceEvent,
} from '../server/runEvents.ts'

// Shapes a scanner recognises; built at runtime so this file itself holds no key-shaped literal.
const ANTHROPIC = 'sk-ant-' + 'api03-' + 'Q7f2Kx9LmP4vR8tZ1nB6wY3cH5jD0gS'
const GITHUB = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'

function capture(cli: string, lines: unknown[]) {
  const events: TraceEvent[] = []
  const st = newState()
  for (const line of lines) parse(cli, 'test', line, st, () => {}, (e) => events.push(e))
  return events
}

let nextRun = 0
function newRun(startedAt = Date.now()) {
  if (!nextRun) {
    run("INSERT INTO projects (id, key, name, created_at) VALUES (1, 'RP', 'Replay', 0)")
    run("INSERT INTO issues (id, project_id, number, title, created_at, updated_at) VALUES (1, 1, 1, 'x', 0, 0)")
  }
  nextRun++
  run(
    "INSERT INTO runs (id, project_id, issue_id, agent_name, provider, started_at) VALUES (?, 1, 1, 'A', 'mock', ?)",
    nextRun,
    startedAt,
  )
  return nextRun
}

test('Claude stream-json: messages, tool calls and their results by name', () => {
  const events = capture('claude', [
    { type: 'system', subtype: 'init' },
    {
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'I read the file.' },
          { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'src/a.ts' } },
        ],
      },
    },
    {
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'export {}' }] }] },
    },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'zz', content: 'nope', is_error: true }] } },
    { type: 'result', total_cost_usd: 0.1, result: 'broken', is_error: true, usage: {} },
  ])
  assert.deepEqual(events, [
    { kind: 'assistant', text: 'I read the file.' },
    { kind: 'tool_call', name: 'Read', text: '{"file_path":"src/a.ts"}' },
    { kind: 'tool_result', name: 'Read', text: 'export {}' },
    { kind: 'error', name: 'tool', text: 'nope' },
    { kind: 'error', text: 'broken' },
  ])
})

test('Codex JSON: commands with their output, other items, messages and errors', () => {
  const events = capture('codex', [
    { type: 'thread.started', thread_id: 'th' },
    { type: 'item.started', item: { id: '1', type: 'command_execution', command: 'npm test' } },
    { type: 'item.completed', item: { id: '1', type: 'command_execution', aggregated_output: 'ok', exit_code: 0 } },
    { type: 'item.started', item: { id: '2', type: 'reasoning', text: 'hm' } },
    { type: 'item.completed', item: { id: '2', type: 'reasoning', text: 'hm' } },
    { type: 'item.completed', item: { id: '3', type: 'file_change', changes: [{ path: 'a.ts', kind: 'add' }] } },
    { type: 'item.completed', item: { id: '4', type: 'agent_message', text: 'Fertig.' } },
    { type: 'turn.failed', error: { message: 'Limit' } },
  ])
  assert.deepEqual(events, [
    { kind: 'tool_call', name: 'shell', text: 'npm test' },
    { kind: 'tool_result', name: 'shell', text: 'ok\n[exit code 0]' },
    { kind: 'tool_result', name: 'file_change', text: '{"changes":[{"path":"a.ts","kind":"add"}]}' },
    { kind: 'assistant', text: 'Fertig.' },
    { kind: 'error', text: 'Limit' },
  ])
})

test('opencode JSON: a finished tool brings its output along', () => {
  const events = capture('opencode', [
    { type: 'text', part: { text: 'Go.' } },
    { type: 'tool_use', part: { tool: 'bash', state: { status: 'completed', input: { command: 'ls' }, output: 'a\nb' } } },
    { type: 'tool_use', part: { tool: 'read', state: { status: 'error', input: {}, error: 'missing' } } },
  ])
  assert.deepEqual(events, [
    { kind: 'assistant', text: 'Go.' },
    { kind: 'tool_call', name: 'bash', text: '{"command":"ls"}' },
    { kind: 'tool_result', name: 'bash', text: 'a\nb' },
    { kind: 'tool_call', name: 'read', text: '{}' },
    { kind: 'error', name: 'read', text: 'missing' },
  ])
})

test('redaction removes keys, tokens of the run and private keys with their body', () => {
  const env = { AGENTDECK_RUN_TOKEN: 'run-token-0123456789', GIT_CONFIG_KEY_0: 'remote.origin.pushurl', GH_TOKEN: '' }
  const known = knownSecrets(env)
  assert.deepEqual(known, ['run-token-0123456789'])

  const text = [
    `ANTHROPIC_API_KEY=${ANTHROPIC} and ${GITHUB}`,
    'Authorization: run-token-0123456789',
    '-----BEGIN RSA PRIVATE KEY-----',
    'MIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gun',
    '-----END RSA PRIVATE KEY-----',
    'remote.origin.pushurl stays',
  ].join('\n')
  const out = redact(text, known)
  for (const secret of [ANTHROPIC, GITHUB, 'run-token-0123456789', 'MIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gun'])
    assert.ok(!out.includes(secret), secret.slice(0, 8))
  assert.match(out, /\[SECRET: anthropic\]/)
  assert.match(out, /\[SECRET: github\]/)
  assert.match(out, /\[SECRET: private-key\]/)
  assert.match(out, /remote\.origin\.pushurl stays/)
  // Placeholders are not secrets.
  assert.equal(redact('api_key = "your-api-key-goes-here-123"'), 'api_key = "your-api-key-goes-here-123"')
})

test('a secret in a very long line and one across the cut are still found', () => {
  const long = 'x'.repeat(30_000) + ' ' + GITHUB + ' ' + 'y'.repeat(30_000)
  assert.ok(!redact(long).includes(GITHUB))

  const across = 'a'.repeat(EVENT_CAP - 11) + ' ' + ANTHROPIC
  const { payload, size } = clean(across, EVENT_CAP)
  assert.equal(size, across.length)
  assert.ok(payload.length <= EVENT_CAP)
  assert.ok(!payload.includes(ANTHROPIC.slice(0, 10)), 'no prefix of the key survives the cut')
})

test('events are buffered, capped per event and redacted before they are stored', () => {
  const runId = newRun()
  const recorder = recordRun(runId, ['secret-token-123'])
  recorder.add({ kind: 'prompt', name: 'sha256:abc', text: 'Prompt with secret-token-123' })
  recorder.add({ kind: 'tool_result', name: 'Bash', text: 'z'.repeat(EVENT_CAP * 3) })
  recorder.add({ kind: 'assistant', text: `My key: ${ANTHROPIC}` })
  recorder.add({ kind: 'bogus' as any, text: 'never' })

  // Still in the buffer: nothing written yet, but the timeline already shows it.
  assert.equal(Number(run('UPDATE run_events SET at=at WHERE run_id=?', runId).changes), 0)
  assert.equal(runEvents(runId).length, 3)

  recorder.close()
  const events = runEvents(runId)
  assert.deepEqual(
    events.map((e) => [e.seq, e.kind, e.name]),
    [
      [1, 'prompt', 'sha256:abc'],
      [2, 'tool_result', 'Bash'],
      [3, 'assistant', ''],
    ],
  )
  assert.equal(events[0].payload, 'Prompt with [SECRET: run token]')
  assert.equal(events[1].payload.length, EVENT_CAP)
  assert.equal(events[1].size, EVENT_CAP * 3)
  assert.ok(!events[2].payload.includes(ANTHROPIC))
  assert.deepEqual(runEvents(runId, 'assistant').map((e) => e.seq), [3])

  // Closed: later events are dropped.
  recorder.add({ kind: 'assistant', text: 'too late' })
  assert.equal(runEvents(runId).length, 3)
})

test('a run stops being recorded at its cap, but its end is kept', () => {
  const runId = newRun()
  const recorder = recordRun(runId)
  const chunk = 'w'.repeat(EVENT_CAP)
  const fits = Math.floor(RUN_CAP / EVENT_CAP)
  for (let i = 0; i < fits + 20; i++) recorder.add({ kind: 'tool_result', text: chunk })
  recorder.add({ kind: 'changes', text: 'Commits:\nabc123 fix' })
  recorder.add({ kind: 'end', text: 'Run finished.' })
  recorder.close()

  const events = runEvents(runId)
  const results = events.filter((e) => e.kind === 'tool_result')
  assert.ok(results.length <= fits)
  assert.ok(results.reduce((sum, e) => sum + e.payload.length, 0) <= RUN_CAP)
  assert.equal(events.filter((e) => e.kind === 'error' && /Recording cut/.test(e.payload)).length, 1)
  assert.deepEqual(events.slice(-2).map((e) => e.kind), ['changes', 'end'])
})

test('old timelines go with the run retention', () => {
  const longAgo = Date.now() - 40 * 86_400_000
  const old = newRun(longAgo)
  const recent = newRun()
  // Run ids grow with time; the runs of the tests before are old too.
  run('UPDATE runs SET started_at=? WHERE id < ?', longAgo, recent)
  for (const id of [old, recent]) {
    const recorder = recordRun(id)
    recorder.add({ kind: 'assistant', text: 'hello' })
    recorder.close()
  }
  pruneRunEvents(Date.now() - 30 * 86_400_000)
  assert.equal(runEvents(old).length, 0)
  assert.equal(runEvents(recent).length, 1)
})
