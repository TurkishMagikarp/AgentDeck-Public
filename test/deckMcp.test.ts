import assert from 'node:assert/strict'
import { type ChildProcess, spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

// The MCP endpoint on the real server, with a board token: an MCP client lists the tools, files an
// issue, reads it back and moves it; a viewer's token reads but cannot write.
const PORT = 19000 + Math.floor(Math.random() * 1000)
const base = `http://127.0.0.1:${PORT}`
const TOKEN = 'test-token-for-the-mcp-endpoint'
const data = mkdtempSync(join(tmpdir(), 'agentdeck-mcp-'))
let server: ChildProcess
let nextId = 1

const api = (method: string, path: string, body?: unknown, token = TOKEN) =>
  fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

async function rpc(method: string, params: unknown = {}, token = TOKEN) {
  const response = await fetch(`${base}/api/mcp-server`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
  })
  return { status: response.status, body: (await response.json().catch(() => null)) as any }
}

async function tool(name: string, args: unknown = {}, token = TOKEN) {
  const { body } = await rpc('tools/call', { name, arguments: args }, token)
  const text = body.result.content[0].text
  let value: any = text
  try {
    value = JSON.parse(text)
  } catch {
    // a plain sentence
  }
  return { value, isError: !!body.result.isError }
}

before(async () => {
  server = spawn(process.execPath, ['server/main.ts'], {
    env: {
      ...process.env,
      AGENTDECK_MOCK: '1',
      AGENTDECK_TOKEN: TOKEN,
      AGENTDECK_DATA: data,
      PORT: String(PORT),
      AGENTDECK_SANDBOX: '0',
    },
    stdio: 'ignore',
  })
  for (let i = 0; i < 60; i++) {
    try {
      if ((await api('GET', '/api/projects')).ok) break
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  // Paused, so the mock agents leave the issues where the test puts them.
  const created = await api('POST', '/api/projects', { key: 'MCP', name: 'MCP test', paused: true })
  assert.equal(created.status, 201)
})

after(() => {
  server.kill()
  try {
    rmSync(data, { recursive: true, force: true })
  } catch {
    // Windows may still hold the database file for a moment.
  }
})

test('the endpoint needs a login', async () => {
  assert.equal((await rpc('tools/list', {}, 'wrong-token')).status, 401)
})

test('initialize names the server and tools/list shows read and write tools', async () => {
  const init = await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test', version: '1' },
  })
  assert.equal(init.body.result.serverInfo.name, 'agentdeck')
  const names = (await rpc('tools/list')).body.result.tools.map((entry: any) => entry.name)
  for (const name of ['fleet_status', 'get_board', 'get_issue', 'create_issue', 'move_issue', 'stop_run'])
    assert.ok(names.includes(name), `missing ${name}`)
})

test('an issue is filed in the backlog, read back, commented and moved', async () => {
  const created = await tool('create_issue', {
    project: 'mcp',
    title: 'Dark mode',
    description: '## Task\nAdd it.',
  })
  assert.deepEqual(created.value, { key: 'MCP-1', status: 'backlog' })

  await tool('comment_on_issue', { issue: 'MCP-1', body: 'Please keep the contrast high.' })
  const issue = (await tool('get_issue', { issue: 'mcp-1' })).value
  assert.equal(issue.title, 'Dark mode')
  assert.equal(issue.createdBy, 'Owner (MCP)')
  assert.equal(issue.comments.at(-1).body, 'Please keep the contrast high.')

  assert.deepEqual((await tool('move_issue', { issue: 'MCP-1', status: 'todo' })).value, {
    key: 'MCP-1',
    status: 'todo',
  })
  const board = (await tool('get_board', { project: 'MCP', status: 'todo' })).value
  assert.equal(board.columns.todo.issues[0].key, 'MCP-1')
  assert.equal((await tool('search_issues', { query: 'dark' })).value[0].key, 'MCP-1')
  assert.ok((await tool('fleet_status')).value.projects.some((project: any) => project.key === 'MCP'))
})

test('a wrong key is an answer, not a broken connection', async () => {
  const missing = await tool('get_issue', { issue: 'MCP-999' })
  assert.ok(missing.isError)
  assert.match(missing.value, /No issue MCP-999/)
  assert.ok((await tool('get_board', { project: 'NOPE' })).isError)
})

test('a viewer reads through MCP but cannot write', async () => {
  const user = await (await api('POST', '/api/users', { name: 'Reader', role: 'viewer' })).json()
  assert.ok(user.token)
  assert.equal((await tool('get_board', { project: 'MCP' }, user.token)).isError, false)
  const refused = await tool('create_issue', { project: 'MCP', title: 'Not allowed' }, user.token)
  assert.ok(refused.isError)
  assert.match(refused.value, /permission/)
})

test('the MCP client of the SDK connects, lists the tools and calls one', async () => {
  const client = new Client({ name: 'agentdeck-test', version: '1.0.0' })
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/api/mcp-server`), {
    requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
  })
  await client.connect(transport)
  try {
    assert.equal(client.getServerVersion()?.name, 'agentdeck')
    const { tools } = await client.listTools()
    assert.equal(tools.length, 10)
    assert.ok(tools.every((entry) => entry.description && entry.inputSchema.type === 'object'))
    const answer: any = await client.callTool({ name: 'list_projects', arguments: {} })
    assert.equal(JSON.parse(answer.content[0].text)[0].key, 'MCP')
  } finally {
    await client.close()
  }
})

test('an arena is started by agent names, and an unknown name is an answer', async () => {
  const project = (await (await api('GET', '/api/projects')).json()).find((entry: any) => entry.key === 'MCP')
  for (const name of ['Ada', 'Ben'])
    assert.equal((await api('POST', `/api/projects/${project.id}/agents`, { name, provider: 'mock' })).status, 201)
  const filed = (await tool('create_issue', { project: 'MCP', title: 'Two ways to do it' })).value

  const unknown = await tool('start_arena', { issue: filed.key, agents: ['Ada', 'Nobody'] })
  assert.ok(unknown.isError)
  assert.match(unknown.value, /No agent "Nobody"/)

  const started = (await tool('start_arena', { issue: filed.key, agents: ['ada', 'Ben'] })).value
  assert.equal(started.issue, filed.key)
  assert.deepEqual(
    started.entries.map((entry: any) => entry.agent),
    ['Ada', 'Ben'],
  )
  assert.ok((await tool('start_arena', { issue: filed.key, agents: ['Ada', 'Ben'] })).isError)
})
