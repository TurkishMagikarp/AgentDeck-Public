// Branch preview: when a maker hands work to review, the project's preview command starts the app
// from the issue's checkout, Playwright takes a desktop and a phone screenshot, and the app stops
// again. Owner and reviewer see what changed without starting anything themselves.
import { existsSync, readdirSync } from 'node:fs'
import { copyFile, mkdir } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { DATA_DIR } from './db.ts'
import { safeEnv } from './auth.ts'
import { execIn, ownerOf, spawnShellIn, stopGroup } from './sandbox.ts'
const PLAYWRIGHT = 'playwright@1.65.0'
const START_TIMEOUT_MS = 90_000

export type PreviewSettings = { command: string; path: string }

export const shotsDir = (issueId: number) => join(DATA_DIR, 'shots', String(issueId))

/** The screenshots of an issue, newest first, as file names. */
export function listShots(issueId: number) {
  const dir = shotsDir(issueId)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => name.endsWith('.png'))
    .sort()
    .reverse()
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number }
      server.close(() => resolve(port))
    })
  })
}

async function waitUntilServing(url: string, exited: () => boolean) {
  const deadline = Date.now() + START_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (exited()) throw new Error('The preview command exited before the app answered')
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) })
      if (res.status < 500) return
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  throw new Error(`The app did not answer within ${START_TIMEOUT_MS / 1000} s`)
}

/**
 * Starts the preview, takes the screenshots and stops it. Returns the saved file names. Throws
 * with a short reason when the app does not come up or the browser is missing.
 */
export async function capturePreview(input: {
  issueId: number
  runId: number
  cwd: string
  settings: PreviewSettings
  env?: Record<string, string>
}) {
  const port = await freePort()
  const env = safeEnv({ ...input.env, PORT: String(port) })
  const command = input.settings.command.replaceAll('$PORT', String(port))
  // Its own process group, so its children (vite, a dev server) stop with it.
  const child = spawnShellIn(input.cwd, command, {
    env,
    detached: process.platform !== 'win32',
    stdio: 'ignore',
  })
  let exited = false
  child.on('exit', () => (exited = true))

  const dir = shotsDir(input.issueId)
  await mkdir(dir, { recursive: true })
  // Playwright runs as the project user, which cannot write to the server's data. It saves into
  // the project's home, and the server copies the pictures over.
  const owner = ownerOf(input.cwd)
  const saveDir = owner ? join(owner.home, '.agentdeck-shots') : dir
  if (owner) await execIn(input.cwd, 'mkdir', ['-p', saveDir])
  const url = `http://127.0.0.1:${port}${input.settings.path.startsWith('/') ? '' : '/'}${input.settings.path}`
  const views = [
    { name: 'desktop', size: '1280,800' },
    { name: 'phone', size: '390,844' },
  ]

  // A project that pins its own Playwright has the matching browser installed; use that one.
  const ownPlaywright = existsSync(join(input.cwd, 'node_modules', '.bin', 'playwright'))
  const playwright = ownPlaywright ? ['--no-install', 'playwright'] : ['-y', PLAYWRIGHT]

  try {
    await waitUntilServing(url, () => exited)
    const saved: string[] = []
    for (const view of views) {
      const file = `${input.runId}-${view.name}.png`
      await execIn(
        input.cwd,
        'npx',
        [
          ...playwright,
          'screenshot',
          `--viewport-size=${view.size}`,
          '--wait-for-timeout=1500',
          url,
          join(saveDir, file),
        ],
        { cwd: input.cwd, env, timeout: 90_000, shell: process.platform === 'win32' },
      )
      if (owner) {
        await copyFile(join(saveDir, file), join(dir, file))
        await execIn(input.cwd, 'rm', ['-f', join(saveDir, file)])
      }
      saved.push(file)
    }
    return saved
  } catch (error: any) {
    const output = String(error.stderr || error.message)
    if (/playwright install/i.test(output)) {
      throw new Error(
        `The browser for Playwright is missing. Run \`npx ${ownPlaywright ? 'playwright' : PLAYWRIGHT} install chromium\` once in the project.`,
      )
    }
    const reason = output.trim().split('\n').slice(-2).join(' ')
    throw new Error(reason.slice(0, 300))
  } finally {
    stopGroup(child.pid)
  }
}
