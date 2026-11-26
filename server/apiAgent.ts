// A small coding agent for providers that only offer an OpenAI-compatible chat API (Deepseek).
// The CLIs bring their own agent loop; here we run it ourselves: ask the model, execute the tools
// it calls inside the issue's working directory, repeat until it answers without tool calls.
import { join } from 'node:path'
import { safeEnv } from './auth.ts'
// @ts-ignore: plain ES module shared with the sandboxed process
import { fileTool } from './agentFiles.mjs'
import { ownerOf, SANDBOX, spawnIn, spawnShellIn, stopGroup } from './sandbox.ts'
import type { RunHandle, RunOpts, RunResult, Usage } from './adapters.ts'
import { connectionKeys } from './mcp.ts'
import { rewriteCommand, rtkInstalled, RTK_INSTRUCTIONS } from './rtk.ts'
import { t } from './i18n.ts'
import { prompts } from './prompts/index.ts'

const MAX_STEPS = 80
const MAX_TOOL_OUTPUT = 12_000
const COMMAND_TIMEOUT_MS = 120_000
const AGENT_FILES = join(import.meta.dirname, 'agentFiles.mjs')

type ToolCall = { id: string; function: { name: string; arguments: string } }
type Message = { role: string; content: string | null; tool_calls?: ToolCall[]; tool_call_id?: string }

const tool = (name: string, description: string, properties: Record<string, string>) => ({
  type: 'function',
  function: {
    name,
    description,
    parameters: {
      type: 'object',
      properties: Object.fromEntries(
        Object.entries(properties).map(([key, text]) => [key, { type: 'string', description: text }]),
      ),
      required: Object.keys(properties),
    },
  },
})

// The descriptions are read by the model, so they come in the language of the run.
function readTools() {
  const text = prompts().tools
  return [
    tool('read_file', text.readFile, { path: text.workdirPath }),
    tool('list_dir', text.listDir, { path: text.listDirPath }),
  ]
}

function writeTools() {
  const text = prompts().tools
  return [
    tool('write_file', text.writeFile, { path: text.workdirPath, content: text.writeFileContent }),
    tool('edit_file', text.editFile, {
      path: text.workdirPath,
      old_text: text.editFileOld,
      new_text: text.editFileNew,
    }),
    tool('run_command', text.runCommand, { command: text.runCommandLine }),
  ]
}

const clip = (text: string) =>
  text.length > MAX_TOOL_OUTPUT ? text.slice(0, MAX_TOOL_OUTPUT) + prompts().tools.truncated : text

export function startApiRun(opts: RunOpts, baseUrl: string, apiKey: string, model: string): RunHandle {
  const text = prompts()
  const abort = new AbortController()
  const usage: Usage = { input: 0, output: 0, cost: 0 }

  /** File tools stay inside the working directory; in the sandbox they run as the project user. */
  function onFiles(tool: string, args: Record<string, string>): Promise<string> {
    // A read-only question of the owner outside any project (blueprints) may read as the server.
    const sandboxed = SANDBOX && (opts.autonomous || ownerOf(opts.cwd))
    if (!sandboxed) return fileTool(opts.cwd, tool, args).catch((err: Error) => text.tools.error(err.message))
    return new Promise((done) => {
      const child = spawnIn(opts.cwd, process.execPath, [AGENT_FILES, opts.cwd, tool], {}, true)
      let output = ''
      child.stdout!.on('data', (chunk) => (output += chunk))
      child.on('error', (err) => done(text.tools.error(err.message)))
      child.on('close', () => done(output))
      child.stdin!.end(JSON.stringify(args))
    })
  }

  async function runCommand(command: string) {
    const env = safeEnv({ ...connectionKeys(), ...opts.env })
    const rewritten = await rewriteCommand(opts.cwd, command, env)
    if (abort.signal.aborted) return text.tools.cancelled
    return new Promise<string>((done) => {
      const child = spawnShellIn(opts.cwd, rewritten, {
        env,
        windowsHide: true,
        // Its own process group, so a timeout or a stop ends what the command started too.
        detached: process.platform !== 'win32',
      })
      let output = ''
      const collect = (chunk: Buffer) => (output = (output + chunk).slice(-MAX_TOOL_OUTPUT * 2))
      child.stdout!.on('data', collect)
      child.stderr!.on('data', collect)
      const stop = () => stopGroup(child.pid)
      const timer = setTimeout(stop, COMMAND_TIMEOUT_MS)
      abort.signal.addEventListener('abort', stop, { once: true })
      child.on('error', (err) => done(text.tools.notStarted(err.message)))
      child.on('close', (code) => {
        clearTimeout(timer)
        abort.signal.removeEventListener('abort', stop)
        done(`${output.trim()}\n[exit code ${code}]`)
      })
    })
  }

  async function execute(name: string, args: Record<string, string>): Promise<string> {
    switch (name) {
      case 'read_file':
      case 'list_dir':
      case 'write_file':
      case 'edit_file':
        return onFiles(name, args)
      case 'run_command':
        return runCommand(args.command)
      default:
        return text.tools.unknown(name)
    }
  }

  async function ask(messages: Message[]) {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      signal: abort.signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages,
        tools: opts.autonomous ? [...readTools(), ...writeTools()] : readTools(),
      }),
    })
    const data: any = await res.json().catch(() => ({}))
    if (!res.ok)
      throw new Error(data.error?.message ?? t('API antwortet mit HTTP {status}', { status: res.status }))

    usage.input += data.usage?.prompt_tokens ?? 0
    usage.cached = (usage.cached ?? 0) + (data.usage?.prompt_cache_hit_tokens ?? 0)
    usage.output += data.usage?.completion_tokens ?? 0
    return data.choices?.[0]?.message as Message
  }

  async function loop(): Promise<RunResult> {
    const messages: Message[] = [
      {
        role: 'system',
        content: text.apiSystem({
          cwd: opts.cwd,
          platform: process.platform,
          autonomous: opts.autonomous,
          rtk: opts.env?.RTK_DB_PATH && rtkInstalled() ? `${RTK_INSTRUCTIONS} ` : '',
        }),
      },
      { role: 'user', content: opts.prompt },
    ]

    for (let step = 0; step < MAX_STEPS; step++) {
      const reply = await ask(messages)
      if (!reply) throw new Error(t('Die API hat keine Antwort geliefert'))
      messages.push(reply)
      if (reply.content) {
        opts.onActivity?.(reply.content)
        opts.onEvent?.({ kind: 'assistant', text: reply.content })
      }

      if (!reply.tool_calls?.length) return { ok: true, text: reply.content ?? '', usage }

      for (const call of reply.tool_calls) {
        opts.onActivity?.(`${call.function.name}: ${call.function.arguments}`)
        opts.onEvent?.({ kind: 'tool_call', name: call.function.name, text: call.function.arguments ?? '' })
        let result: string
        let failed = false
        try {
          result = await execute(call.function.name, JSON.parse(call.function.arguments || '{}'))
        } catch (err: any) {
          result = text.tools.error(err.message)
          failed = true
        }
        opts.onEvent?.({ kind: failed ? 'error' : 'tool_result', name: call.function.name, text: result })
        messages.push({ role: 'tool', tool_call_id: call.id, content: clip(result) })
      }
    }
    return {
      ok: false,
      text: '',
      usage,
      error: t('Nach {steps} Schritten nicht fertig geworden', { steps: MAX_STEPS }),
    }
  }

  const done = loop().catch((err): RunResult => ({ ok: false, text: '', usage, error: err.message }))
  return { kill: () => abort.abort(), done }
}
