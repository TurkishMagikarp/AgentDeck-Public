import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readyBacklog } from '../server/backlog.ts'

type Issue = Parameters<typeof readyBacklog>[0][number]
const now = 10_000
const issue = (number: number, grp: string, fields: Partial<Issue> = {}): Issue => ({
  id: number, number, grp, status: 'backlog', blocked_by: [], capped: 0,
  parked_until: 0, review_index: -1, ...fields,
})
const selected = (issues: Issue[], slots = 3, ordered = true, at = now) =>
  readyBacklog(issues, slots, ordered, at).map((i) => i.number)

test('an idle project can work on Asset pipeline while its earlier group is parked', () => {
  const issues = [
    issue(902, 'Act 1, station 7', { parked_until: now + 1 }),
    issue(898, 'Asset pipeline'), issue(899, 'Asset pipeline'), issue(697, 'Repo intake'),
  ]
  assert.deepEqual(selected(issues), [898, 899])
  assert.deepEqual(selected(issues, 3, true, now + 1), [902])
})

test('an active group is not replaced when an earlier group becomes ready', () => {
  const issues = [issue(1, 'Earlier'), issue(2, 'Later', { status: 'in_progress' }), issue(3, 'Later')]
  assert.deepEqual(selected(issues), [3])
})

test('capped and dependency-blocked tickets stay in the backlog', () => {
  const issues = [issue(1, 'A', { capped: 1 }), issue(2, 'A', { blocked_by: [1] }), issue(3, 'B')]
  assert.deepEqual(selected(issues), [3])
  assert.deepEqual(selected(issues.slice(0, 2)), [])
})

test('queued work and assigned reviews reserve slots; ungrouped work keeps priority', () => {
  const issues = [
    issue(1, '', { status: 'todo' }),
    issue(2, '', { status: 'review', review_index: 0 }),
    issue(3, ''), issue(4, 'A'), issue(5, 'B'),
  ]
  assert.deepEqual(selected(issues, 2), [])
  assert.deepEqual(selected(issues, 3), [3])
  assert.deepEqual(selected(issues, 5), [3, 4])
  assert.deepEqual(selected(issues, 5, false), [3, 4, 5])
})

test('grouped review or approval in progress preserves group order', () => {
  const issues = [issue(1, 'A', { status: 'review' }), issue(2, 'B'), issue(3, '')]
  assert.deepEqual(selected(issues), [3])
})
