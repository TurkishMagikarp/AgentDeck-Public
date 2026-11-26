import { spawn, execFile, execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { globSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createInterface } from 'node:readline'
import { startApiRun } from './apiAgent.ts'
import { apiKey, getAccess, runEnv } from './auth.ts'
import { EFFORTS, PROVIDERS, MODEL_RE } from './core.ts'
import { startManagedRun } from './managedAgent.ts'
import { currentLang, t, tIn, variants, withLang } from './i18n.ts'
import { prepareMcp } from './mcp.ts'
import { DATA_DIR, run } from './db.ts'
import type { TraceEvent } from './runEvents.ts'
import { rtkInstalled, RTK_INSTRUCTIONS, withRtkPlugin } from './rtk.ts'
import { execIn, homeOf, loginsIn, loginsOut, ownerOf, placeInHome, removeFromHome, SANDBOX, spawnIn, stopGroup, syncCommandIn } from './sandbox.ts'

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
  /** The parsed steps of the run for its replay (runEvents.ts): messages, tool calls, results. */
  onEvent?: (event: TraceEvent) => void
}

/**
 * Codex sends its whole context again with every step, and long runs take 30 to 90 steps. Left
 * alone it compacts only near its window of about 475k tokens; compacting earlier keeps each step
 * small. Measured runs peaked at 90k to 136k tokens per step.
 */
const CODEX_COMPACT_TOKENS = Number(process.env.AGENTDECK_CODEX_COMPACT_TOKENS) || 100_000

/**
 * opencode compacts only when the model's window is full, and DeepSeek Flash has a window of a
 * million tokens: measured runs never compacted and reached 360k tokens per step. opencode has
 * no threshold setting, so the run gets a smaller window for its model instead. It compacts at
 * the window minus the output limit, which makes this number the threshold. 0 switches it off.
 */
const OPENCODE_COMPACT_TOKENS = Number(process.env.AGENTDECK_OPENCODE_COMPACT_TOKENS ?? 100_000)
const OPENCODE_OUTPUT_TOKENS = 32_000

/** Exported for the tests. `model` is opencode's "provider/model". */
export function withContextLimit(
  content: string | undefined,
  model: string,
  threshold = OPENCODE_COMPACT_TOKENS,
) {
  const slash = model.indexOf('/')
  if (!threshold || slash < 1) return content
  const [provider, id] = [model.slice(0, slash), model.slice(slash + 1)]
  const config = content ? JSON.parse(content) : {}
  const models = config.provider?.[provider]?.models ?? {}
  const limit = { context: threshold + OPENCODE_OUTPUT_TOKENS, output: OPENCODE_OUTPUT_TOKENS }
  return JSON.stringify({
    ...config,
    provider: {
      ...config.provider,
      [provider]: { ...config.provider?.[provider], models: { ...models, [id]: { ...models[id], limit } } },
    },
  })
}

const hasStatus = (text: string) => /<status>/i.test(text)

const short = (s: string, n = 160) => (s.length > n ? s.slice(0, n) + '…' : s).replace(/\s+/g, ' ')

function command(cli: string, o: RunOpts): [string, string[]] {
  const m = (o.model ?? '').trim()
  if (!MODEL_RE.test(m)) throw new Error(t('Ungültiger Modellname'))
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
    [
      'run',
      '--format',
      'json',
      ...(o.autonomous ? ['--auto'] : []),
      ...(m ? ['-m', m] : []),
      // The effort is the model's variant; opencode ignores one the model does not have.
      ...(effort ? ['--variant', effort] : []),
    ],
  ]
}

type State = {
  text: string
  usage: Usage
  ok: boolean
  error?: string
  sawResult: boolean
  codexThread?: string
  /** Claude names a tool only in its call; its result refers to the call's id. */
  toolNames: Map<string, string>
}

type Trace = (event: TraceEvent) => void

/** The text of a tool result: a string, or blocks of text (images are only named). */
export function textOf(content: any): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content))
    return content
      .map((block) => (typeof block?.text === 'string' ? block.text : block?.type === 'image' ? t('[Bild]') : ''))
      .filter(Boolean)
      .join('\n')
  return content == null ? '' : JSON.stringify(content)
}

/** A Codex item without the fields every item has, for the timeline. */
function codexDetails(it: any) {
  const { id: _id, type: _type, status: _status, ...rest } = it ?? {}
  return JSON.stringify(rest)
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
  if (lastWithLimits) saveCodexLimits(provider, lastWithLimits)
}

/** Saves the windows of one session line that carries "rate_limits". */
function saveCodexLimits(provider: string, line: string) {
  const found = findKey(JSON.parse(line), 'rate_limits')
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

export function parse(cli: string, provider: string, e: any, st: State, act: (s: string) => void, ev: Trace = () => {}) {
  if (cli === 'claude') {
    if (e.type === 'assistant') {
      for (const c of e.message?.content ?? []) {
        if (c.type === 'text' && c.text) {
          act((st.text = c.text))
          ev({ kind: 'assistant', text: c.text })
        } else if (c.type === 'tool_use') {
          const input = JSON.stringify(c.input ?? {})
          act(`${c.name}: ${input}`)
          if (c.id) st.toolNames.set(c.id, String(c.name ?? 'tool'))
          ev({ kind: 'tool_call', name: String(c.name ?? 'tool'), text: input })
        }
      }
    } else if (e.type === 'user') {
      for (const c of e.message?.content ?? []) {
        if (c?.type !== 'tool_result') continue
        const name = st.toolNames.get(c.tool_use_id) ?? 'tool'
        st.toolNames.delete(c.tool_use_id)
        ev({ kind: c.is_error ? 'error' : 'tool_result', name, text: textOf(c.content) })
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
      if (e.is_error) {
        st.error = short(String(e.result ?? e.subtype ?? t('Fehler')), 400)
        ev({ kind: 'error', text: String(e.result ?? e.subtype ?? t('Fehler')) })
      }
    }
  } else if (cli === 'codex') {
    const it = e.item
    if (e.type === 'thread.started') st.codexThread = e.thread_id
    else if (it?.type === 'agent_message' && e.type === 'item.completed') {
      act((st.text = it.text ?? ''))
      ev({ kind: 'assistant', text: it.text ?? '' })
    } else if (it?.type === 'command_execution' && e.type === 'item.started') {
      act(`$ ${it.command ?? ''}`)
      ev({ kind: 'tool_call', name: 'shell', text: String(it.command ?? '') })
    } else if (it?.type === 'command_execution' && e.type === 'item.completed') {
      const exit = it.exit_code == null ? '' : `\n[exit code ${it.exit_code}]`
      ev({ kind: 'tool_result', name: 'shell', text: `${it.aggregated_output ?? ''}${exit}` })
    } else if (it && e.type === 'item.started') {
      act(String(it.type))
      if (it.type !== 'reasoning' && it.type !== 'agent_message') ev({ kind: 'tool_call', name: String(it.type), text: codexDetails(it) })
    } else if (it && e.type === 'item.completed' && it.type !== 'reasoning') {
      ev({ kind: it.type === 'error' ? 'error' : 'tool_result', name: String(it.type), text: it.message ?? codexDetails(it) })
    } else if (e.type === 'turn.completed') {
      st.usage.input += e.usage?.input_tokens ?? 0
      st.usage.cached = (st.usage.cached ?? 0) + (e.usage?.cached_input_tokens ?? 0)
      st.usage.output += (e.usage?.output_tokens ?? 0) + (e.usage?.reasoning_output_tokens ?? 0)
      st.sawResult = true
    } else if (e.type === 'turn.failed' || e.type === 'error') {
      st.ok = false
      st.error = short(String(e.error?.message ?? e.message ?? t('Fehler')), 400)
      ev({ kind: 'error', text: String(e.error?.message ?? e.message ?? t('Fehler')) })
    }
  } else {
    const p = e.part ?? {}
    if (e.type === 'text' && p.text) {
      // A compaction right after the final answer adds a summary and a closing remark. The answer
      // with the status block stays the result of the run.
      if (!hasStatus(st.text) || hasStatus(p.text)) st.text = p.text
      act(p.text)
      ev({ kind: 'assistant', text: p.text })
    } else if (e.type === 'tool_use') {
      const name = String(p.tool ?? 'tool')
      const input = JSON.stringify(p.state?.input ?? {})
      act(`${name}: ${input}`)
      ev({ kind: 'tool_call', name, text: input })
      // opencode reports a tool once it has finished, with its output.
      if (p.state?.output != null || p.state?.error != null)
        ev({
          kind: p.state?.status === 'error' ? 'error' : 'tool_result',
          name,
          text: textOf(p.state?.output ?? p.state?.error),
        })
    } else if (e.type === 'step_finish') {
      st.usage.input += (p.tokens?.input ?? 0) + (p.tokens?.cache?.read ?? 0) + (p.tokens?.cache?.write ?? 0)
      st.usage.cached = (st.usage.cached ?? 0) + (p.tokens?.cache?.read ?? 0)
      st.usage.output += (p.tokens?.output ?? 0) + (p.tokens?.reasoning ?? 0)
      st.usage.cost += p.cost ?? 0
      st.sawResult = true
    } else if (e.type === 'error') {
      st.ok = false
      st.error = short(String(e.error?.data?.message ?? e.error?.message ?? e.message ?? t('Fehler')), 400)
      ev({ kind: 'error', text: String(e.error?.data?.message ?? e.error?.message ?? e.message ?? t('Fehler')) })
    }
  }
}

const quoteForCmd = (arg: string) => (/^[w./:=@-]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '\\"')}"`)

export function startRun(o: RunOpts): RunHandle {
  const cli = PROVIDERS[o.provider]?.cli
  if (!cli) throw new Error(t('Unbekannter Provider {provider}', { provider: o.provider }))
  if (cli === 'mock') return mockRun(o)
  if (cli === 'api') {
    const key = apiKey(o.provider)
    if (!key) throw new Error(t('Für diesen Anbieter ist kein API-Key hinterlegt'))
    const model = o.model?.trim() || PROVIDERS[o.provider].defaultModel
    return startApiRun(o, PROVIDERS[o.provider].baseUrl!, key, model)
  }
  if (cli === 'managed') {
    const model = o.model?.trim() || PROVIDERS[o.provider].defaultModel
    if (!MODEL_RE.test(model)) throw new Error(t('Ungültiger Modellname'))
    return startManagedRun(o, model)
  }
  const [cmd, baseArgs] = command(cli, o)
  // In the sandbox the run belongs to the project user that owns its directory. An autonomous run
  // never falls back to the server's user; a read-only question from the owner may.
  const owner = ownerOf(o.cwd)
  if (SANDBOX && o.autonomous && !owner)
    throw new Error(t('Sandbox: {dir} gehört keinem Projektnutzer', { dir: o.cwd }))
  const files = owner ? join(owner.home, '.agentdeck') : join(DATA_DIR, 'tmp')
  const mcp = prepareMcp(cli, o.mcp ?? [], randomUUID(), files)
  const env = { ...runEnv(o.provider, cli), ...mcp.env, ...o.env }
  if (o.env?.RTK_DB_PATH && rtkInstalled()) {
    o = { ...o, prompt: `${o.prompt}\n\n${RTK_INSTRUCTIONS}` }
    if (cli === 'opencode') {
      const plugin = pathToFileURL(join(import.meta.dirname, 'rtk-opencode.mjs')).href
      env.OPENCODE_CONFIG_CONTENT = withRtkPlugin(env.OPENCODE_CONFIG_CONTENT, plugin)
    }
  }
  if (cli === 'opencode') {
    const limited = withContextLimit(env.OPENCODE_CONFIG_CONTENT, (o.model ?? '').trim())
    if (limited) env.OPENCODE_CONFIG_CONTENT = limited
  }

  // Codex reads the prompt from stdin when its last argument is "-", so extra flags go in front of it.
  const args = cli === 'codex' ? [...baseArgs.slice(0, -1), ...mcp.args, '-'] : [...baseArgs, ...mcp.args]

  let child: ReturnType<typeof spawn> | undefined
  let stopped = false
  const done = (async (): Promise<RunResult> => {
    if (owner) {
      // The Codex home of an API key lives with the server's data; the run gets a copy of it.
      const codexApi = env.CODEX_HOME?.startsWith(DATA_DIR) ? env.CODEX_HOME : null
      if (codexApi) env.CODEX_HOME = join(owner.home, '.codex-api')
      // A project that pushes with a token of its own (GH_TOKEN) does not get the owner's gh login.
      await loginsIn(o.cwd, { extra: codexApi ? [{ from: codexApi, to: '.codex-api' }] : [], gh: !env.GH_TOKEN })
      for (const file of mcp.files) await placeInHome(o.cwd, file.path, file.content)
    } else {
      for (const file of mcp.files) {
        mkdirSync(dirname(file.path), { recursive: true })
        writeFileSync(file.path, file.content, { mode: 0o600 })
      }
    }
    if (stopped) return { ok: false, text: '', usage: { input: 0, output: 0, cost: 0 }, error: t('gestoppt') }
    const win = process.platform === 'win32'
    // On Windows the CLIs are .cmd shims and need a shell. Arguments are fixed flags, a validated
    // model name or values we built ourselves; anything with special characters gets quoted.
    child = win
      ? spawn([cmd, ...args.map(quoteForCmd)].join(' '), { cwd: o.cwd, env, shell: true, windowsHide: true })
      : spawnIn(o.cwd, cmd, args, { env, detached: true }, o.autonomous)
    return follow(child, cmd, env, o, cli)
  })()
    .catch((err): RunResult => ({ ok: false, text: '', usage: { input: 0, output: 0, cost: 0 }, error: err.message }))
    .finally(async () => {
      if (owner) {
        for (const file of mcp.files) await removeFromHome(o.cwd, file.path).catch(() => {})
        await loginsOut(o.cwd).catch((err) => console.error('sandbox logins', err.message))
      } else {
        for (const file of mcp.files) rmSync(file.path, { force: true })
      }
    })
  return {
    kill: () => {
      stopped = true
      if (child) stopGroup(child.pid)
    },
    done,
  }
}

export const newState = (): State => ({
  text: '',
  usage: { input: 0, output: 0, cost: 0 },
  ok: true,
  sawResult: false,
  toolNames: new Map(),
})

/** Reads the output of a started CLI until it ends. */
function follow(child: ReturnType<typeof spawn>, cmd: string, env: NodeJS.ProcessEnv, o: RunOpts, cli: string) {
  const st = newState()
  // The CLI's output arrives in callbacks; they keep the language the run was started in.
  const lang = currentLang()
  const act = (s: string) => o.onActivity?.(short(s, 1200))
  // Every event of the run is wanted, so a failing listener must not stop the parsing.
  const ev: Trace = (event) => {
    try {
      o.onEvent?.(event)
    } catch {}
  }
  let stderr = ''
  child.stderr!.on('data', (d) => (stderr = (stderr + d).slice(-2000)))
  createInterface({ input: child.stdout! }).on('line', (line) => {
    if (line[0] !== '{') return
    try {
      withLang(lang, () => parse(cli, o.provider, JSON.parse(line), st, act, ev))
    } catch {}
  })
  child.stdin!.on('error', () => {})
  child.stdin!.end(o.prompt)
  return new Promise<RunResult>((resolve) => {
    child.on('error', (err) =>
      resolve({
        ok: false,
        text: st.text,
        usage: st.usage,
        error: tIn(lang, '{cmd} konnte nicht gestartet werden: {message}', { cmd, message: err.message }),
      }),
    )
    child.on('close', async (code) => {
      if (st.codexThread && getAccess(o.provider).mode === 'subscription') {
        // The quota is a bonus; a run must not fail because the session file looks different.
        await readCodexQuotaOf(o.provider, st.codexThread, env.CODEX_HOME ?? join(homeOf(o.cwd), '.codex'), o.cwd).catch(
          () => {},
        )
      }
      const ok = st.ok && st.sawResult && code === 0
      resolve({
        ok,
        text: st.text,
        usage: st.usage,
        error: ok
          ? undefined
          : (st.error ?? (short(stderr.trim(), 400) || tIn(lang, 'Exit-Code {code}', { code: String(code) }))),
      })
    })
  })
}

/** The session file belongs to the run's user; in the sandbox it is read as that user. */
async function readCodexQuotaOf(provider: string, threadId: string, codexHome: string, cwd: string) {
  if (!ownerOf(cwd)) return readCodexQuota(provider, threadId, codexHome)
  if (!/^[\w-]+$/.test(threadId)) return
  const { stdout } = await execIn(cwd, 'sh', [
    '-c',
    'grep -h rate_limits "$1"/sessions/*/*/*/rollout-*-"$2".jsonl | tail -n 1',
    'sh',
    codexHome,
    threadId,
  ])
  if (stdout.trim()) saveCodexLimits(provider, stdout.trim())
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
/** The status line only a review prompt carries, the same in both languages. */
const REVIEW_PROMPT = '<status>approve | changes | blocked</status>'

function mockAnswer(o: RunOpts) {
  // The arena's jury (arena.ts): "[mock:jury:B]" in the task picks that entry, otherwise the first.
  if (!o.autonomous && o.prompt.includes('<winner>')) {
    const pick = o.prompt.match(/\[mock:jury:([A-D?])\]/)?.[1] ?? 'A'
    const reason = t('Mock-Jury: Beitrag {pick} erfüllt die Aufgabe am knappsten.', { pick })
    return `<winner>${pick}</winner>\n<reason>${reason}</reason>`
  }
  if (!o.autonomous) return 'PASS'
  if (o.prompt.includes(REVIEW_PROMPT)) {
    // A reviewer that forgets its status block, as real ones sometimes do.
    if (o.prompt.includes('[mock:nostatus]'))
      return `<summary>${t('Passt: geprüft, nur ohne Status-Block (Mock).')}</summary>`
    // "[mock:changes:QA]": only the reviewer of that name asks for changes.
    const onlyReviewer = o.prompt.match(/\[mock:changes:([^\]]+)\]/)?.[1]
    const asksForChanges = onlyReviewer
      ? [`You are "${onlyReviewer}"`, `Du bist "${onlyReviewer}"`].some((line) => o.prompt.includes(line))
      : o.prompt.includes('[mock:changes]')
    return asksForChanges
      ? `<summary>${t('Ändern: Test fehlt (Mock).')}</summary>\n<status>changes</status>`
      : `<summary>${t('Passt: geprüft (Mock).')}</summary>\n<status>approve</status>`
  }
  if (o.prompt.includes('[mock:waitfor]')) {
    const other = o.prompt.match(/\[mock:waitfor\]\s*([A-Z][A-Z0-9]*-\d+)/)?.[1] ?? ''
    const summary = t('Blockiert: wartet auf {other} (Mock).', { other })
    return `<summary>${summary}</summary>\n<handoff>${t('Wartet.')}</handoff>\n<status>blocked</status>`
  }
  const summary = t('Mock-Lauf: Aufgabe simuliert umgesetzt.')
  const handoff = t('Nichts offen. Geändert: keine Dateien (Mock).')
  return `${mockChecklist(o.prompt)}<summary>${summary}</summary>\n<handoff>${handoff}</handoff>\n<status>review</status>`
}

/** The report on the acceptance checklist: all items met, or the first open with "[mock:partial]". */
function mockChecklist(prompt: string) {
  const list = prompt.match(/## (?:Acceptance checklist|Abnahme-Checkliste)\n[^\n]*\n((?:\d+\. [^\n]*\n?)+)/)?.[1]
  if (!list) return ''
  const count = list.trim().split('\n').length
  const lines = Array.from({ length: count }, (_, index) =>
    index === 0 && prompt.includes('[mock:partial]')
      ? `1. open: ${t('fehlt noch')}`
      : `${index + 1}. ok: ${t('geprüft (Mock)')}`,
  )
  return `<checklist>\n${lines.join('\n')}\n</checklist>\n`
}

function mockRun(o: RunOpts): RunHandle {
  let timer: NodeJS.Timeout
  let finish: (r: RunResult) => void
  const steps = [t('Lese Issue…'), 'Read: src/index.ts', '$ npm test', t('Schreibe Zusammenfassung…')]

  if (o.prompt.includes('[mock:create]') && o.env?.AGENTDECK_CLI) {
    const args = [
      o.env.AGENTDECK_CLI,
      'create',
      '--title',
      t('Vom Mock-Agenten angelegt'),
      '--status',
      'backlog',
    ]
    execFile(process.execPath, args, { env: { ...process.env, ...o.env } }, () => {})
  }

  const unblock = o.prompt.match(/\[mock:unblock:(\d+):(\d+)\]/)
  if (unblock && o.env?.AGENTDECK_CLI) {
    const args = [o.env.AGENTDECK_CLI, 'unblock', unblock[1], unblock[2]]
    execFile(process.execPath, args, { env: { ...process.env, ...o.env } }, () => {})
  }

  const fileToCommit = o.prompt.match(/\[mock:commit:([\w./-]+)\]/)?.[1]
  if (fileToCommit && o.autonomous && !o.prompt.includes(REVIEW_PROMPT)) {
    const title = o.prompt.match(/## Issue [^\n]*/)?.[0] ?? 'mock'
    const file = join(o.cwd, fileToCommit)
    const identity = ['-c', 'user.name=Mock', '-c', 'user.email=mock@localhost']
    if (ownerOf(o.cwd)) {
      // Everything a run changes in its directory is the project user's, also in the mock.
      const script =
        'mkdir -p "$(dirname "$1")" && printf "%s\\n" "$2" > "$1" && git add -A && ' +
        'git -c user.name=Mock -c user.email=mock@localhost commit -q --allow-empty -m "mock: $3"'
      const [cmd, args, env] = syncCommandIn(o.cwd, 'sh', ['-c', script, 'sh', file, title, fileToCommit])
      execFileSync(cmd, args, { cwd: o.cwd, env })
    } else {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, title + '\n')
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
  }

  // The self-healing signs its hint with its name, in the language the project had at that time.
  const healed = variants('Selbstheilung').some((name) => o.prompt.includes(`**${name}:**`))

  const done = new Promise<RunResult>((resolve) => {
    finish = resolve
    let i = 0
    timer = setInterval(
      () => {
        if (i < steps.length) {
          // Counted on its own line: inside the optional call it would never advance for a
          // one-shot question, which has no onActivity, and that run would never end.
          const step = steps[i++]
          o.onEvent?.({ kind: 'tool_call', name: 'mock', text: step })
          return o.onActivity?.(step)
        }
        clearInterval(timer)
        const failWith = o.prompt.match(/\[mock:fail:([^\]]+)\]/)?.[1]
        if (failWith && o.autonomous && !healed) {
          return resolve({ ok: false, text: '', usage: { input: 100, output: 0, cost: 0 }, error: failWith })
        }
        const text = mockAnswer(o)
        o.onEvent?.({ kind: 'assistant', text })
        resolve({ ok: true, text, usage: { input: 1200, output: 300, cost: 0.01 } })
      },
      Number(process.env.AGENTDECK_MOCK_MS ?? 800),
    )
  })
  return {
    kill: () => {
      clearInterval(timer)
      finish({ ok: false, text: '', usage: { input: 0, output: 0, cost: 0 }, error: t('gestoppt') })
    },
    done,
  }
}
