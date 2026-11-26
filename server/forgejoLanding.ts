import { readFileSync } from 'node:fs'
import { t } from './i18n.ts'

const CONFIG = '/run/agentdeck-forgejo/projects.json'
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const SHA = /^[a-f0-9]{40}$/

type ForgejoConfig = {
  api: string
  repository: string
  origin: string
  tokenFile: string
  requiredChecks: string[]
}

type ForgejoRef = { ref: string; sha: string; repo?: { full_name: string } }
type Pull = { number: number; state: string; merged: boolean; head: ForgejoRef; base: ForgejoRef }
type CommitStatus = { id: number; context: string; status: string }
type Verdict = { verdict: 'pass' | 'pending' | 'fail'; failed: string[] }

export function requiredForgejoChecks(required: string[], statuses: CommitStatus[]): Verdict {
  const current = new Map<string, CommitStatus>()
  for (const item of statuses) {
    if ((current.get(item.context)?.id ?? -1) < item.id) current.set(item.context, item)
  }
  const states = required.map((context) => [context, current.get(context)?.status] as const)
  const failed = states.filter(([, status]) => status === 'failure' || status === 'error').map(([key]) => key)
  if (failed.length) return { verdict: 'fail', failed }
  return { verdict: required.length && states.every(([, state]) => state === 'success') ? 'pass' : 'pending', failed }
}

export function validateForgejoConfig(value: unknown): ForgejoConfig {
  if (!value || typeof value !== 'object') throw new Error(t('Ungültige Forgejo-Landing-Konfiguration.'))
  const config = value as ForgejoConfig
  const api = new URL(config.api)
  const origin = new URL(config.origin)
  if (!['http:', 'https:'].includes(api.protocol) || api.username || api.password ||
      api.pathname !== '/api/v1/' || api.search || api.hash ||
      origin.protocol !== 'ssh:' || origin.username !== 'git' || origin.password || origin.search || origin.hash ||
      !REPO.test(config.repository) || origin.pathname !== `/${config.repository}.git` ||
      typeof config.tokenFile !== 'string' || !/^\/run\/agentdeck-forgejo\/[A-Za-z0-9_.-]+\.token$/.test(config.tokenFile) ||
      !Array.isArray(config.requiredChecks) || !config.requiredChecks.length ||
      config.requiredChecks.some((key) => typeof key !== 'string' || !/^[A-Za-z0-9_.\/:-]+$/.test(key)) ||
      new Set(config.requiredChecks).size !== config.requiredChecks.length) {
    throw new Error(t('Ungültige Forgejo-Landing-Konfiguration.'))
  }
  return config
}

/** Config is operator-owned, not supplied by an issue, API client or project checkout. */
export function forgejoLandingFor(key: string): ForgejoLanding | null {
  let raw: string
  try {
    raw = readFileSync(CONFIG, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  const configs = JSON.parse(raw)
  if (!Object.hasOwn(configs, key)) return null
  const config = validateForgejoConfig(configs[key])
  const token = readFileSync(config.tokenFile, 'utf8').trim()
  if (!/^[a-f0-9]{40}$/.test(token)) throw new Error(t('Forgejo-Landing-Token fehlt oder ist ungültig.'))
  return new ForgejoLanding(config, token)
}

export class ForgejoLanding {
  private config: ForgejoConfig
  private token: string
  private request: typeof fetch

  constructor(config: ForgejoConfig, token: string, request = fetch) {
    this.config = config
    this.token = token
    this.request = request
  }

  get origin() { return this.config.origin }

  private async api<T>(suffix: string, data?: object): Promise<T> {
    const url = new URL(`repos/${this.config.repository}/${suffix}`, this.config.api)
    const response = await this.request(url, {
      method: data ? 'POST' : 'GET',
      headers: { Authorization: `token ${this.token}`, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: data ? JSON.stringify(data) : undefined,
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) throw new Error(t('Forgejo-API: HTTP {status}.', { status: response.status }))
    if (response.status === 204) return undefined as T
    return response.json() as Promise<T>
  }

  matches(pull: Pull, branch: string, base: string) {
    const repo = this.config.repository.toLowerCase()
    return pull.head.ref === branch && pull.base.ref === base &&
      pull.head.repo?.full_name.toLowerCase() === repo && pull.base.repo?.full_name.toLowerCase() === repo
  }

  async open(branch: string, base: string, tip: string, title: string, body: string) {
    if (!SHA.test(tip)) throw new Error(t('Ungültiger Commit für Forgejo-Landung.'))
    let pull: Pull | undefined
    for (let page = 1; ; page++) {
      const found = await this.api<Pull[]>(`pulls?state=open&limit=50&page=${page}`)
      pull = found.find((candidate) => this.matches(candidate, branch, base))
      if (pull || found.length < 50) break
      if (page >= 20) throw new Error(t('Zu viele offene Forgejo-Pull-Requests.'))
    }
    pull ??= await this.api<Pull>('pulls', { head: branch, base, title, body })
    if (!this.matches(pull, branch, base) || pull.head.sha !== tip ||
        !Number.isSafeInteger(pull.number) || pull.number < 1) {
      throw new Error(t('Der Forgejo-Pull-Request passt nicht zum geprüften Branch und Commit.'))
    }
    return pull.number
  }

  view(number: number) {
    if (!Number.isSafeInteger(number) || number < 1) throw new Error(t('Ungültige Forgejo-Pull-Request-Nummer.'))
    return this.api<Pull>(`pulls/${number}`)
  }

  /**
   * Whether this pull request brought exactly this commit into the base branch. Forgejo deletes
   * the branch after a squash merge and then reports the head as refs/pull/<n>/head, so the
   * branch name cannot be compared here; the commit and the base are what count.
   */
  async merged(number: number, sha: string, base: string) {
    if (!SHA.test(sha)) throw new Error(t('Ungültiger Commit für Forgejo-Landung.'))
    const pull = await this.view(number)
    return pull.number === number && pull.merged === true && pull.head.sha === sha && pull.base.ref === base &&
      pull.base.repo?.full_name.toLowerCase() === this.config.repository.toLowerCase()
  }

  async checks(sha: string): Promise<Verdict> {
    if (!SHA.test(sha)) throw new Error(t('Ungültiger Commit für Forgejo-CI.'))
    const result = await this.api<{ statuses: CommitStatus[] }>(`commits/${sha}/status`)
    return requiredForgejoChecks(this.config.requiredChecks, result.statuses)
  }

  merge(number: number, sha: string, method: 'merge' | 'squash' | 'rebase') {
    if (!Number.isSafeInteger(number) || number < 1 || !SHA.test(sha)) throw new Error(t('Ungültiger Forgejo-Merge.'))
    return this.api<void>(`pulls/${number}/merge`, {
      Do: method,
      head_commit_id: sha,
      force_merge: false,
      delete_branch_after_merge: method !== 'merge',
    })
  }
}
