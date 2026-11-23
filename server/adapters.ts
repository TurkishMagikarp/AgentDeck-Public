import { spawn, execFile, execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { globSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { startApiRun } from './apiAgent.ts'
import { apiKey, getAccess, runEnv } from './auth.ts'
import { EFFORTS, PROVIDERS, MODEL_RE } from './core.ts'
import { startManagedRun } from './managedAgent.ts'
import { prepareMcp } from './mcp.ts'
import { run } from './db.ts'

/**
 * input counts everything the model read, cached or not. An agent sends its whole context
 * again with every step, so most of a long run's input is cache reads; `cached` says how much.
 */
export type Usage = { input: number; output: number; cost: number; cached?: number }
export type RunResult = { ok: boolean; text: string; usage: Usage; error?: string }
export type RunHandle = { kill(): void; done: Promise<RunResult> }
export type RunOpts = {
  provider: string
  model?: string
  cwd: string
  prompt: string
  /** true: the agent may edit files and run commands without asking. false: read-only one-shot. */
  autonomous: boolean
  /** Ids of the MCP connections this run may use. */
  mcp?: string[]
  /** Reasoning effort, '' for the CLI default. */
  effort?: string
  /** Extra environment for the agent process, e.g. the address and token of the agent API. */
  env?: Record<string, string>
  onActivity?: (line: string) => void
}

/**
 * Codex sends its whole context again with every step, and long runs take 30 to 90 steps. Left
 * alone it compacts only near its window of about 475k tokens; compacting earlier keeps each step
 * small. Measured runs peaked at 90k to 136k tokens per step.
 */
const CODEX_COMPACT_TOKENS = Number(process.env.AGENTDECK_CODEX_COMPACT_TOKENS) || 100_000

const short = (s: string, n = 160) => (s.length > n ? s.slice(0, n) + '…' : s).replace(/\s+/g, ' ')

function command(cli: string, o: RunOpts): [string, string[]] {
  const m = (o.model ?? '').trim()
  if (!MODEL_RE.test(m)) throw new Error('Invalid model name')
  const effort = EFFORTS.includes(o.effort ?? '') ? (o.effort ?? '') : ''
  if (cli === 'claude')
    return [
      'claude',
      [
        '-p',
        '--output-format',
        'stream-json',
        '--verbose',
        ...(o.autonomous ? ['--permission-mode', 'bypassPermissions'] : []),
        ...(m ? ['--model', m] : []),
        ...(effort ? ['--effort', effort] : []),
      ],
    ]
  if (cli === 'codex')
    return [
      'codex',
      [
        'exec',
        '--json',
        '--skip-git-repo-check',
        ...(o.autonomous ? ['--dangerously-bypass-approvals-and-sandbox'] : ['-s', 'read-only']),
        ...(m ? ['-m', m] : []),
        // Codex has no "max"; its highest level is xhigh.
        ...(effort ? ['-c', `model_reasoning_effort='${effort === 'max' ? 'xhigh' : effort}'`] : []),
        '-c',
        `model_auto_compact_token_limit=${CODEX_COMPACT_TOKENS}`,
        '-',
      ],
    ]
  return [
    'opencode',
    ['run', '--format', 'json', ...(o.autonomous ? ['--auto'] : []), ...(m ? ['-m', m] : [])],
  ]
}

type State = {
  text: string
  usage: Usage
  ok: boolean
  error?: string
  sawResult: boolean
  codexThread?: string
}

const lastQuotaReading = new Map<string, { at: number; utilization: number }>()

export function saveQuota(provider: string, window: string, utilization: number, resetsAt: number | null) {
  const now = Date.now()
  run(
    'INSERT OR REPLACE INTO quota (provider, window, utilization, resets_at, updated_at) VALUES (?,?,?,?,?)',
    provider,
    window,
    utilization,
    resetsAt,
    now,
  )

  // For the dashboard: the strictest window of a provider over time, at most one reading
  // every ten minutes. Several windows arrive together, so a higher one may raise the reading.
  const last = lastQuotaReading.get(provider)
  if (last && now - last.at < 600_000 && utilization <= last.utilization) return
  if (last && now - last.at < 600_000) {
    run('UPDATE quota_history SET utilization=? WHERE provider=? AND at=?', utilization, provider, last.at)
    last.utilization = utilization
    return
  }
  run('INSERT INTO quota_history (provider, at, utilization) VALUES (?,?,?)', provider, now, utilization)
  lastQuotaReading.set(provider, { at: now, utilization })
}

/**
 * Codex does not print its rate limits, but it records them in the session file of each run.
 * We read the newest entry after the run to learn how much of the subscription is left.
 */
export function readCodexQuota(provider: string, threadId: string, codexHome: string) {
  const [file] = globSync(`sessions/*/*/*/rollout-*-${threadId}.jsonl`, { cwd: codexHome })
  if (!file) return

  const lines = readFileSync(join(codexHome, file), 'utf8').trimEnd().split('\n')
  const lastWithLimits = lines.findLast((line) => line.includes('"rate_limits"'))
  if (!lastWithLimits) return

  const found = findKey(JSON.parse(lastWithLimits), 'rate_limits')
  for (const name of ['primary', 'secondary']) {
    const window = found?.[name]
    if (typeof window?.used_percent !== 'number') continue
    const resetsAt = window.resets_at ? window.resets_at * 1000 : null
    saveQuota(provider, `${window.window_minutes ?? name}min`, window.used_percent / 100, resetsAt)
  }
}

function findKey(value: any, key: string): any {
  if (!value || typeof value !== 'object') return undefined
  if (key in value) return value[key]
  for (const child of Object.values(value)) {
    const found = findKey(child, key)
    if (found) return found
  }
}

function parse(cli: string, provider: string, e: any, st: State, act: (s: string) => void) {
  if (cli === 'claude') {
    if (e.type === 'assistant') {
      for (const c of e.message?.content ?? []) {
        if (c.type === 'text' && c.text) act((st.text = c.text))
        else if (c.type === 'tool_use') act(`${c.name}: ${JSON.stringify(c.input ?? {})}`)
      }
    } else if (e.type === 'rate_limit_event') {
      const w = e.rate_limit_info?.unifiedWindows ?? {}
      for (const k of Object.keys(w))
        if (typeof w[k]?.utilization === 'number')
          saveQuota(provider, k, w[k].utilization, w[k].resetsAt ? w[k].resetsAt * 1000 : null)
    } else if ('total_cost_usd' in e) {
      const u = e.usage ?? {}
      st.usage = {
        input:
          (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
        output: u.output_tokens ?? 0,
        cost: e.total_cost_usd ?? 0,
        cached: u.cache_read_input_tokens ?? 0,
      }
      if (typeof e.result === 'string' && e.result) st.text = e.result
      st.sawResult = true
      st.ok = !e.is_error
      if (e.is_error) st.error = short(String(e.result ?? e.subtype ?? 'error'), 400)
    }
  } else if (cli === 'codex') {
    const it = e.item
    if (e.type === 'thread.started') st.codexThread = e.thread_id
    else if (it?.type === 'agent_message' && e.type === 'item.completed') act((st.text = it.text ?? ''))
    else if (it?.type === 'command_execution' && e.type === 'item.started') act(`$ ${it.command ?? ''}`)
    else if (it && e.type === 'item.started') act(String(it.type))
    else if (e.type === 'turn.completed') {
      st.usage.input += e.usage?.input_tokens ?? 0
      st.usage.cached = (st.usage.cached ?? 0) + (e.usage?.cached_input_tokens ?? 0)
      st.usage.output += (e.usage?.output_tokens ?? 0) + (e.usage?.reasoning_output_tokens ?? 0)
      st.sawResult = true
    } else if (e.type === 'turn.failed' || e.type === 'error') {
      st.ok = false
      st.error = short(String(e.error?.message ?? e.message ?? 'error'), 400)
    }
  } else {
    const p = e.part ?? {}
    if (e.type === 'text' && p.text) act((st.text = p.text))
    else if (e.type === 'tool_use') act(`${p.tool ?? 'tool'}: ${JSON.stringify(p.state?.input ?? {})}`)
    else if (e.type === 'step_finish') {
      st.usage.input += (p.tokens?.input ?? 0) + (p.tokens?.cache?.read ?? 0) + (p.tokens?.cache?.write ?? 0)
      st.usage.cached = (st.usage.cached ?? 0) + (p.tokens?.cache?.read ?? 0)
      st.usage.output += (p.tokens?.output ?? 0) + (p.tokens?.reasoning ?? 0)
      st.usage.cost += p.cost ?? 0
      st.sawResult = true
    } else if (e.type === 'error') {
      st.ok = false
      st.error = short(String(e.error?.data?.message ?? e.error?.message ?? e.message ?? 'error'), 400)
    }
  }
}

const quoteForCmd = (arg: string) => (/^[w./:=@-]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '\\"')}"`)

function killTree(pid: number | undefined) {
  if (!pid) return
  if (process.platform === 'win32') execFile('taskkill', ['/pid', String(pid), '/T', '/F'], () => {})
  else {
    try {
      process.kill(-pid, 'SIGTERM')
    } catch {}
  }
}

export function startRun(o: RunOpts): RunHandle {
  const cli = PROVIDERS[o.provider]?.cli
  if (!cli) throw new Error(`Unknown provider ${o.provider}`)
  if (cli === 'mock') return mockRun(o)
  if (cli === 'api') {
    const key = apiKey(o.provider)
    if (!key) throw new Error('No API key stored for this provider')
    const model = o.model?.trim() || PROVIDERS[o.provider].defaultModel
    return startApiRun(o, PROVIDERS[o.provider].baseUrl!, key, model)
  }
  if (cli === 'managed') {
    const model = o.model?.trim() || PROVIDERS[o.provider].defaultModel
    if (!MODEL_RE.test(model)) throw new Error('Invalid model name')
    return startManagedRun(o, model)
  }
  const [cmd, baseArgs] = command(cli, o)
  const mcp = prepareMcp(cli, o.mcp ?? [], randomUUID())
  const env = { ...runEnv(o.provider, cli), ...mcp.env, ...o.env }

  // Codex reads the prompt from stdin when its last argument is "-", so extra flags go in front of it.
  const args = cli === 'codex' ? [...baseArgs.slice(0, -1), ...mcp.args, '-'] : [...baseArgs, ...mcp.args]

  const win = process.platform === 'win32'
  // On Windows the CLIs are .cmd shims and need a shell. Arguments are fixed flags, a validated
  // model name or values we built ourselves; anything with special characters gets quoted.
  const child = win
    ? spawn([cmd, ...args.map(quoteForCmd)].join(' '), { cwd: o.cwd, env, shell: true, windowsHide: true })
    : spawn(cmd, args, { cwd: o.cwd, env, detached: true })
  child.on('close', mcp.cleanup)
  const st: State = { text: '', usage: { input: 0, output: 0, cost: 0 }, ok: true, sawResult: false }
  const act = (s: string) => o.onActivity?.(short(s, 1200))
  let stderr = ''
  child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-2000)))
  createInterface({ input: child.stdout }).on('line', (line) => {
    if (line[0] !== '{') return
    try {
      parse(cli, o.provider, JSON.parse(line), st, act)
    } catch {}
  })
  child.stdin.on('error', () => {})
  child.stdin.end(o.prompt)
  const done = new Promise<RunResult>((resolve) => {
    child.on('error', (err) =>
      resolve({
        ok: false,
        text: st.text,
        usage: st.usage,
        error: `${cmd} failed to start: ${err.message}`,
      }),
    )
    child.on('close', (code) => {
      if (st.codexThread && getAccess(o.provider).mode === 'subscription') {
        try {
          readCodexQuota(o.provider, st.codexThread, env.CODEX_HOME ?? join(homedir(), '.codex'))
        } catch {
          // The quota is a bonus; a run must not fail because the session file looks different.
        }
      }
      const ok = st.ok && st.sawResult && code === 0
      resolve({
        ok,
        text: st.text,
        usage: st.usage,
        error: ok ? undefined : (st.error ?? (short(stderr.trim(), 400) || `exit code ${code}`)),
      })
    })
  })
  return { kill: () => killTree(child.pid), done }
}

/** Read-only single question, used for watchdog reviews and blueprint generation. */
export const oneShot = (provider: string, prompt: string, cwd: string, model = '') =>
  startRun({ provider, model, prompt, cwd, autonomous: false }).done

/**
 * Stands in for a real agent in tests. Markers in the issue text steer it:
 * "[mock:changes]" makes a reviewer ask for changes, "[mock:create]" makes a worker file an issue
 * through the board commands, exactly as a real agent would. "[mock:commit:<path>]" makes a worker
 * commit that file, so landing can be tested. "[mock:fail:<message>]" makes a run fail with that
 * message until the self-healing has left a hint on the issue.
 */
function mockAnswer(o: RunOpts) {
  if (!o.autonomous) return 'PASS'
  if (o.prompt.includes('## Your task: review')) {
    // A reviewer that forgets its status block, as real ones sometimes do.
    if (o.prompt.includes('[mock:nostatus]'))
      return '<summary>Approved: checked, just without a status block (Mock).</summary>'
    // "[mock:changes:QA]": only the reviewer of that name asks for changes.
    const onlyReviewer = o.prompt.match(/\[mock:changes:([^\]]+)\]/)?.[1]
    const asksForChanges = onlyReviewer
      ? o.prompt.includes(`You are "${onlyReviewer}"`)
      : o.prompt.includes('[mock:changes]')
    return asksForChanges
      ? '<summary>Changes: test missing (mock).</summary>\n<status>changes</status>'
      : '<summary>Approved: checked (mock).</summary>\n<status>approve</status>'
  }
  if (o.prompt.includes('[mock:waitfor]')) {
    const other = o.prompt.match(/\[mock:waitfor\]\s*([A-Z][A-Z0-9]*-\d+)/)?.[1] ?? ''
    return `<summary>Blocked: waits for ${other} (mock).</summary>\n<handoff>Waiting.</handoff>\n<status>blocked</status>`
  }
  return `${mockChecklist(o.prompt)}<summary>Mock run: task done (simulated).</summary>\n<handoff>Nothing open. Changed: no files (mock).</handoff>\n<status>review</status>`
}

/** The report on the acceptance checklist: all items met, or the first open with "[mock:partial]". */
function mockChecklist(prompt: string) {
  const list = prompt.match(/## Acceptance checklist\n[^\n]*\n((?:\d+\. [^\n]*\n?)+)/)?.[1]
  if (!list) return ''
  const count = list.trim().split('\n').length
  const lines = Array.from({ length: count }, (_, index) =>
    index === 0 && prompt.includes('[mock:partial]')
      ? '1. open: still missing'
      : `${index + 1}. ok: checked (mock)`,
  )
  return `<checklist>\n${lines.join('\n')}\n</checklist>\n`
}

function mockRun(o: RunOpts): RunHandle {
  let timer: NodeJS.Timeout
  let finish: (r: RunResult) => void
  const steps = ['Reading issue…', 'Read: src/index.ts', '$ npm test', 'Writing summary…']

  if (o.prompt.includes('[mock:create]') && o.env?.AGENTDECK_CLI) {
    const args = [o.env.AGENTDECK_CLI, 'create', '--title', 'Filed by the mock agent', '--status', 'backlog']
    execFile(process.execPath, args, { env: { ...process.env, ...o.env } }, () => {})
  }

  const unblock = o.prompt.match(/\[mock:unblock:(\d+):(\d+)\]/)
  if (unblock && o.env?.AGENTDECK_CLI) {
    const args = [o.env.AGENTDECK_CLI, 'unblock', unblock[1], unblock[2]]
    execFile(process.execPath, args, { env: { ...process.env, ...o.env } }, () => {})
  }

  const fileToCommit = o.prompt.match(/\[mock:commit:([\w./-]+)\]/)?.[1]
  if (fileToCommit && o.autonomous && !o.prompt.includes('## Your task: review')) {
    const title = o.prompt.match(/## Issue [^\n]*/)?.[0] ?? 'mock'
    const file = join(o.cwd, fileToCommit)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, title + '\n')
    const identity = ['-c', 'user.name=Mock', '-c', 'user.email=mock@localhost']
    execFileSync('git', ['-C', o.cwd, 'add', '-A'])
    execFileSync('git', [
      '-C',
      o.cwd,
      ...identity,
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      `mock: ${fileToCommit}`,
    ])
  }

  const done = new Promise<RunResult>((resolve) => {
    finish = resolve
    let i = 0
    timer = setInterval(
      () => {
        if (i < steps.length) return o.onActivity?.(steps[i++])
        clearInterval(timer)
        const failWith = o.prompt.match(/\[mock:fail:([^\]]+)\]/)?.[1]
        if (failWith && o.autonomous && !o.prompt.includes('**Self-healing:**')) {
          return resolve({ ok: false, text: '', usage: { input: 100, output: 0, cost: 0 }, error: failWith })
        }
        resolve({ ok: true, text: mockAnswer(o), usage: { input: 1200, output: 300, cost: 0.01 } })
      },
      Number(process.env.AGENTDECK_MOCK_MS ?? 800),
    )
  })
  return {
    kill: () => {
      clearInterval(timer)
      finish({ ok: false, text: '', usage: { input: 0, output: 0, cost: 0 }, error: 'stopped' })
    },
    done,
  }
}
