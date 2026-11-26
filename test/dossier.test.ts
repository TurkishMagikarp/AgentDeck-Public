import './setup.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { run } from '../server/db.ts'
import { buildDossier, digestRun, projectFeed, target } from '../server/dossier.ts'

test('target finds the path or command in JSON and cut payloads', () => {
  assert.equal(target('Write', '{"file_path":"src/a.ts","content":"x"}'), 'src/a.ts')
  assert.equal(target('Bash', '{"command":"npm test"}'), 'npm test')
  assert.equal(target('shell', 'git status\nmore'), 'git status')
  assert.equal(target('Write', '{"file_path":"src/cut.ts","content":"abc'), 'src/cut.ts')
})

test('digestRun counts tools and lists commands, files, fetches and redactions', () => {
  const d = digestRun({ id: 1, agent_name: 'A', provider: 'claude', model: 'm', status: 'done', started_at: 0, ended_at: 5, cost_usd: 1, input_tokens: 2, output_tokens: 3 }, [
    { kind: 'tool_call', name: 'Bash', payload: '{"command":"ls"}' },
    { kind: 'tool_call', name: 'Edit', payload: '{"file_path":"a.ts"}' },
    { kind: 'tool_call', name: 'Edit', payload: '{"file_path":"a.ts"}' },
    { kind: 'tool_call', name: 'WebFetch', payload: '{"url":"https://x.dev"}' },
    { kind: 'tool_result', name: 'Bash', payload: 'key [GEHEIM: github]' },
    { kind: 'error', name: '', payload: 'boom' },
  ])
  assert.deepEqual(d.files, ['a.ts'])
  assert.deepEqual(d.commands, ['ls'])
  assert.deepEqual(d.fetches, ['https://x.dev'])
  assert.equal(d.redactions, 1)
  assert.equal(d.tools[0].name, 'Edit')
  assert.equal(d.tokens, 5)
})

test('buildDossier and projectFeed read stored runs', () => {
  run("INSERT INTO projects (id, key, name, created_at) VALUES (9, 'DS', 'Dossier', 0)")
  run("INSERT INTO issues (id, project_id, number, title, created_at, updated_at) VALUES (9, 9, 1, 't', 0, 0)")
  run("INSERT INTO runs (id, project_id, issue_id, agent_name, provider, started_at, status) VALUES (90, 9, 9, 'A', 'mock', 1000, 'done')")
  run("INSERT INTO run_events (run_id, seq, at, kind, name, payload) VALUES (90, 1, 1100, 'tool_call', 'Write', '{\"file_path\":\"x.ts\"}')")
  const d = buildDossier(9)!
  assert.equal(d.totals.files, 1)
  assert.ok(d.steps.some((s) => s.key === 'run:90'))
  assert.equal(buildDossier(12345), null)
  assert.equal(projectFeed(9)[0].issue, 1)
  assert.equal(projectFeed(9, 2000).length, 0)
})

test('projectFeed includes server comments such as landings', () => {
  run("INSERT INTO comments (issue_id, author, kind, body, created_at) VALUES (9, 'System', 'comment', 'In main gelandet (abc)', 3000)")
  const feed = projectFeed(9)
  assert.equal(feed[0].kind, 'server')
  assert.equal(feed[0].runId, 0)
})

test('end to end: Claude and Codex output lines reach the dossier through the real parsers', async () => {
  const { newState, parse } = await import('../server/adapters.ts')
  const events: any[] = []
  const feed = (cli: string, lines: unknown[]) => {
    const st = newState()
    for (const line of lines) parse(cli, 'test', line, st, () => {}, (e) => events.push(e))
  }
  feed('claude', [
    { type: 'assistant', message: { content: [
      { type: 'tool_use', id: 'a', name: 'Write', input: { file_path: 'src/new.ts', content: 'x' } },
      { type: 'tool_use', id: 'b', name: 'Bash', input: { command: 'git push origin HEAD' } },
    ] } },
  ])
  feed('codex', [
    { type: 'item.started', item: { id: '1', type: 'command_execution', command: 'npm run build' } },
    { type: 'item.completed', item: { id: '3', type: 'file_change', changes: [{ path: 'codex.ts', kind: 'add' }] } },
  ])
  const d = digestRun(
    { id: 1, agent_name: 'A', provider: 'x', model: '', status: 'done', started_at: 0, ended_at: 1, cost_usd: 0 },
    events.map((e) => ({ kind: e.kind, name: e.name ?? '', payload: e.text })),
  )
  assert.deepEqual(d.files.sort(), ['codex.ts', 'src/new.ts'])
  assert.deepEqual(d.commands.sort(), ['git push origin HEAD', 'npm run build'])
})

test('a run cut by the recording cap gets its own flag', () => {
  run("INSERT INTO runs (id, project_id, issue_id, agent_name, provider, started_at, status) VALUES (91, 9, 9, 'A', 'mock', 1000, 'done')")
  run("INSERT INTO run_events (run_id, seq, at, kind, name, payload) VALUES (91, 1, 1100, 'error', '', 'Aufzeichnung gekürzt: Der Lauf hat mehr als 2 MB erzeugt, weitere Schritte fehlen.')")
  assert.ok(buildDossier(9)!.flags.some((f) => f.text.includes('nur teilweise aufgezeichnet')))
})
