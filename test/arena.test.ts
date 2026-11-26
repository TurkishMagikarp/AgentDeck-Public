import assert from 'node:assert/strict'
import { type ChildProcess, spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'

// The arena on the real server with mock agents: entries work in parallel, are held when they
// finish, the jury picks one, the winner goes on and the original closes with it.
const PORT = 20000 + Math.floor(Math.random() * 1000)
const base = `http://127.0.0.1:${PORT}`
const data = mkdtempSync(join(tmpdir(), 'agentdeck-arena-'))
let server: ChildProcess
let agents: Record<string, number> = {}
let projectId = 0

const call = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: response.status, body: (await response.json().catch(() => null)) as any }
}

const issue = async (id: number) => (await call('GET', `/api/issues/${id}`)).body

async function until<T>(what: string, check: () => Promise<T | undefined | false>) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const found = await check()
    if (found) return found
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`timed out waiting for ${what}`)
}

async function file(title: string, extra: Record<string, unknown> = {}) {
  const created = await call('POST', `/api/projects/${projectId}/issues`, {
    title,
    status: 'backlog',
    ...extra,
  })
  assert.equal(created.status, 201)
  return created.body.id as number
}

before(async () => {
  server = spawn(process.execPath, ['server/main.ts'], {
    env: {
      ...process.env,
      AGENTDECK_MOCK: '1',
      AGENTDECK_MOCK_MS: '150',
      AGENTDECK_DATA: data,
      PORT: String(PORT),
      AGENTDECK_SANDBOX: '0',
    },
    stdio: 'ignore',
  })
  await until('the server', async () => (await fetch(`${base}/api/projects`).catch(() => null))?.ok)
  const agent = (name: string) => ({ name, role: name, provider: 'mock', provider_override: true })
  const created = await call('POST', '/api/blueprint', {
    project: { key: 'ARENA', name: 'Arena', settings: { maxConcurrent: 4 } },
    agents: [agent('Ada'), agent('Ben'), agent('Cleo'), agent('Rex')],
  })
  projectId = created.body.projectId
  const board = (await call('GET', `/api/projects/${projectId}/board`)).body
  agents = Object.fromEntries(board.agents.map((entry: any) => [entry.name, entry.id]))
})

after(() => {
  server.kill()
  try {
    rmSync(data, { recursive: true, force: true })
  } catch {
    // Windows may still hold the database file for a moment.
  }
})

describe('starting an arena', () => {
  test('needs two to four different agents and an issue nobody works on yet', async () => {
    const id = await file('Validation')
    assert.equal((await call('POST', `/api/issues/${id}/arena`, { agents: [agents.Ada] })).status, 409)
    assert.equal(
      (await call('POST', `/api/issues/${id}/arena`, { agents: [agents.Ada, agents.Ada] })).status,
      409,
    )
    assert.equal((await call('POST', `/api/issues/${id}/arena`, { agents: [agents.Ada, 9999] })).status, 409)
    assert.equal((await issue(id)).arena, null)
  })
})

describe('an arena from start to winner', () => {
  test('the jury picks one entry, the others are closed, the original closes with the winner', async () => {
    const id = await file('Cart survives a reload', { description: '## Task\nKeep the cart.' })
    const started = await call('POST', `/api/issues/${id}/arena`, {
      agents: [agents.Ada, agents.Ben, agents.Cleo],
    })
    assert.equal(started.status, 201)
    assert.deepEqual(
      started.body.entries.map((entry: any) => entry.agent),
      ['Ada', 'Ben', 'Cleo'],
    )
    // A second arena on the same issue, or one on an entry, is refused.
    assert.equal(
      (await call('POST', `/api/issues/${id}/arena`, { agents: [agents.Ada, agents.Ben] })).status,
      409,
    )
    const entryId = started.body.entries[0].id
    assert.equal(
      (await call('POST', `/api/issues/${entryId}/arena`, { agents: [agents.Ada, agents.Ben] })).status,
      409,
    )

    const done = await until('the original to close', async () => {
      const detail = await issue(id)
      return detail.issue.status === 'done' && detail
    })
    const { arena } = done
    assert.equal(arena.phase, 'closed')
    // The mock jury picks entry A, the first one handed in.
    assert.equal(arena.winnerId, started.body.entries[0].id)
    assert.deepEqual(
      arena.entries.map((entry: any) => entry.state),
      ['winner', 'lost', 'lost'],
    )
    assert.ok(arena.entries.every((entry: any) => entry.status === 'done'))
    assert.ok(done.runs.some((run: any) => run.agent_name === 'Jury' && run.verdict === 'arena'))
    assert.ok(done.comments.some((comment: any) => /Die Jury hat entschieden/.test(comment.body)))

    // Every entry worked once, and none of them was reviewed or run again after the decision.
    for (const entry of arena.entries) {
      const detail = await issue(entry.id)
      assert.equal(detail.runs.length, 1)
      assert.equal(detail.runs[0].verdict, 'arena')
      assert.equal(detail.arena.parent.id, id)
    }
  })

  test('the jury can prefer a later entry, and the winner still goes through its reviewer', async () => {
    const id = await file('Search with typos [mock:jury:B]', { reviewers: [agents.Rex] })
    const started = await call('POST', `/api/issues/${id}/arena`, { agents: [agents.Ada, agents.Ben] })
    const [first, second] = started.body.entries

    const done = await until('the original to close', async () => {
      const detail = await issue(id)
      return detail.issue.status === 'done' && detail
    })
    assert.equal(done.arena.winnerId, second.id)
    const winner = await issue(second.id)
    assert.deepEqual(
      winner.runs.map((run: any) => `${run.agent_name}:${run.kind}`),
      ['Ben:work', 'Rex:review'],
    )
    // The entry that lost never reached the reviewer.
    assert.deepEqual(
      (await issue(first.id)).runs.map((run: any) => run.kind),
      ['work'],
    )
  })

  test('an entry that is blocked is out; the one that handed in wins without a jury', async () => {
    const id = await file('Mail after checkout')
    const started = await call('POST', `/api/issues/${id}/arena`, { agents: [agents.Ada, agents.Ben] })
    const [first, second] = started.body.entries
    // Taken out by hand before it can hand in.
    await call('PATCH', `/api/issues/${first.id}`, { status: 'blocked' })

    const done = await until('the original to close', async () => {
      const detail = await issue(id)
      return detail.issue.status === 'done' && detail
    })
    assert.equal(done.arena.winnerId, second.id)
    assert.ok(!done.runs.some((run: any) => run.agent_name === 'Jury'))
    assert.equal((await issue(first.id)).issue.status, 'done')
  })
})

describe('the owner decides', () => {
  test('picking by hand needs an entry that was handed in', async () => {
    const id = await file('Dark mode')
    const started = await call('POST', `/api/issues/${id}/arena`, { agents: [agents.Ada, agents.Ben] })
    // Entry of another arena, or nothing: refused.
    assert.equal((await call('POST', `/api/issues/${id}/arena/pick`, { entry: 999_999 })).status, 409)
    await until('the arena to close', async () => (await issue(id)).arena.phase === 'closed')
    // Decided already: a second decision is refused.
    assert.equal(
      (await call('POST', `/api/issues/${id}/arena/pick`, { entry: started.body.entries[1].id })).status,
      409,
    )
  })
})
