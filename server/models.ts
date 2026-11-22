// Which models each provider offers, so nobody has to type a model name. The lists come from
// the providers' own tools where they have one, and always include what the board already uses.
import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { apiKey } from './auth.ts'
import { PROVIDERS } from './core.ts'
import { DATA_DIR, all } from './db.ts'

const execFileAsync = promisify(execFile)

// Claude Code has no command that lists models; these are the current ones.
const CLAUDE_MODELS = ['claude-fable-5-2', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']
const DEEPSEEK_FALLBACK = ['deepseek-chat', 'deepseek-reasoner']
const CACHE_MS = 10 * 60_000

/** Codex keeps the models of the logged-in account in a cache file next to its login. */
function codexModels() {
  const homes = [process.env.CODEX_HOME, join(homedir(), '.codex'), join(DATA_DIR, 'codex-api')]
  for (const home of homes) {
    const file = home && join(home, 'models_cache.json')
    if (!file || !existsSync(file)) continue
    try {
      const cached = JSON.parse(readFileSync(file, 'utf8'))
      return (cached.models ?? [])
        .filter((model: any) => model.visibility !== 'hide')
        .map((model: any) => String(model.slug ?? ''))
        .filter(Boolean)
    } catch {
      // an unreadable cache is the same as none
    }
  }
  return []
}

async function opencodeModels() {
  try {
    const isWindows = process.platform === 'win32'
    const { stdout } = await execFileAsync(isWindows ? 'opencode.cmd' : 'opencode', ['models'], {
      timeout: 30_000,
      shell: isWindows,
    })
    return stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /^[\w.-]+\/[\w./:-]+$/.test(line))
  } catch {
    return []
  }
}

async function deepseekModels() {
  const key = apiKey('deepseek')
  const baseUrl = PROVIDERS.deepseek?.baseUrl
  if (!key || !baseUrl) return DEEPSEEK_FALLBACK
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/models`, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10_000),
    })
    const listed = ((await res.json()).data ?? []).map((model: any) => String(model.id))
    return listed.length ? listed : DEEPSEEK_FALLBACK
  } catch {
    return DEEPSEEK_FALLBACK
  }
}

/** Models that agents, issues or past runs already name stay selectable even if a list misses them. */
function modelsInUse(provider: string): string[] {
  return all(
    `SELECT model FROM agents WHERE provider=? AND model!=''
     UNION SELECT model FROM runs WHERE provider=? AND model!=''`,
    provider,
    provider,
  ).map((row) => row.model)
}

let cache: { at: number; models: Record<string, string[]> } | undefined

export async function listModels(refresh = false) {
  if (cache && !refresh && Date.now() - cache.at < CACHE_MS) return cache.models

  const offered: Record<string, string[]> = {
    anthropic: CLAUDE_MODELS,
    'claude-managed': CLAUDE_MODELS,
    openai: codexModels(),
    opencode: await opencodeModels(),
    deepseek: await deepseekModels(),
    mock: ['mock-fast', 'mock-slow'],
  }
  const models: Record<string, string[]> = {}
  for (const provider of Object.keys(PROVIDERS)) {
    models[provider] = [...new Set([...(offered[provider] ?? []), ...modelsInUse(provider)])]
  }
  cache = { at: Date.now(), models }
  return models
}
