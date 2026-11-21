// A small coding agent for providers that only offer an OpenAI-compatible chat API (Deepseek).
// The CLIs bring their own agent loop; here we run it ourselves: ask the model, execute the tools
// it calls inside the issue's working directory, repeat until it answers without tool calls.
import { spawn } from 'node:child_process'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { RunHandle, RunOpts, RunResult, Usage } from './adapters.ts'

const MAX_STEPS = 80
const MAX_TOOL_OUTPUT = 12_000
const COMMAND_TIMEOUT_MS = 120_000

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

const READ_TOOLS = [
  tool('read_file', 'Read a text file.', { path: 'Path relative to the working directory' }),
  tool('list_dir', 'List the entries of a directory.', { path: 'Directory, "." for the working directory' }),
]

const WRITE_TOOLS = [
  tool('write_file', 'Create or overwrite a file.', {
    path: 'Path relative to the working directory',
    content: 'Full file content',
  }),
  tool('edit_file', 'Replace one exact, unique occurrence of a string in a file.', {
    path: 'Path relative to the working directory',
    old_text: 'Exact text to replace',
    new_text: 'Replacement',
  }),
  tool('run_command', 'Run a shell command in the working directory (builds, tests, git).', {
    command: 'The command line',
  }),
]

const clip = (text: string) =>
  text.length > MAX_TOOL_OUTPUT ? text.slice(0, MAX_TOOL_OUTPUT) + '\n… (output truncated)' : text

export function startApiRun(opts: RunOpts, baseUrl: string, apiKey: string, model: string): RunHandle {
  const abort = new AbortController()
  const usage: Usage = { input: 0, output: 0, cost: 0 }

  /** File tools may not leave the working directory. */
  function inside(path: string) {
    const full = resolve(opts.cwd, path)
    const rel = relative(opts.cwd, full)
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('Path is outside the working directory')
    return full
  }

  function runCommand(command: string) {
    return new Promise<string>((done) => {
      const child = spawn(command, {
        cwd: opts.cwd,
        env: { ...process.env, ...opts.env },
        shell: true,
        windowsHide: true,
        signal: abort.signal,
      })
      let output = ''
      const collect = (chunk: Buffer) => (output = (output + chunk).slice(-MAX_TOOL_OUTPUT * 2))
      child.stdout.on('data', collect)
      child.stderr.on('data', collect)
      const timer = setTimeout(() => child.kill(), COMMAND_TIMEOUT_MS)
      child.on('error', (err) => done(`Command failed to start: ${err.message}`))
      child.on('close', (code) => {
        clearTimeout(timer)
        done(`${output.trim()}\n[exit code ${code}]`)
      })
    })
  }

  async function execute(name: string, args: Record<string, string>): Promise<string> {
    switch (name) {
      case 'read_file':
        return readFile(inside(args.path), 'utf8')
      case 'list_dir': {
        const entries = await readdir(inside(args.path || '.'), { withFileTypes: true })
        return entries.map((entry) => entry.name + (entry.isDirectory() ? sep : '')).join('\n') || '(empty)'
      }
      case 'write_file': {
        const file = inside(args.path)
        await mkdir(dirname(file), { recursive: true })
        await writeFile(file, args.content ?? '')
        return 'written'
      }
      case 'edit_file': {
        const file = inside(args.path)
        const before = await readFile(file, 'utf8')
        const count = before.split(args.old_text).length - 1
        if (count !== 1) return `old_text must match exactly once, it matches ${count} times`
        await writeFile(
          file,
          before.replace(args.old_text, () => args.new_text),
        )
        return 'edited'
      }
      case 'run_command':
        return runCommand(args.command)
      default:
        return `Unknown tool ${name}`
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
        tools: opts.autonomous ? [...READ_TOOLS, ...WRITE_TOOLS] : READ_TOOLS,
      }),
    })
    const data: any = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error?.message ?? `API antwortet mit HTTP ${res.status}`)

    usage.input += data.usage?.prompt_tokens ?? 0
    usage.cached = (usage.cached ?? 0) + (data.usage?.prompt_cache_hit_tokens ?? 0)
    usage.output += data.usage?.completion_tokens ?? 0
    return data.choices?.[0]?.message as Message
  }

  async function loop(): Promise<RunResult> {
    const messages: Message[] = [
      {
        role: 'system',
        content:
          `You are a coding agent working in ${opts.cwd} on ${process.platform}. ` +
          'Use the tools to inspect files' +
          (opts.autonomous ? ', change them and run commands. ' : '. You cannot change anything. ') +
          'When the task is finished, reply with your final message and no tool call.',
      },
      { role: 'user', content: opts.prompt },
    ]

    for (let step = 0; step < MAX_STEPS; step++) {
      const reply = await ask(messages)
      if (!reply) throw new Error('Die API hat keine Antwort geliefert')
      messages.push(reply)
      if (reply.content) opts.onActivity?.(reply.content)

      if (!reply.tool_calls?.length) return { ok: true, text: reply.content ?? '', usage }

      for (const call of reply.tool_calls) {
        opts.onActivity?.(`${call.function.name}: ${call.function.arguments}`)
        let result: string
        try {
          result = await execute(call.function.name, JSON.parse(call.function.arguments || '{}'))
        } catch (err: any) {
          result = `Error: ${err.message}`
        }
        messages.push({ role: 'tool', tool_call_id: call.id, content: clip(result) })
      }
    }
    return { ok: false, text: '', usage, error: `Nach ${MAX_STEPS} Schritten nicht fertig geworden` }
  }

  const done = loop().catch((err): RunResult => ({ ok: false, text: '', usage, error: err.message }))
  return { kill: () => abort.abort(), done }
}
