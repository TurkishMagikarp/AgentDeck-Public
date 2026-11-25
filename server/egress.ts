// Outbound network of the agents, per project. In 'allowlist' mode a project user reaches only
// the loopback address (docker/agentdeck-sandbox egress sets that up with iptables), and its
// HTTP(S) traffic goes through the proxy here, which lets through only the hosts in the
// project's settings. 'open' changes nothing, so existing projects keep working as before.
//
// The proxy knows the project of a connection from the kernel, not from anything the client
// sends: the uid of the connecting socket (in /proc/net/tcp) is the project user's. An agent
// cannot fake it and there is no credential that could leak into a repo or a log.
import { lookup as dnsLookup } from 'node:dns/promises'
import { readFileSync } from 'node:fs'
import { BlockList, connect, createServer, isIP, type Server, type Socket } from 'node:net'
import { endianness } from 'node:os'

export type EgressMode = 'open' | 'allowlist'
export type EgressSettings = { mode: EgressMode; allow: string[] }
export type FirewallState = 'off' | 'open' | 'pending' | 'active' | 'unavailable'

/** What the agent CLIs, git and the package managers need out of the box. */
export const DEFAULT_ALLOW = [
  'api.anthropic.com',
  'console.anthropic.com',
  '*.openai.com',
  'chatgpt.com',
  'github.com',
  'api.github.com',
  'codeload.github.com',
  'objects.githubusercontent.com',
  'registry.npmjs.org',
  'pypi.org',
  'files.pythonhosted.org',
]

const MAX_PATTERNS = 200
const port = Number(process.env.AGENTDECK_EGRESS_PORT)
export const EGRESS_PORT = Number.isInteger(port) && port > 0 && port < 65536 ? port : 8791

// ---------- host patterns ----------

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/
// getaddrinfo reads "10.1", "0x7f.1" or "2130706433" as IP addresses. A name whose last label
// is a number is no DNS name; refusing it keeps IP literals out of the hostname rules.
const NUMERIC_LABEL = /^(\d+|0x[0-9a-f]*)$/

export function isHostname(host: string) {
  if (!host || host.length > 253) return false
  const labels = host.split('.')
  return labels.every((label) => LABEL.test(label)) && !NUMERIC_LABEL.test(labels[labels.length - 1])
}

/** One textual form per address, so "::1" and "0:0::1" are the same entry. */
function canonicalIp(host: string) {
  const family = isIP(host)
  if (family === 4) return host
  if (family === 6) return new URL(`http://[${host}]`).hostname.slice(1, -1)
  return null
}

type Pattern = { host: string; wildcard: boolean; ip: boolean; port: number | null }

function validPort(text: string | undefined) {
  if (text === undefined) return null
  const n = Number(text)
  return /^\d{1,5}$/.test(text) && n > 0 && n < 65536 ? n : NaN
}

/**
 * "example.com", "*.example.com" (subdomains only, not example.com itself), an IP address
 * ("192.0.2.7", "[2001:db8::1]"), each optionally with ":port". Without a port 80 and 443 apply.
 */
export function parsePattern(raw: string): Pattern | null {
  let text = String(raw).trim().toLowerCase()
  if (!text || text.length > 270) return null
  let host: string
  let port: number | null = null
  if (text.startsWith('[')) {
    const end = text.indexOf(']')
    if (end < 0) return null
    host = text.slice(1, end)
    const rest = text.slice(end + 1)
    if (rest && !rest.startsWith(':')) return null
    port = validPort(rest ? rest.slice(1) : undefined)
    if (isIP(host) !== 6) return null
  } else if (isIP(text) === 6) {
    host = text
  } else {
    const colon = text.lastIndexOf(':')
    host = colon < 0 ? text : text.slice(0, colon)
    port = validPort(colon < 0 ? undefined : text.slice(colon + 1))
  }
  if (Number.isNaN(port)) return null
  const ip = canonicalIp(host)
  if (ip) return { host: ip, wildcard: false, ip: true, port }
  const wildcard = host.startsWith('*.')
  if (wildcard) host = host.slice(2)
  host = host.replace(/\.$/, '')
  if (!isHostname(host)) return null
  return { host, wildcard, ip: false, port }
}

function formatPattern(p: Pattern) {
  const host = p.ip && p.host.includes(':') ? `[${p.host}]` : `${p.wildcard ? '*.' : ''}${p.host}`
  return p.port === null ? host : `${host}:${p.port}`
}

/** The allowlist as settings keep it: valid entries only, in one spelling, no duplicates. */
export function normalizeAllow(value: unknown): string[] {
  if (!Array.isArray(value)) return [...DEFAULT_ALLOW]
  const out = new Set<string>()
  for (const entry of value) {
    const pattern = parsePattern(String(entry))
    if (pattern) out.add(formatPattern(pattern))
    if (out.size >= MAX_PATTERNS) break
  }
  return [...out]
}

export function normalizeEgress(raw: any): EgressSettings {
  return { mode: raw?.mode === 'allowlist' ? 'allowlist' : 'open', allow: normalizeAllow(raw?.allow) }
}

// ---------- matching ----------

type Ports = (number | null)[]
export type CompiledEgress = { mode: EgressMode; exact: Map<string, Ports>; wildcard: Map<string, Ports> }

/** Compiled once per settings change; a connection costs a few map lookups. */
export function compileEgress(settings: EgressSettings): CompiledEgress {
  const exact = new Map<string, Ports>()
  const wildcard = new Map<string, Ports>()
  for (const entry of settings.allow) {
    const p = parsePattern(entry)
    if (!p) continue
    const map = p.wildcard ? wildcard : exact
    map.set(p.host, [...(map.get(p.host) ?? []), p.port])
  }
  return { mode: settings.mode, exact, wildcard }
}

const portAllowed = (ports: Ports | undefined, port: number) =>
  !!ports?.some((allowed) => (allowed === null ? port === 80 || port === 443 : allowed === port))

/**
 * Whether `host`:`port` is on the list. `literal`: the host is an IP address, which only an
 * entry with that very address allows (never a wildcard).
 */
export function hostAllowed(compiled: CompiledEgress, rawHost: string, port: number) {
  let host = rawHost.toLowerCase()
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1)
  const ip = canonicalIp(host)
  if (ip) return { ok: portAllowed(compiled.exact.get(ip), port), literal: true, host: ip }
  host = host.replace(/\.$/, '')
  if (!isHostname(host)) return { ok: false, literal: false, host }
  if (portAllowed(compiled.exact.get(host), port)) return { ok: true, literal: false, host }
  // Parents only, label by label: "*.github.com" never matches "evilgithub.com".
  for (let dot = host.indexOf('.'); dot >= 0; dot = host.indexOf('.', dot + 1))
    if (portAllowed(compiled.wildcard.get(host.slice(dot + 1)), port)) return { ok: true, literal: false, host }
  return { ok: false, literal: false, host }
}

/** Addresses a name on the list may not lead to: the container itself, the LAN, cloud metadata. */
// Two lists: a BlockList also matches IPv4 addresses against IPv4-mapped IPv6 subnets.
const internal4 = new BlockList()
const internal6 = new BlockList()
for (const [net, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.168.0.0', 16], ['224.0.0.0', 3],
] as const)
  internal4.addSubnet(net, bits, 'ipv4')
// IPv4-mapped and NAT64 addresses would lead to the IPv4 networks above, so they count as internal.
for (const [net, bits] of [['::', 127], ['::ffff:0:0', 96], ['64:ff9b::', 96], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]] as const)
  internal6.addSubnet(net, bits, 'ipv6')

export function isInternal(address: string) {
  const family = isIP(address)
  if (family === 4) return internal4.check(address, 'ipv4')
  return family !== 6 || internal6.check(address, 'ipv6')
}

// ---------- per project ----------

type ProjectEgress = {
  compiled: CompiledEgress
  firewall: FirewallState
  error: string
  /** Recently refused targets with time, newest last; the settings page offers them to allow. */
  blocked: Map<string, number>
}

const projects = new Map<string, ProjectEgress>()

export function configureEgress(key: string, settings: EgressSettings) {
  const entry = projects.get(key)
  const compiled = compileEgress(settings)
  if (entry) entry.compiled = compiled
  else projects.set(key, { compiled, firewall: 'off', error: '', blocked: new Map() })
}

export const egressOf = (key: string) => projects.get(key)?.compiled ?? null

export function setFirewall(key: string, firewall: FirewallState, error = '') {
  const entry = projects.get(key)
  if (entry) Object.assign(entry, { firewall, error })
}

function noteBlocked(key: string, target: string) {
  const blocked = projects.get(key)?.blocked
  if (!blocked) return
  const known = blocked.delete(target)
  blocked.set(target, Date.now())
  if (blocked.size > 30) blocked.delete(blocked.keys().next().value!)
  if (!known) console.log(`egress: ${key} blocked ${target}`)
}

export function egressStatus(key: string) {
  const entry = projects.get(key)
  return {
    mode: entry?.compiled.mode ?? 'open',
    firewall: entry?.firewall ?? 'off',
    error: entry?.error ?? '',
    blocked: [...(entry?.blocked ?? [])].reverse().map(([target, at]) => ({ target, at })),
  }
}

const PROXY_VARS = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']
const NO_PROXY = '127.0.0.1,localhost,::1'

/** The env a run of project `key` gets: the proxy for allowlist projects, nothing otherwise. */
export function egressEnv(key: string | null): Record<string, string> {
  if (!key || egressOf(key)?.mode !== 'allowlist') return {}
  const url = `http://127.0.0.1:${EGRESS_PORT}`
  const env: Record<string, string> = { NO_PROXY, no_proxy: NO_PROXY, NODE_USE_ENV_PROXY: '1' }
  for (const name of PROXY_VARS) env[name] = url
  return env
}

/** ad-shop -> SHOP, as docker/agentdeck-sandbox names the users. */
export const keyOfUser = (name: string) => (/^ad-[a-z][a-z0-9]{1,7}$/.test(name) ? name.slice(3).toUpperCase() : null)

// ---------- who connects ----------

const hex4 = (ip: string) => {
  const bytes = ip.split('.').map((n) => Number(n).toString(16).padStart(2, '0'))
  return (endianness() === 'LE' ? bytes.reverse() : bytes).join('').toUpperCase()
}
const hexPort = (port: number) => port.toString(16).toUpperCase().padStart(4, '0')

/**
 * The uid that owns the client end of `socket`, a connection to the proxy on 127.0.0.1. The
 * client's socket is the line whose local end is the peer and whose remote end is us.
 */
export function uidOfPeer(socket: Socket, table = () => readFileSync('/proc/net/tcp', 'utf8')): number | null {
  const { remoteAddress, remotePort, localAddress, localPort } = socket
  if (!remoteAddress || !remotePort || !localAddress || !localPort) return null
  if (isIP(remoteAddress) !== 4 || isIP(localAddress) !== 4) return null
  const local = `${hex4(remoteAddress)}:${hexPort(remotePort)}`
  const remote = `${hex4(localAddress)}:${hexPort(localPort)}`
  for (const line of table().split('\n')) {
    const cols = line.trim().split(/\s+/)
    if (cols[1] === local && cols[2] === remote) return Number(cols[7])
  }
  return null
}

// ---------- the proxy ----------

const MAX_HEAD = 16 * 1024

function refuse(socket: Socket, status: string, text: string) {
  const body = `AgentDeck: ${text}\n`
  socket.end(
    `HTTP/1.1 ${status}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
  )
}

/** "host:port" of a CONNECT, also "[v6]:port". The port is required. */
export function parseAuthority(authority: string) {
  const m = /^(\[[0-9a-fA-F:.]+\]|[^:\[\]]+):(\d{1,5})$/.exec(authority)
  const port = m ? Number(m[2]) : 0
  if (!m || port < 1 || port > 65535) return null
  return { host: m[1], port }
}

export type ProxyOptions = {
  port: number
  host?: string
  /** The project key of a connection, or null: the proxy serves only known projects. */
  identify: (socket: Socket) => string | null
  lookup?: (host: string) => Promise<string[]>
}

const resolveAll = async (host: string) => (await dnsLookup(host, { all: true })).map((r) => r.address)

export function startEgressProxy(o: ProxyOptions): Server {
  const resolve = o.lookup ?? resolveAll
  const server = createServer((socket) => {
    socket.on('error', () => {})
    socket.setTimeout(15_000, () => socket.destroy())
    let buffered = Buffer.alloc(0)
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk])
      const end = buffered.indexOf('\r\n\r\n')
      if (end < 0) {
        if (buffered.length > MAX_HEAD) refuse(socket, '431 Request Header Fields Too Large', 'headers too large')
        return
      }
      socket.pause()
      socket.off('data', onData)
      const head = buffered.subarray(0, end).toString('latin1')
      handle(socket, head, buffered.subarray(end + 4)).catch(() => socket.destroy())
    }
    socket.on('data', onData)
  })

  async function handle(socket: Socket, head: string, rest: Buffer) {
    const lines = head.split('\r\n')
    const request = /^([A-Z]+) (\S+) HTTP\/1\.[01]$/.exec(lines[0])
    if (!request) return refuse(socket, '400 Bad Request', 'not an HTTP request')
    const key = o.identify(socket)
    const compiled = key ? egressOf(key) : null
    if (!key || compiled?.mode !== 'allowlist')
      return refuse(socket, '403 Forbidden', 'the proxy only serves projects with an allowlist')
    const [, method, target] = request
    const tunnel = method === 'CONNECT'
    let host: string
    let port: number
    let path = ''
    if (tunnel) {
      const authority = parseAuthority(target)
      if (!authority) return refuse(socket, '400 Bad Request', 'invalid target')
      ;({ host, port } = authority)
    } else {
      let url: URL
      try {
        url = new URL(target)
      } catch {
        return refuse(socket, '400 Bad Request', 'invalid target')
      }
      if (url.protocol !== 'http:' || url.username || url.password)
        return refuse(socket, '400 Bad Request', 'only http:// or CONNECT')
      host = url.hostname
      port = Number(url.port || 80)
      path = url.pathname + url.search
    }
    const check = hostAllowed(compiled, host, port)
    const shown = `${check.host.includes(':') ? `[${check.host}]` : check.host}:${port}`
    if (!check.ok) {
      noteBlocked(key, shown)
      return refuse(socket, '403 Forbidden', `${shown} is not on the project's allowlist`)
    }
    // A name on the list must not lead into the container or the LAN; an IP on the list may.
    let address = check.host
    if (!check.literal) {
      const addresses = await resolve(check.host).catch(() => [] as string[])
      const external = addresses.find((a) => !isInternal(a))
      if (!external) {
        noteBlocked(key, shown)
        return refuse(socket, addresses.length ? '403 Forbidden' : '502 Bad Gateway',
          addresses.length ? `${shown} points to an internal address` : `${shown} cannot be resolved`)
      }
      address = external
    }
    const upstream = connect({ host: address, port })
    upstream.setTimeout(15_000, () => upstream.destroy())
    upstream.on('error', () => {
      if (socket.writable && !socket.destroyed) refuse(socket, '502 Bad Gateway', `${shown} not reachable`)
      socket.destroy()
    })
    upstream.on('connect', () => {
      if (socket.destroyed) return upstream.destroy()
      upstream.setTimeout(0)
      socket.setTimeout(0)
      upstream.removeAllListeners('error')
      upstream.on('error', () => socket.destroy())
      socket.on('error', () => upstream.destroy())
      socket.on('close', () => upstream.destroy())
      upstream.on('close', () => socket.destroy())
      if (tunnel) socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      else upstream.write(forwardHead(method, path, check.host, port, lines.slice(1)))
      if (rest.length) upstream.write(rest)
      socket.pipe(upstream)
      upstream.pipe(socket)
      socket.resume()
    })
  }

  server.on('error', (error) => console.error(`egress proxy: ${error.message}`))
  server.listen(o.port, o.host ?? '127.0.0.1')
  return server
}

const HOP_HEADERS = /^(proxy-authorization|proxy-connection|connection|keep-alive|host):/i

/**
 * A plain HTTP request for the origin. Host follows the checked URL, not what the client wrote,
 * and the connection closes after one response: a second request on it could name another host.
 */
function forwardHead(method: string, path: string, host: string, port: number, headers: string[]) {
  const name = host.includes(':') ? `[${host}]` : host
  const kept = headers.filter((line) => line && !HOP_HEADERS.test(line))
  return [`${method} ${path || '/'} HTTP/1.1`, `Host: ${port === 80 ? name : `${name}:${port}`}`, ...kept, 'Connection: close', '', ''].join('\r\n')
}
