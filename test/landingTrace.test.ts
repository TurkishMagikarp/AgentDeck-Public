import './setup.ts'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { defaultSettings } from '../server/core.ts'
import { run } from '../server/db.ts'
import { buildDossier, projectFeed } from '../server/dossier.ts'
import { landIssue } from '../server/landing.ts'
import { traceOf } from '../server/landingTrace.ts'

const git = (repo: string, ...args: string[]) =>
  execFileSync('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@localhost', ...args], {
    encoding: 'utf8',
  }).trim()

function repoWithIssueBranch() {
  const repo = mkdtempSync(join(tmpdir(), 'agentdeck-trace-'))
  git(repo, 'init', '-q', '-b', 'main')
  writeFileSync(join(repo, 'readme.txt'), 'start\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-q', '-m', 'start')
  git(repo, 'checkout', '-q', '-b', 'agentdeck/LT-1')
  writeFileSync(join(repo, 'feature.txt'), 'feature\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-q', '-m', 'feature')
  git(repo, 'checkout', '-q', 'main')
  return repo
}

function seed(repo: string, command: string) {
  run("INSERT INTO projects (id, key, name, created_at) VALUES (31, 'LT', 'Trace', 0)")
  run("INSERT INTO issues (id, project_id, number, title, created_at, updated_at) VALUES (31, 31, 1, 'Feature', 0, 0)")
  const settings = defaultSettings()
  settings.landing.mode = 'merge'
  settings.precheck = { enabled: true, command, quickCommand: '', timeoutMin: 1, commandAt: 'landing' }
  return { id: 31, key: 'LT', repo_path: repo, settings }
}

test('a landing writes every step it takes, visible in the dossier and the feed', async () => {
  const repo = repoWithIssueBranch()
  const project = seed(repo, 'test -f feature.txt')
  const outcome = await landIssue(project, { id: 31, number: 1, title: 'Feature' } as any)
  assert.equal(outcome.status, 'done')

  const steps = traceOf(31).map((t) => t.step)
  for (const expected of ['queued', 'start', 'files', 'secrets', 'merge', 'check', 'advance', 'done'])
    assert.ok(steps.includes(expected), `step ${expected} missing in ${steps.join(',')}`)
  assert.ok(traceOf(31).some((t) => t.step === 'files' && t.text.includes('feature.txt')))
  assert.ok(traceOf(31).some((t) => t.step === 'check' && t.level === 'ok'))

  const dossier = buildDossier(31)!
  assert.ok(dossier.steps.some((s) => s.key.startsWith('landing:') && s.kind === 'landing-ok'))
  assert.ok(projectFeed(31).some((i) => i.kind === 'landing' && i.text.includes('gelandet')))
})

test('a red check is traced as bad and names the failing line', async () => {
  const repo = repoWithIssueBranch()
  // Same branch name and ids: a fresh issue row keeps this case apart from the first.
  run("INSERT INTO issues (id, project_id, number, title, created_at, updated_at) VALUES (32, 31, 1, 'Again', 0, 0)")
  const project = { ...seed2(repo) }
  const outcome = await landIssue(project, { id: 32, number: 1, title: 'Again' } as any)
  assert.equal(outcome.status, 'todo')
  const bad = traceOf(32).find((t) => t.step === 'check' && t.level === 'bad')
  assert.ok(bad, 'red check not traced')
  assert.ok(!traceOf(32).some((t) => t.step === 'advance'), 'base must not advance on a red check')
})

function seed2(repo: string) {
  const settings = defaultSettings()
  settings.landing.mode = 'merge'
  settings.precheck = { enabled: true, command: 'echo broken && exit 3', quickCommand: '', timeoutMin: 1, commandAt: 'landing' }
  return { id: 31, key: 'LT', repo_path: repo, settings }
}
