import './setup.ts'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { prepareWorkdir } from '../server/workspace.ts'

const git = (repo: string, ...args: string[]) =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim()

function repo() {
  const base = mkdtempSync(join(tmpdir(), 'agentdeck-repo-'))
  git(base, 'init', '-q', '-b', 'main')
  git(base, 'config', 'user.email', 'test@example.invalid')
  git(base, 'config', 'user.name', 'Test')
  writeFileSync(join(base, 'README.md'), 'hello\n')
  git(base, 'add', '.')
  git(base, 'commit', '-q', '-m', 'start')
  return base
}

const project = (key: string, base: string) => ({ key, repo_path: base, settings: { workspace: 'agent' as const } })

describe('agent checkouts', () => {
  test('a branch another slot still holds is taken back, its leftovers go to a stash', async () => {
    const base = repo()
    const p = project('WSA', base)
    const first = await prepareWorkdir({ project: p, issueNumber: 7, agentId: 1, slot: 1, readOnly: false })
    writeFileSync(join(first.cwd, 'left.txt'), 'unfinished\n')
    // The run in slot 1 ended without letting go of the branch. The next run lands in slot 0.
    const second = await prepareWorkdir({ project: p, issueNumber: 7, agentId: 1, slot: 0, readOnly: false })

    assert.equal(git(second.cwd, 'branch', '--show-current'), 'agentdeck/WSA-7')
    assert.equal(git(first.cwd, 'branch', '--show-current'), '')
    assert.match(git(base, 'stash', 'list'), /agentdeck: before releasing agentdeck\/WSA-7/)
  })

  test('a reviewer does not take the branch from the maker', async () => {
    const base = repo()
    const p = project('WSB', base)
    const maker = await prepareWorkdir({ project: p, issueNumber: 3, agentId: 1, slot: 0, readOnly: false })
    await prepareWorkdir({ project: p, issueNumber: 3, agentId: 2, slot: 0, readOnly: true })

    assert.equal(git(maker.cwd, 'branch', '--show-current'), 'agentdeck/WSB-3')
  })
})
