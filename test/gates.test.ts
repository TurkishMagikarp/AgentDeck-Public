import './setup.ts'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, test } from 'node:test'
import { defaultSettings } from '../server/core.ts'
import { get, run } from '../server/db.ts'
import { addedDependencies, DEFAULT_INFRA_GLOBS, globToRegExp, infraFiles } from '../server/gates.ts'
import { landIssue } from '../server/landing.ts'
import { approveLanding } from '../server/engine.ts'

const git = (repo: string, ...args: string[]) =>
  execFileSync('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@localhost', ...args], {
    encoding: 'utf8',
  }).trim()

function put(repo: string, files: Record<string, string>) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true })
    writeFileSync(join(repo, path), text)
  }
}

/** main with the base files, and agentdeck/<key>-<number> one commit ahead with the branch files. */
function repoWith(key: string, number: number, base: Record<string, string>, branch: Record<string, string>) {
  const repo = mkdtempSync(join(tmpdir(), 'agentdeck-gates-'))
  git(repo, 'init', '-q', '-b', 'main')
  put(repo, { 'readme.txt': 'start\n', ...base })
  git(repo, 'add', '.')
  git(repo, 'commit', '-q', '-m', 'start')
  git(repo, 'checkout', '-q', '-b', `agentdeck/${key}-${number}`)
  put(repo, branch)
  git(repo, 'add', '.')
  git(repo, 'commit', '-q', '-m', 'work')
  git(repo, 'checkout', '-q', 'main')
  return repo
}

function projectFor(repo: string, key: string, change: (s: ReturnType<typeof defaultSettings>) => void) {
  const settings = defaultSettings()
  settings.landing.mode = 'merge'
  change(settings)
  return { id: 1, key, repo_path: repo, settings }
}

let nextId = 100
/** A real issue row, so the approval can be stored on it. */
function issueRow(projectId: number, number: number) {
  const id = nextId++
  run(
    'INSERT INTO issues (id, project_id, number, title, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?)',
    id,
    projectId,
    number,
    'Work',
    'in_progress',
    Date.now(),
    Date.now(),
  )
  return { id, number, title: 'Work' }
}

function projectRow(key: string, repo: string, settings: object) {
  const { lastInsertRowid } = run(
    'INSERT INTO projects (key, name, repo_path, settings, created_at) VALUES (?,?,?,?,?)',
    key,
    key,
    repo,
    JSON.stringify(settings),
    Date.now(),
  )
  return Number(lastInsertRowid)
}

describe('infrastructure globs', () => {
  const infra = (files: string[]) => infraFiles(files, DEFAULT_INFRA_GLOBS)

  test('the defaults catch container, CI, terraform, kubernetes and compose files', () => {
    const files = [
      'Dockerfile',
      'services/api/Dockerfile',
      'docker/sandbox.sh',
      '.github/workflows/ci.yml',
      'infra/main.tf',
      'k8s/deploy.yaml',
      'compose.prod.yml',
      'deploy/docker-compose.yml',
    ]
    assert.deepEqual(infra(files), files)
  })

  test('ordinary files and look-alikes deeper down pass', () => {
    assert.deepEqual(infra(['src/app.ts', 'README.md', 'src/docker/notes.md', 'web/k8s/readme.md', 'tf.md']), [])
  })

  test('glob characters are literal except * ? and **', () => {
    assert.equal(globToRegExp('a+b.txt').test('aab.txt'), false)
    assert.equal(globToRegExp('a+b.txt').test('x/a+b.txt'), true)
    assert.equal(globToRegExp('src/**/*.sql').test('src/db/m/1.sql'), true)
    assert.equal(globToRegExp('src/**/*.sql').test('src/1.sql'), true)
    assert.equal(globToRegExp('src/*.sql').test('src/db/1.sql'), false)
    assert.equal(globToRegExp('deploy/').test('deploy/x/y'), true)
    assert.equal(globToRegExp('/Makefile').test('sub/Makefile'), false)
  })
})

describe('new dependencies', () => {
  test('package.json: a new package counts, a version bump does not', () => {
    const before = JSON.stringify({ dependencies: { hono: '^4.0.0' } })
    const bump = JSON.stringify({ dependencies: { hono: '^4.6.0' } })
    const added = JSON.stringify({ dependencies: { hono: '^4.0.0' }, devDependencies: { leftpad: '1' } })
    assert.deepEqual(addedDependencies('package.json', before, bump), [])
    assert.deepEqual(addedDependencies('web/package.json', before, added), ['leftpad'])
    assert.deepEqual(addedDependencies('package.json', '', before), ['hono'])
  })

  test('a manifest that cannot be read counts as a new dependency', () => {
    assert.equal(addedDependencies('package.json', '{}', '{ broken').length, 1)
  })

  test('requirements files compare names, not versions', () => {
    const before = 'requests==2.0\n# comment\nDjango>=4\n'
    const after = 'requests==2.31  # bumped\ndjango>=5\n-r base.txt\nnumpy[extra]>=1; python_version>"3"\n-e git+https://x/y.git#egg=mylib\n'
    assert.deepEqual(addedDependencies('requirements-dev.txt', before, after).sort(), ['mylib', 'numpy'])
  })

  test('pyproject: PEP 621 lists and poetry tables', () => {
    const before = '[project]\nname = "x"\ndependencies = [\n  "requests>=2",\n]\n'
    const after =
      '[project]\nname = "x"\ndependencies = [\n  "requests>=3",  # bump\n  "httpx",\n]\n[project.optional-dependencies]\ndev = ["pytest"]\n[tool.poetry.dependencies]\npython = "^3.11"\nrich = "^13"\n'
    assert.deepEqual(addedDependencies('pyproject.toml', before, after).sort(), ['httpx', 'pytest', 'rich'])
  })

  test('Cargo.toml: keys and dependency tables', () => {
    const before = '[package]\nname = "x"\n\n[dependencies]\nserde = "1"\n'
    const after =
      '[package]\nname = "x"\nversion = "2"\n\n[dependencies]\nserde = { version = "1.1" }\n\n[dev-dependencies.proptest]\nversion = "1"\n\n[target.\'cfg(unix)\'.dependencies]\nlibc = "0.2"\n'
    assert.deepEqual(addedDependencies('Cargo.toml', before, after).sort(), ['libc', 'proptest'])
  })

  test('go.mod: single and block requires', () => {
    const before = 'module x\n\nrequire github.com/a/b v1.0.0\n'
    const after = 'module x\n\nrequire (\n\tgithub.com/a/b v1.2.0\n\tgolang.org/x/sync v0.1.0 // indirect\n)\n'
    assert.deepEqual(addedDependencies('go.mod', before, after), ['golang.org/x/sync'])
  })

  test('Gemfile and composer.json', () => {
    assert.deepEqual(addedDependencies('Gemfile', "gem 'rails', '~> 7'\n", "gem 'rails', '~> 8'\ngem \"pg\"\n"), ['pg'])
    assert.deepEqual(
      addedDependencies('composer.json', '{"require":{"php":">=8"}}', '{"require":{"php":">=8.2"},"require-dev":{"phpunit/phpunit":"^10"}}'),
      ['phpunit/phpunit'],
    )
  })

  test('other files are no manifests', () => {
    assert.deepEqual(addedDependencies('package-lock.json', '{}', '{"dependencies":{"x":{}}}'), [])
  })
})

describe('gates at landing', () => {
  test('a branch that adds a dependency waits for the owner, a bump lands', async () => {
    const pkg = (deps: object) => JSON.stringify({ dependencies: deps })
    const added = repoWith('G', 1, { 'package.json': pkg({ a: '1' }) }, { 'package.json': pkg({ a: '1', b: '1' }) })
    const project = projectFor(added, 'G', (s) => (s.landing.approval.dependencies = true))
    const before = git(added, 'rev-parse', 'main')
    const held = await landIssue(project, { id: 1, number: 1, title: 'x' })
    assert.equal(held.status, 'blocked')
    assert.equal(held.needsOwner, true)
    assert.equal(held.gate?.sha, git(added, 'rev-parse', 'agentdeck/G-1'))
    assert.match(held.note, /new dependencies: b \(package\.json\)/)
    assert.equal(git(added, 'rev-parse', 'main'), before)

    const bumped = repoWith('G', 1, { 'package.json': pkg({ a: '1' }) }, { 'package.json': pkg({ a: '2' }) })
    const outcome = await landIssue(projectFor(bumped, 'G', (s) => (s.landing.approval.dependencies = true)), {
      id: 1,
      number: 1,
      title: 'x',
    })
    assert.equal(outcome.status, 'done')
  })

  test('infrastructure files wait only while the rule is on', async () => {
    const repo = repoWith('H', 1, {}, { '.github/workflows/ci.yml': 'on: push\n' })
    const on = await landIssue(projectFor(repo, 'H', (s) => (s.landing.approval.infra = true)), { id: 1, number: 1, title: 'x' })
    assert.equal(on.status, 'blocked')
    assert.match(on.note, /infrastructure files: \.github\/workflows\/ci\.yml/)
    const off = await landIssue(projectFor(repo, 'H', () => {}), { id: 1, number: 1, title: 'x' })
    assert.equal(off.status, 'done')
  })

  test('protected paths are a gate too and name the commit', async () => {
    const repo = repoWith('P', 1, {}, { 'CLAUDE.md': 'rules\n' })
    const held = await landIssue(projectFor(repo, 'P', (s) => (s.landing.protectedPaths = ['CLAUDE.md'])), {
      id: 1,
      number: 1,
      title: 'x',
    })
    assert.equal(held.status, 'blocked')
    assert.ok(held.gate?.sha)
    assert.match(held.note, /protected files: CLAUDE\.md/)
  })

  test('an approval lets exactly the approved commit land, once', async () => {
    const repo = repoWith('A', 1, {}, { 'feature.txt': 'x\n' })
    const project = projectFor(repo, 'A', (s) => (s.landing.approval.merge = true))
    const issue = issueRow(projectRow('A', repo, project.settings), 1)
    const tip = git(repo, 'rev-parse', 'agentdeck/A-1')

    // An approval of another commit is void, and used up.
    run('UPDATE issues SET approved_sha=? WHERE id=?', 'f'.repeat(40), issue.id)
    const held = await landIssue(project, issue)
    assert.equal(held.status, 'blocked')
    assert.match(held.note, /every landing/)
    assert.equal(get('SELECT approved_sha FROM issues WHERE id=?', issue.id).approved_sha, '')

    run('UPDATE issues SET approved_sha=? WHERE id=?', tip, issue.id)
    const landed = await landIssue(project, issue)
    assert.equal(landed.status, 'done')
    assert.equal(git(repo, 'show', 'main:feature.txt'), 'x')
    assert.equal(get('SELECT approved_sha FROM issues WHERE id=?', issue.id).approved_sha, '')
  })

  test('a branch that moved after the approval waits again', async () => {
    const repo = repoWith('M', 1, {}, { 'feature.txt': 'x\n' })
    const project = projectFor(repo, 'M', (s) => (s.landing.approval.merge = true))
    const issue = issueRow(projectRow('M', repo, project.settings), 1)
    run('UPDATE issues SET approved_sha=? WHERE id=?', git(repo, 'rev-parse', 'agentdeck/M-1'), issue.id)
    git(repo, 'checkout', '-q', 'agentdeck/M-1')
    put(repo, { 'later.txt': 'sneaked in\n' })
    git(repo, 'add', '.')
    git(repo, 'commit', '-q', '-m', 'later')
    git(repo, 'checkout', '-q', 'main')

    const held = await landIssue(project, issue)
    assert.equal(held.status, 'blocked')
    assert.equal(held.gate?.sha, git(repo, 'rev-parse', 'agentdeck/M-1'))
    assert.throws(() => git(repo, 'show', 'main:later.txt'))
  })
})

describe('approving a held landing', () => {
  test('only the held commit can be approved, then it lands', async () => {
    const repo = repoWith('AP', 4, {}, { 'feature.txt': 'x\n' })
    const settings = defaultSettings()
    settings.landing.mode = 'merge'
    settings.landing.approval.merge = true
    const projectId = projectRow('AP', repo, settings)
    const issue = issueRow(projectId, 4)
    const tip = git(repo, 'rev-parse', 'agentdeck/AP-4')
    run("UPDATE issues SET status='blocked', landing='approval', gate_sha=? WHERE id=?", tip, issue.id)

    await assert.rejects(approveLanding(issue.id, 'a'.repeat(40), 'Owner'), /moved/)
    assert.equal(get('SELECT approved_sha FROM issues WHERE id=?', issue.id).approved_sha, '')

    await approveLanding(issue.id, tip, 'Owner')
    await assert.rejects(approveLanding(issue.id, tip, 'Owner'), /does not wait for an approval/)
    // The landing runs in the background; its note marks the end.
    const landed = () => get("SELECT 1 FROM comments WHERE issue_id=? AND body LIKE 'Landed in main%'", issue.id)
    for (let i = 0; i < 200 && !landed(); i++) await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(git(repo, 'show', 'main:feature.txt'), 'x')
    const row = get('SELECT status, landing, approved_sha FROM issues WHERE id=?', issue.id)
    assert.deepEqual({ ...row }, { status: 'done', landing: '', approved_sha: '' })
  })
})

