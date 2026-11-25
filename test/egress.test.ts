import './setup.ts'
import assert from 'node:assert/strict'
import { createServer as createHttp } from 'node:http'
import { connect, createServer, type AddressInfo, type Server } from 'node:net'
import { after, before, test } from 'node:test'
import { defaultSettings, mergeSettings } from '../server/core.ts'
import {
  compileEgress,
  configureEgress,
  DEFAULT_ALLOW,
  EGRESS_PORT,
  egressEnv,
  egressStatus,
  hostAllowed,
  isInternal,
  keyOfUser,
  normalizeAllow,
  parseAuthority,
  parsePattern,
  startEgressProxy,
  uidOfPeer,
} from '../server/egress.ts'
import { envFor } from '../server/sandbox.ts'

const allows = (list: string[], host: string, port = 443) =>
  hostAllowed(compileEgress({ mode: 'allowlist', allow: list }), host, port).ok

test('patterns: valid entries kept in one spelling, the rest dropped', () => {
  assert.deepEqual(
    normalizeAllow([' GitHub.com ', '*.OpenAI.com', 'example.org:8443', '[0:0::1]:22', '192.0.2.7', 'github.com', '*', '*.', 'a;rm -rf', 'x:0', 'x:70000', 'host:22:1', '127.1', '0x7f.1', 'http://a.com', '*.*.a.com']),
    ['github.com', '*.openai.com', 'example.org:8443', '[::1]:22', '192.0.2.7'],
  )
  assert.equal(parsePattern('*.192.0.2.7'), null)
  assert.deepEqual(normalizeAllow(undefined), DEFAULT_ALLOW)
  assert.deepEqual(normalizeAllow([]), [])
  assert.equal(normalizeAllow(Array.from({ length: 500 }, (_, i) => `h${i}.example.com`)).length, 200)
})

test('hosts: exact names, wildcards only for subdomains, no suffix tricks', () => {
  const list = ['github.com', '*.openai.com']
  assert.ok(allows(list, 'github.com'))
  assert.ok(allows(list, 'GitHub.com.'))
  assert.ok(!allows(list, 'evilgithub.com'))
  assert.ok(!allows(list, 'github.com.evil.com'))
  assert.ok(!allows(list, 'api.github.com'))
  assert.ok(allows(list, 'api.openai.com'))
  assert.ok(allows(list, 'a.b.openai.com'))
  assert.ok(!allows(list, 'openai.com'))
  assert.ok(!allows(list, 'evilopenai.com'))
  assert.ok(!allows(list, 'openai.com.evil.com'))
  assert.ok(!allows(list, 'github.com\x00.evil.com'))
  assert.ok(!allows(list, ''))
})

test('ports: 80 and 443 unless the entry names one', () => {
  assert.ok(allows(['github.com'], 'github.com', 80))
  assert.ok(!allows(['github.com'], 'github.com', 22))
  assert.ok(!allows(['*.openai.com'], 'api.openai.com', 8080))
  assert.ok(allows(['git.example.com:2222'], 'git.example.com', 2222))
  assert.ok(!allows(['git.example.com:2222'], 'git.example.com', 443))
})

test('IP literals: only an entry with that address allows them', () => {
  assert.ok(!allows(['*.github.com', 'github.com'], '140.82.121.4'))
  assert.ok(allows(['140.82.121.4'], '140.82.121.4'))
  assert.ok(allows(['[2001:db8::1]'], '[2001:DB8:0::1]'))
  assert.ok(!allows(['140.82.121.4'], '140.82.121.5'))
  // Forms getaddrinfo would read as 127.0.0.1 are no hostnames.
  for (const host of ['127.1', '2130706433', '0x7f.1', '0x7f000001', '017700000001', 'a.0x1'])
    assert.ok(!allows(['*.1', '127.1', '*.0x1'], host), host)
})

test('internal addresses: loopback, private, link-local, mapped', () => {
  for (const a of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '0.0.0.0', '100.64.0.1', '::1', '::', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '224.0.0.1', 'nonsense'])
    assert.ok(isInternal(a), a)
  for (const a of ['140.82.121.4', '2606:4700::1111', '8.8.8.8']) assert.ok(!isInternal(a), a)
})

test('CONNECT authority needs a host and a valid port', () => {
  assert.deepEqual(parseAuthority('github.com:443'), { host: 'github.com', port: 443 })
  assert.deepEqual(parseAuthority('[::1]:22'), { host: '[::1]', port: 22 })
  for (const bad of ['github.com', 'github.com:0', 'github.com:65536', 'a:b:443', '[::1]', ':443', 'x:443/y'])
    assert.equal(parseAuthority(bad), null, bad)
})

test('the uid of a peer comes from the client side of the socket in /proc/net/tcp', () => {
  const table = [
    '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
    '   0: 0100007F:2257 0100007F:A1B2 01 00000000:00000000 00:00000000 00000000  1000        0 1 1',
    '   1: 0100007F:A1B2 0100007F:2257 01 00000000:00000000 00:00000000 00000000 20001        0 2 1',
  ].join('\n')
  // Little-endian hosts write 127.0.0.1 as 0100007F; the tests run on those.
  const socket = { remoteAddress: '127.0.0.1', remotePort: 0xa1b2, localAddress: '127.0.0.1', localPort: 0x2257 } as any
  assert.equal(uidOfPeer(socket, () => table), 20001)
  assert.equal(uidOfPeer({ ...socket, remotePort: 1 }, () => table), null)
  assert.equal(uidOfPeer({ ...socket, remoteAddress: '::1' }, () => table), null)
})

test('project keys from user names', () => {
  assert.equal(keyOfUser('ad-shop'), 'SHOP')
  assert.equal(keyOfUser('ad-a1b2'), 'A1B2')
  for (const name of ['node', 'ad-', 'ad-Shop', 'ad-1abc', 'ad-shop/x', 'xad-shop']) assert.equal(keyOfUser(name), null, name)
})

test('settings: open by default, garbage stays open', () => {
  assert.deepEqual(defaultSettings().egress, { mode: 'open', allow: DEFAULT_ALLOW })
  assert.equal(mergeSettings({ egress: { mode: 'everything' } }).egress.mode, 'open')
  assert.deepEqual(mergeSettings({ egress: { mode: 'allowlist', allow: ['x.com', 'bad host'] } }).egress, {
    mode: 'allowlist',
    allow: ['x.com'],
  })
  assert.deepEqual(mergeSettings({}).egress.allow, DEFAULT_ALLOW)
})

test('env: allowlist projects get the proxy, open ones nothing, secrets never', () => {
  configureEgress('ENVA', { mode: 'allowlist', allow: ['github.com'] })
  configureEgress('ENVO', { mode: 'open', allow: [] })
  const proxy = `http://127.0.0.1:${EGRESS_PORT}`
  const env = envFor({ name: 'ad-enva', home: '/data/homes/ad-enva' }, {
    PATH: '/usr/bin',
    HTTPS_PROXY: 'http://elsewhere:3128',
    all_proxy: 'socks5://elsewhere',
    AGENTDECK_TOKEN: 'secret',
    AGENTDECK_PROXY_SECRET: 'secret',
  })
  for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'])
    assert.equal(env[name], proxy, name)
  assert.equal(env.NO_PROXY, '127.0.0.1,localhost,::1')
  assert.equal(env.no_proxy, '127.0.0.1,localhost,::1')
  assert.equal(env.AGENTDECK_TOKEN, undefined)
  assert.equal(env.AGENTDECK_PROXY_SECRET, undefined)
  assert.equal(env.HOME, '/data/homes/ad-enva')

  const open = envFor({ name: 'ad-envo', home: '/h' }, { PATH: '/usr/bin', HTTPS_PROXY: 'http://corp:3128' })
  assert.equal(open.HTTPS_PROXY, 'http://corp:3128')
  assert.equal(open.HTTP_PROXY, undefined)
  assert.deepEqual(egressEnv(null), {})
  assert.deepEqual(egressEnv('UNKNOWN'), {})
})

// ---------- the proxy itself ----------

let proxy: Server
let web: ReturnType<typeof createHttp>
let echo: Server
let proxyPort = 0
let webPort = 0
let echoPort = 0
let who: string | null = 'PX'
let seen: Record<string, string | string[] | undefined> = {}

const portOf = (server: { address(): unknown }) => (server.address() as AddressInfo).port
const listening = (server: Server | ReturnType<typeof createHttp>) =>
  new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))

before(async () => {
  web = createHttp((req, res) => {
    seen = { ...req.headers, url: req.url }
    res.end('hello')
  })
  echo = createServer((socket) => socket.pipe(socket))
  await Promise.all([listening(web), listening(echo)])
  webPort = portOf(web)
  echoPort = portOf(echo)
  proxy = startEgressProxy({
    port: 0,
    identify: () => who,
    lookup: async (host) => (host === 'inside.test' ? ['10.0.0.5'] : []),
  })
  await new Promise<void>((resolve) => (proxy.listening ? resolve() : proxy.once('listening', () => resolve())))
  proxyPort = portOf(proxy)
  configureEgress('PX', { mode: 'allowlist', allow: [`127.0.0.1:${webPort}`, `127.0.0.1:${echoPort}`, 'inside.test', 'nowhere.test'] })
  configureEgress('PXOPEN', { mode: 'open', allow: [`127.0.0.1:${webPort}`] })
})

after(() => {
  proxy.close()
  web.close()
  echo.close()
})

/** Sends `request` to the proxy and returns everything until the proxy closes (or `until` shows). */
function send(request: string, until?: string, then?: string) {
  return new Promise<string>((resolve, reject) => {
    const socket = connect(proxyPort, '127.0.0.1')
    let out = ''
    let sent = false
    socket.on('data', (d) => {
      out += d
      if (then && !sent && out.includes('\r\n\r\n')) {
        sent = true
        socket.write(then)
      }
      if (until && out.includes(until)) socket.end()
    })
    socket.on('error', reject)
    socket.on('close', () => resolve(out))
    socket.write(request)
  })
}

test('proxy: plain http to an allowed target, with Host from the URL and no proxy headers', async () => {
  const out = await send(
    `GET http://127.0.0.1:${webPort}/path?q=1 HTTP/1.1\r\nHost: evil.example\r\nProxy-Authorization: Basic eA==\r\nProxy-Connection: keep-alive\r\n\r\n`,
  )
  assert.match(out, /^HTTP\/1\.1 200/)
  assert.match(out, /hello$/)
  assert.equal(seen.url, '/path?q=1')
  assert.equal(seen.host, `127.0.0.1:${webPort}`)
  assert.equal(seen['proxy-authorization'], undefined)
  assert.equal(seen['proxy-connection'], undefined)
  assert.equal(seen.connection, 'close')
})

test('proxy: CONNECT to an allowed target tunnels bytes both ways', async () => {
  const out = await send(`CONNECT 127.0.0.1:${echoPort} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n`, 'ping', 'ping')
  assert.match(out, /^HTTP\/1\.1 200 Connection Established\r\n\r\nping/)
})

test('proxy: CONNECT to a port the list does not name is refused', async () => {
  const out = await send('CONNECT 127.0.0.1:22 HTTP/1.1\r\n\r\n')
  assert.match(out, /^HTTP\/1\.1 403/)
  assert.match(out, /allowlist/)
})

test('proxy: hosts off the list are refused and shown on the settings page', async () => {
  const out = await send('CONNECT evilgithub.com:443 HTTP/1.1\r\n\r\n')
  assert.match(out, /^HTTP\/1\.1 403/)
  assert.ok(egressStatus('PX').blocked.some((b) => b.target === 'evilgithub.com:443'))
  assert.match(await send('GET http://localhost:80/ HTTP/1.1\r\n\r\n'), /^HTTP\/1\.1 403/)
  assert.match(await send('CONNECT 2130706433:443 HTTP/1.1\r\n\r\n'), /^HTTP\/1\.1 403/)
})

test('proxy: a name on the list that resolves inside is refused', async () => {
  const out = await send('CONNECT inside.test:443 HTTP/1.1\r\n\r\n')
  assert.match(out, /^HTTP\/1\.1 403/)
  assert.match(out, /internal address/)
  assert.match(await send('CONNECT nowhere.test:443 HTTP/1.1\r\n\r\n'), /^HTTP\/1\.1 502/)
})

test('proxy: unknown connections, open projects and odd requests get nothing', async () => {
  who = null
  assert.match(await send(`CONNECT 127.0.0.1:${echoPort} HTTP/1.1\r\n\r\n`), /^HTTP\/1\.1 403/)
  who = 'PXOPEN'
  assert.match(await send(`GET http://127.0.0.1:${webPort}/ HTTP/1.1\r\n\r\n`), /^HTTP\/1\.1 403/)
  who = 'PX'
  assert.match(await send(`GET https://127.0.0.1:${webPort}/ HTTP/1.1\r\n\r\n`), /^HTTP\/1\.1 400/)
  assert.match(await send(`GET http://u:p@127.0.0.1:${webPort}/ HTTP/1.1\r\n\r\n`), /^HTTP\/1\.1 400/)
  assert.match(await send('GET /relative HTTP/1.1\r\n\r\n'), /^HTTP\/1\.1 400/)
  assert.match(await send('garbage\r\n\r\n'), /^HTTP\/1\.1 400/)
  assert.match(await send('GET http://a/ HTTP/1.1\r\nX: ' + 'a'.repeat(20_000)), /^HTTP\/1\.1 431/)
})
