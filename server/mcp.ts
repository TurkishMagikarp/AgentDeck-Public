// Built-in MCP connections. A connection is switched on by storing its key once; after that
// every agent that lists it gets the server configured for its run, whichever CLI it uses.
import { join } from 'node:path'
import { decrypt, encrypt } from './auth.ts'
import { DATA_DIR, all, get, run } from './db.ts'

type Connection = {
  label: string
  description: string
  keyLabel: string
  /** Name of the environment variable that carries the key into the agent process. */
  envVar: string
} & ({ url: string } | { command: string; args: string[] })

export const CONNECTIONS: Record<string, Connection> = {
  github: {
    label: 'GitHub',
    description: 'Issues, pull requests, code search and Actions',
    keyLabel: 'Personal Access Token',
    envVar: 'GITHUB_MCP_TOKEN',
    url: 'https://api.githubcopilot.com/mcp/',
  },
  pixellab: {
    label: 'PixelLab',
    description: 'Pixel art: characters, animations, tilesets',
    keyLabel: 'API-Token',
    envVar: 'PIXELLAB_API_KEY',
    url: 'https://api.pixellab.ai/mcp',
  },
  elevenlabs: {
    label: 'ElevenLabs',
    description: 'Speech, voices, sound effects',
    keyLabel: 'API key',
    envVar: 'ELEVENLABS_API_KEY',
    command: 'uvx',
    args: ['elevenlabs-mcp'],
  },
  recraft: {
    label: 'Recraft',
    description: 'Create and edit images and vector graphics',
    keyLabel: 'API key',
    envVar: 'RECRAFT_API_KEY',
    command: 'npx',
    args: ['-y', '@recraft-ai/mcp-recraft-server@latest'],
  },
  meshy: {
    label: 'Meshy',
    description: '3D models from text and images',
    keyLabel: 'API key',
    envVar: 'MESHY_API_KEY',
    command: 'npx',
    args: ['-y', '@meshy-ai/meshy-mcp-server'],
  },
}

const isWindows = process.platform === 'win32'

export function listConnections() {
  const stored = new Set(all('SELECT id FROM mcp_auth WHERE secret IS NOT NULL').map((row) => row.id))
  return Object.entries(CONNECTIONS).map(([id, connection]) => ({
    id,
    label: connection.label,
    description: connection.description,
    keyLabel: connection.keyLabel,
    hasKey: stored.has(id),
  }))
}

export function setConnectionKey(id: string, key: string) {
  if (!CONNECTIONS[id]) throw new Error('Unknown connection')
  if (key)
    run(
      'INSERT OR REPLACE INTO mcp_auth (id, secret, updated_at) VALUES (?,?,?)',
      id,
      encrypt(key),
      Date.now(),
    )
  else run('DELETE FROM mcp_auth WHERE id=?', id)
}

export function apiKeyOfConnection(id: string): string | null {
  const row = get('SELECT secret FROM mcp_auth WHERE id=?', id)
  try {
    return row?.secret ? decrypt(row.secret) : null
  } catch {
    return null
  }
}

/**
 * Every stored key under its usual name. Agents get all of them, whatever connections they list
 * and whichever adapter runs them: project scripts that call a service directly (asset
 * generators, import tools) expect the key there.
 */
export function connectionKeys() {
  const env: Record<string, string> = {}
  for (const [id, connection] of Object.entries(CONNECTIONS)) {
    const key = apiKeyOfConnection(id)
    if (key) env[connection.envVar] = key
  }
  return env
}

/** npx and uvx are .cmd shims on Windows and cannot be started directly by the CLIs. */
function launcher(command: string, args: string[]): [string, string[]] {
  return isWindows ? ['cmd', ['/c', command, ...args]] : [command, args]
}

const tomlString = (value: string) => `'${value}'`
const tomlList = (values: string[]) => `[${values.map(tomlString).join(',')}]`

/** `files`: what the caller writes (private, 0600) before the CLI starts and removes after. */
export type McpSetup = { args: string[]; env: Record<string, string>; files: { path: string; content: string }[] }

/**
 * Translates the selected connections into what the given CLI understands.
 * Keys travel in environment variables or a private temp file, never on the command line.
 */
export function prepareMcp(cli: string, ids: string[], runId: string, dir = join(DATA_DIR, 'tmp')): McpSetup {
  const setup: McpSetup = { args: [], env: connectionKeys(), files: [] }
  const active = ids
    .map((id) => ({ id, connection: CONNECTIONS[id], key: apiKeyOfConnection(id) }))
    .filter((entry) => entry.connection && entry.key) as { id: string; connection: Connection; key: string }[]
  if (!active.length) return setup

  if (cli === 'claude') {
    const servers: Record<string, unknown> = {}
    for (const { id, connection, key } of active) {
      if ('url' in connection) {
        servers[id] = { type: 'http', url: connection.url, headers: { Authorization: `Bearer ${key}` } }
      } else {
        const [command, args] = launcher(connection.command, connection.args)
        servers[id] = { command, args, env: { [connection.envVar]: key } }
      }
    }
    const file = join(dir, `mcp-${runId}.json`)
    setup.files.push({ path: file, content: JSON.stringify({ mcpServers: servers }) })
    setup.args = ['--mcp-config', file]
  }

  if (cli === 'codex') {
    for (const { id, connection, key } of active) {
      const prefix = `mcp_servers.${id}`
      if ('url' in connection) {
        setup.args.push('-c', `${prefix}.url=${tomlString(connection.url)}`)
        setup.args.push('-c', `${prefix}.bearer_token_env_var=${tomlString(connection.envVar)}`)
      } else {
        const [command, args] = launcher(connection.command, connection.args)
        setup.args.push('-c', `${prefix}.command=${tomlString(command)}`)
        setup.args.push('-c', `${prefix}.args=${tomlList(args)}`)
        setup.args.push('-c', `${prefix}.env_vars=${tomlList([connection.envVar])}`)
      }
    }
  }

  if (cli === 'opencode') {
    const servers: Record<string, unknown> = {}
    for (const { id, connection, key } of active) {
      servers[id] =
        'url' in connection
          ? { type: 'remote', url: connection.url, headers: { Authorization: `Bearer ${key}` } }
          : {
              type: 'local',
              command: launcher(connection.command, connection.args).flat(),
              environment: { [connection.envVar]: key },
            }
    }
    setup.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ mcp: servers })
  }

  return setup
}
