import './setup.ts'
import assert from 'node:assert/strict'
import { beforeEach, describe, test } from 'node:test'
import { run } from '../server/db.ts'
import { classifyFailure, parkedRest } from '../server/recovery.ts'

const MINUTE = 60_000
let projectId = 0
let issueId = 0
let clock = 1_000_000

function park() {
  run(
    "INSERT INTO comments (issue_id, author, kind, body, created_at) VALUES (?, 'Watchdog', 'watchdog', 'Geparkt: Grund', ?)",
    issueId,
    (clock += 1000),
  )
}

function finishedRun(verdict: string, status = 'done') {
  clock += 1000
  run(
    "INSERT INTO runs (project_id, issue_id, provider, status, started_at, ended_at, verdict) VALUES (?,?,'anthropic',?,?,?,?)",
    projectId,
    issueId,
    status,
    clock - 500,
    clock,
    verdict,
  )
}

beforeEach(() => {
  run("DELETE FROM projects WHERE key='PARK'")
  projectId = Number(
    run("INSERT INTO projects (key, name, settings, created_at) VALUES ('PARK', 'Parking', '{}', ?)", clock).lastInsertRowid,
  )
  issueId = Number(
    run(
      "INSERT INTO issues (project_id, number, title, status, created_at, updated_at) VALUES (?, 1, 'Parked', 'backlog', ?, ?)",
      projectId,
      clock,
      clock,
    ).lastInsertRowid,
  )
})

describe('parkedRest', () => {
  test('starts at 30 minutes and doubles with every park', () => {
    assert.equal(parkedRest(issueId), 30 * MINUTE)
    park()
    assert.equal(parkedRest(issueId), 60 * MINUTE)
    park()
    park()
    assert.equal(parkedRest(issueId), 240 * MINUTE)
  })

  test('never rests longer than a day', () => {
    for (let i = 0; i < 12; i++) park()
    assert.equal(parkedRest(issueId), 24 * 60 * MINUTE)
  })

  test('starts over once a run moved the issue on', () => {
    for (let i = 0; i < 4; i++) park()
    finishedRun('review')
    assert.equal(parkedRest(issueId), 30 * MINUTE)
    park()
    assert.equal(parkedRest(issueId), 60 * MINUTE)
  })

  test('a run that ended blocked, partial or failed does not start it over', () => {
    park()
    park()
    finishedRun('blocked')
    finishedRun('partial')
    finishedRun('', 'failed')
    assert.equal(parkedRest(issueId), 120 * MINUTE)
  })
})

describe('classifyFailure, broken logins', () => {
  test('a refused login without the word OAuth is a provider login error too', () => {
    assert.equal(classifyFailure(0, 'anthropic', 'Failed to authenticate. API Error: 401').kind, 'access')
  })
})
