import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

export const DATA_DIR = resolve(process.env.AGENTDECK_DATA ?? './data')
mkdirSync(DATA_DIR, { recursive: true })

export const db = new DatabaseSync(join(DATA_DIR, 'agentdeck.db'))

// WAL + large page cache + mmap: reads are served from RAM, writes are one fsync-free append.
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA temp_store = MEMORY;
PRAGMA cache_size = -${Number(process.env.AGENTDECK_CACHE_MB ?? 256) * 1024};
PRAGMA mmap_size = 1073741824;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  repo_path TEXT NOT NULL DEFAULT '',
  settings TEXT NOT NULL DEFAULT '{}',
  next_number INTEGER NOT NULL DEFAULT 1,
  paused INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS skills (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS agents (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT '',
  provider TEXT NOT NULL,
  model TEXT NOT NULL DEFAULT '',
  instructions TEXT NOT NULL DEFAULT '',
  skill_ids TEXT NOT NULL DEFAULT '[]',
  max_instances INTEGER NOT NULL DEFAULT 1,
  enabled INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS issues (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  number INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'backlog',
  priority INTEGER NOT NULL DEFAULT 1,
  assignee_id INTEGER REFERENCES agents(id) ON DELETE SET NULL,
  rank REAL NOT NULL DEFAULT 0,
  blocked_by TEXT NOT NULL DEFAULT '[]',
  handoff TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS issues_project ON issues(project_id, status);
CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY,
  issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  author TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'comment',
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS comments_issue ON comments(issue_id);
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  agent_id INTEGER REFERENCES agents(id) ON DELETE SET NULL,
  agent_name TEXT NOT NULL DEFAULT '',
  provider TEXT NOT NULL,
  model TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'running',
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS runs_issue ON runs(issue_id);
CREATE INDEX IF NOT EXISTS runs_provider ON runs(provider, started_at);
CREATE INDEX IF NOT EXISTS runs_project ON runs(project_id, started_at);
CREATE TABLE IF NOT EXISTS provider_auth (
  provider TEXT PRIMARY KEY,
  mode TEXT NOT NULL,
  secret TEXT,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS mcp_auth (
  id TEXT PRIMARY KEY,
  secret TEXT,
  updated_at INTEGER NOT NULL
);
-- Real subscription utilisation as reported by the CLIs themselves (e.g. Claude Code rate_limit_event).
CREATE TABLE IF NOT EXISTS quota (
  provider TEXT NOT NULL,
  window TEXT NOT NULL,
  utilization REAL NOT NULL,
  resets_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (provider, window)
);
`)

// Columns added after the first release. SQLite has no "ADD COLUMN IF NOT EXISTS".
function addColumn(table: string, column: string, definition: string) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  if (!columns.some((existing) => existing.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
  }
}

addColumn('agents', 'mcp_ids', "TEXT NOT NULL DEFAULT '[]'")
addColumn('agents', 'effort', "TEXT NOT NULL DEFAULT ''")

// Review chain: reviewers are agent ids in order. review_index is -1 while the maker works,
// otherwise the position of the reviewer whose turn it is.
addColumn('issues', 'reviewers', "TEXT NOT NULL DEFAULT '[]'")
addColumn('issues', 'review_index', 'INTEGER NOT NULL DEFAULT -1')
addColumn('issues', 'review_rounds', 'INTEGER NOT NULL DEFAULT 0')
addColumn('issues', 'maker_id', 'INTEGER')
addColumn('issues', 'grp', "TEXT NOT NULL DEFAULT ''")
addColumn('issues', 'model', "TEXT NOT NULL DEFAULT ''")
addColumn('issues', 'routine_id', 'INTEGER')
addColumn('runs', 'kind', "TEXT NOT NULL DEFAULT 'work'")
// The part of input_tokens that was read from the provider's prompt cache (about a tenth of the price).
addColumn('runs', 'cached_tokens', 'INTEGER NOT NULL DEFAULT 0')
// Landing: '' or 'waiting' while a pull request is open and its checks run.
addColumn('issues', 'landing', "TEXT NOT NULL DEFAULT ''")
addColumn('issues', 'pr_number', 'INTEGER')
// 1 once a blocked issue was handed to the project's escalation agent, so it is done only once.
addColumn('issues', 'escalated', 'INTEGER NOT NULL DEFAULT 0')
// When the issue reached "done". Empty again if it is reopened.
addColumn('issues', 'done_at', 'INTEGER')

db.exec(`
CREATE TABLE IF NOT EXISTS quota_history (
  provider TEXT NOT NULL,
  at INTEGER NOT NULL,
  utilization REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS quota_history_at ON quota_history(at);
CREATE INDEX IF NOT EXISTS issues_done ON issues(project_id, done_at);
`)

db.exec(`
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS run_log (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  at INTEGER NOT NULL,
  text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS run_log_run ON run_log(run_id);
CREATE TABLE IF NOT EXISTS secrets (name TEXT PRIMARY KEY, secret TEXT NOT NULL);
`)

db.exec(`
CREATE TABLE IF NOT EXISTS routines (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  agent_id INTEGER REFERENCES agents(id) ON DELETE SET NULL,
  prompt TEXT NOT NULL DEFAULT '',
  schedule TEXT NOT NULL DEFAULT 'daily',
  at TEXT NOT NULL DEFAULT '07:00',
  every_minutes INTEGER NOT NULL DEFAULT 60,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_fired_at INTEGER NOT NULL DEFAULT 0
);
`)

/**
 * Clean-up that is only right when the server itself starts: nothing can be running then.
 * It must never happen just because some other process opened the database. On 21 Nov 2026 a
 * check script imported this module while agents were working, and their live runs were marked
 * as failed.
 */
export function recoverAfterRestart() {
  // Issues finished before done_at existed: their last change is the best date there is.
  db.exec("UPDATE issues SET done_at=updated_at WHERE status='done' AND done_at IS NULL")
  // The output of old runs is only interesting for a while.
  db.prepare('DELETE FROM run_log WHERE at < ?').run(Date.now() - 30 * 86_400_000)
  // Runs that were alive when the process died can never finish.
  db.exec(
    "UPDATE runs SET status='failed', ended_at=started_at, note='Server neu gestartet' WHERE status='running'",
  )
  db.exec("UPDATE issues SET status='todo' WHERE status='in_progress'")
}

const stmts = new Map<string, any>()
const prep = (sql: string) => {
  let s = stmts.get(sql)
  if (!s) stmts.set(sql, (s = db.prepare(sql)))
  return s
}
export const all = <T = any>(sql: string, ...p: any[]): T[] => prep(sql).all(...p)
export const get = <T = any>(sql: string, ...p: any[]): T | undefined => prep(sql).get(...p)
export const run = (sql: string, ...p: any[]): { lastInsertRowid: number; changes: number } =>
  prep(sql).run(...p)

export function tx<T>(fn: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const r = fn()
    db.exec('COMMIT')
    return r
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}
