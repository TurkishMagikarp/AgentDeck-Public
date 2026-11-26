import './setup.ts'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createIssue, defaultSettings, patchIssue } from '../server/core.ts'
import { DATA_DIR, run } from '../server/db.ts'
import { removeFinishedBranches } from '../server/housekeeping.ts'
import { isMergedStagePullRequest, landIssue } from '../server/landing.ts'

function git(repo: string, ...args: string[]) {
  return execFileSync('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@localhost', ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function tip(repo: string, branch: string) {
  try {
    return git(repo, 'rev-parse', '--verify', `refs/heads/${branch}`)
  } catch {
    return ''
  }
}

function fixture(key: string, base: string, push = false) {
  const repo = mkdtempSync(join(tmpdir(), 'agentdeck-cleanup-'))
  git(repo, 'init', '-qb', base)
  const commit = (path: string) => {
    writeFileSync(join(repo, path), path)
    git(repo, 'add', path)
    git(repo, 'commit', '-qm', path)
  }
  commit('base.txt')
  const branch = `agentdeck/${key}-1`
  git(repo, 'switch', '-qc', branch)
  commit('issue.txt')
  git(repo, 'switch', '-q', base)

  const origin = push ? mkdtempSync(join(tmpdir(), 'agentdeck-origin-')) : ''
  if (origin) {
    git(origin, 'init', '--bare', '-q')
    git(repo, 'remote', 'add', 'origin', origin)
    git(repo, 'push', 'origin', base, branch)
  }
  const settings = defaultSettings()
  Object.assign(settings.landing, { mode: 'merge', baseBranch: base, push })
  const id = Number(run('INSERT INTO projects (key,name,repo_path,settings,created_at) VALUES (?,?,?,?,?)',
    key, key, repo, JSON.stringify(settings), Date.now()).lastInsertRowid)
  const project = { id, key, repo_path: repo, settings }
  const issue = createIssue(id, { title: 'Test change', status: 'todo' })
  return { repo, origin, branch, project, issue, commit }
}

test('a direct landing into dev removes a clean managed checkout and only the merged issue ref', async () => {
  const { repo, project, issue, branch } = fixture('DEL', 'dev')
  const worktree = join(DATA_DIR, 'worktrees', project.key, '1')
  mkdirSync(join(worktree, '..'), { recursive: true })
  git(repo, 'worktree', 'add', worktree, branch)
  git(repo, 'branch', 'feature/human')
  const old = tip(repo, branch)
  assert.equal((await landIssue(project, issue)).status, 'done')
  assert.equal(tip(repo, branch), '')
  assert.equal(existsSync(worktree), false)
  assert.ok(tip(repo, 'feature/human'))
  git(repo, 'merge-base', '--is-ancestor', old, 'dev')
})

test('pre-dev prunes both exact refs after pushing the base', async () => {
  const { repo, origin, project, issue, branch } = fixture('PRE', 'pre-dev', true)
  const old = tip(repo, branch)
  assert.equal((await landIssue(project, issue)).status, 'done')
  assert.equal(tip(repo, branch), '')
  assert.equal(tip(origin, branch), '')
  git(origin, 'merge-base', '--is-ancestor', old, 'pre-dev')
})

test('newer remote work is retained by the lease', async () => {
  const { repo, origin, project, issue, branch, commit } = fixture('LEASE', 'dev', true)
  git(repo, 'switch', '-qc', 'new-remote-work', branch)
  commit('new-work.txt')
  git(repo, 'push', 'origin', `HEAD:refs/heads/${branch}`)
  const newer = tip(origin, branch)
  git(repo, 'switch', '-q', 'dev')
  assert.equal((await landIssue(project, issue)).status, 'done')
  assert.equal(tip(origin, branch), newer)
  assert.equal(tip(repo, branch), '')
})

test('a failed base push does not delete either branch', async () => {
  const first = fixture('FAIL', 'pre-dev', true)
  const originWriter = mkdtempSync(join(tmpdir(), 'agentdeck-push-race-'))
  git(originWriter, 'clone', '-qb', 'pre-dev', first.origin, '.')
  writeFileSync(join(originWriter, 'other.txt'), 'new base')
  git(originWriter, 'add', 'other.txt')
  git(originWriter, 'commit', '-qm', 'new base')
  git(originWriter, 'push', 'origin', 'pre-dev')
  // Make the local and remote base diverge, so the ff-only pull and eventual push both fail.
  first.commit('local-base.txt')
  const old = tip(first.repo, first.branch)
  assert.equal((await landIssue(first.project, first.issue)).status, 'blocked')
  assert.equal(tip(first.repo, first.branch), old)
  assert.equal(tip(first.origin, first.branch), old)
})

test('finished cleanup catches already merged work, but leaves unmerged and dirty worktrees', async () => {
  const merged = fixture('OLD', 'pre-dev')
  git(merged.repo, 'merge', '--ff-only', merged.branch)
  patchIssue(merged.issue.id, { status: 'done' })
  const unmerged = fixture('KEEP', 'dev')
  patchIssue(unmerged.issue.id, { status: 'done' })
  const dirty = fixture('DIRTY', 'dev')
  const worktree = join(DATA_DIR, 'worktrees', dirty.project.key, '1')
  mkdirSync(join(worktree, '..'), { recursive: true })
  git(dirty.repo, 'worktree', 'add', worktree, dirty.branch)
  writeFileSync(join(worktree, 'untracked.txt'), 'unfinished work')
  assert.equal((await landIssue(dirty.project, dirty.issue)).status, 'done')
  patchIssue(dirty.issue.id, { status: 'done' })
  assert.equal(await removeFinishedBranches(), 1)
  assert.equal(tip(merged.repo, merged.branch), '')
  assert.ok(tip(unmerged.repo, unmerged.branch))
  assert.ok(tip(dirty.repo, dirty.branch))
  assert.ok(existsSync(join(worktree, 'untracked.txt')))
})

test('landings on other targets keep the previous branch behavior', async () => {
  const { repo, project, issue, branch } = fixture('MAIN', 'main')
  assert.equal((await landIssue(project, issue)).status, 'done')
  assert.ok(tip(repo, branch))
})

test('housekeeping finds a finished remote-only issue merged elsewhere without moving the local base', async () => {
  const { repo, origin, project, issue, branch } = fixture('REMOTE', 'pre-dev', true)
  const before = tip(repo, 'pre-dev')
  const writer = mkdtempSync(join(tmpdir(), 'agentdeck-manual-merge-'))
  git(writer, 'clone', '-qb', 'pre-dev', origin, '.')
  git(writer, 'merge', '--no-ff', '-m', 'manually merged elsewhere', `origin/${branch}`)
  git(writer, 'push', 'origin', 'pre-dev')
  git(repo, 'branch', '-D', branch)
  patchIssue(issue.id, { status: 'done' })
  await removeFinishedBranches()
  assert.equal(tip(origin, branch), '')
  assert.equal(tip(repo, 'pre-dev'), before)
  assert.equal(project.settings.landing.baseBranch, 'pre-dev')
})

test('PR proof requires merged state, staging target, exact head and the same push repository', () => {
  const origin = 'git@github.com:team/project.git'
  const branch = 'agentdeck/PRO-1'
  const head = 'a'.repeat(40)
  const pr = {
    state: 'MERGED', baseRefName: 'pre-dev', headRefName: branch, headRefOid: head,
    isCrossRepository: false, url: 'https://github.com/team/project/pull/42',
  }
  assert.equal(isMergedStagePullRequest(pr, branch, head, origin), true)
  assert.equal(isMergedStagePullRequest(pr, branch, head, 'https://github.com/team/project.git'), true)
  for (const patch of [
    { state: 'OPEN' }, { baseRefName: 'main' }, { headRefOid: 'b'.repeat(40) },
    { headRefName: 'feature/human' }, { isCrossRepository: true },
    { url: 'https://github.com/other/project/pull/42' },
  ]) assert.equal(isMergedStagePullRequest({ ...pr, ...patch }, branch, head, origin), false)
})
