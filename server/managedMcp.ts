// MCP connections for Managed Agents. AgentDeck connects to the servers itself, on this machine,
// and offers their tools to the session as custom tools that the worker answers. The keys never
// leave the server, and the local servers (uvx, npx) work the same way as the remote ones.
import { mcpTool, type MCPClientLike } from '@anthropic-ai/sdk/helpers/beta/mcp'
import type { BetaRunnableTool } from '@anthropic-ai/sdk/lib/tools/BetaRunnableTool'
import type { BetaManagedAgentsCustomToolParams } from '@anthropic-ai/sdk/resources/beta/agents/agents'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { apiKeyOfConnection, CONNECTIONS } from './mcp.ts'

export type ManagedMcp = {
  /** What the session is told about the tools. */
  definitions: BetaManagedAgentsCustomToolParams[]
  /** What the worker runs when the agent calls one. */
  tools: BetaRunnableTool[]
  close: () => Promise<void>
}

const CONNECT_TIMEOUT_MS = 60_000

/** Tool names must be unique across servers and fit the API's pattern. */
const toolName = (connectionId: string, name: string) =>
  `${connectionId}_${name}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64)

function transportFor(id: string, key: string, env: Record<string, string>) {
  const connection = CONNECTIONS[id]
  if ('url' in connection) {
    return new StreamableHTTPClientTransport(new URL(connection.url), {
      requestInit: { headers: { Authorization: `Bearer ${key}` } },
    })
  }
  return new StdioClientTransport({
    command: connection.command,
    args: connection.args,
    env: { ...env, [connection.envVar]: key },
    stderr: 'ignore',
  })
}

/**
 * Connects to the selected servers. A server that cannot be reached is skipped and reported, so
 * one broken connection does not stop the run.
 */
export async function openManagedMcp(
  ids: string[],
  env: Record<string, string>,
  report: (line: string) => void,
): Promise<ManagedMcp> {
  const clients: Client[] = []
  const definitions: BetaManagedAgentsCustomToolParams[] = []
  const tools: BetaRunnableTool[] = []

  for (const id of ids) {
    const key = CONNECTIONS[id] && apiKeyOfConnection(id)
    if (!key) continue
    const client = new Client({ name: 'agentdeck', version: '1.0.0' })
    try {
      await client.connect(transportFor(id, key, env), { timeout: CONNECT_TIMEOUT_MS })
      const listed = await client.listTools(undefined, { timeout: CONNECT_TIMEOUT_MS })
      clients.push(client)
      for (const tool of listed.tools) {
        const name = toolName(id, tool.name)
        definitions.push({
          type: 'custom',
          name,
          description: `${CONNECTIONS[id].label}: ${tool.description || tool.name}`.slice(0, 1024),
          input_schema: {
            type: 'object',
            properties: tool.inputSchema.properties ?? {},
            required: tool.inputSchema.required ?? [],
          },
        })
        // mcpTool calls the server under the tool's own name; only the name the agent sees changes.
        // The MCP SDK's result type still includes a legacy shape, hence the cast.
        const runnable = mcpTool(tool, client as unknown as MCPClientLike)
        tools.push({ ...runnable, name } as BetaRunnableTool)
      }
      report(`MCP ${CONNECTIONS[id].label}: ${listed.tools.length} Werkzeuge`)
    } catch (err: any) {
      report(`MCP ${CONNECTIONS[id].label} not reachable: ${err?.message ?? err}`)
      await client.close().catch(() => {})
    }
  }

  return {
    definitions,
    tools,
    close: async () => {
      await Promise.all(clients.map((client) => client.close().catch(() => {})))
    },
  }
}
