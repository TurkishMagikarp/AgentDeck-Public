// Who may do what. Three roles, each including the one below it:
//   viewer:   reads the board, issues, stats; may register a push device and log out.
//   operator: works the board: issues, comments, stopping runs, lessons, landings.
//   admin:    everything that decides what runs or what it costs: projects and their settings,
//             agents, skills, routines, webhooks, providers and logins, keys, mail, users, audit.
// The rules sit in one table instead of on each route, so a new route is never left open by
// accident: an unlisted GET needs viewer, any other unlisted method needs operator.
import { t } from './i18n.ts'

export const ROLES = ['viewer', 'operator', 'admin'] as const
export type Role = (typeof ROLES)[number]

const RANK: Record<Role, number> = { viewer: 0, operator: 1, admin: 2 }
export const isRole = (value: unknown): value is Role => ROLES.includes(value as Role)
export const allows = (has: Role, needs: Role) => RANK[has] >= RANK[needs]

/** 'GET' only reads, 'WRITE' is every other method, '*' both. */
type Rule = [method: 'GET' | 'WRITE' | '*', path: RegExp, role: Role]

const RULES: Rule[] = [
  ['*', /^\/api\/(audit|users)(\/|$)/, 'admin'],
  ['*', /^\/api\/(mail|report|mcp|agent-note)(\/|$)/, 'admin'],
  // The limit that stops the fleet is a decision about cost; pausing the fleet is the operator's.
  ['WRITE', /^\/api\/spend-guard$/, 'admin'],
  ['GET', /^\/api\/me$/, 'viewer'],
  // The MCP endpoint only passes calls on to the routes below, which check the role again.
  ['*', /^\/api\/mcp-server$/, 'viewer'],
  ['WRITE', /^\/api\/logout$/, 'viewer'],
  ['WRITE', /^\/api\/push\/(subscribe|unsubscribe)$/, 'viewer'],
  // The provider list and status show quotas; logins and keys are the owner's.
  ['GET', /^\/api\/providers(\/[^/]+\/status)?$/, 'viewer'],
  ['*', /^\/api\/providers(\/|$)/, 'admin'],
  ['*', /^\/api\/(import|blueprint)(\/|$)/, 'admin'],
  ['WRITE', /^\/api\/templates(\/|$)/, 'admin'],
  ['WRITE', /^\/api\/projects$/, 'admin'],
  ['WRITE', /^\/api\/projects\/\d+$/, 'admin'], // narrowed for pausing in requiredRole
  ['WRITE', /^\/api\/projects\/\d+\/(agents|skills|switch-provider|routines|webhooks)(\/|$)/, 'admin'],
  ['WRITE', /^\/api\/(agents|skills|routines)\/\d+$/, 'admin'],
  ['WRITE', /^\/api\/issues\/\d+\/raise-cap$/, 'admin'],
  // Gates hold what decides what runs (dependencies, infrastructure): the owner's call.
  ['WRITE', /^\/api\/issues\/\d+\/approve-landing$/, 'admin'],
  // What an agent printed or did can hold more than the board shows.
  ['GET', /^\/api\/runs\/\d+\/(log|events)$/, 'operator'],
]

/**
 * The role a request needs. `body` is the parsed JSON body of a write, used only to let an
 * operator pause or resume a project without touching its settings.
 */
export function requiredRole(method: string, path: string, body?: unknown): Role {
  const reads = method === 'GET' || method === 'HEAD'
  for (const [kind, pattern, role] of RULES) {
    if (kind === 'GET' && !reads) continue
    if (kind === 'WRITE' && reads) continue
    if (!pattern.test(path)) continue
    if (role === 'admin' && method === 'PATCH' && /^\/api\/projects\/\d+$/.test(path) && onlyPausing(body))
      return 'operator'
    return role
  }
  return reads ? 'viewer' : 'operator'
}

const onlyPausing = (body: unknown) =>
  !!body &&
  typeof body === 'object' &&
  !Array.isArray(body) &&
  Object.keys(body).length > 0 &&
  Object.keys(body).every((key) => key === 'paused')

/**
 * A path segment that Number() reads as a number but that is not plain digits: "0x1", "1e0", "+1",
 * " 1" (percent-encoded). The rules above match ids as \\d+, while the routes read them with
 * Number(), so such a segment would reach an admin route under the default role. Refused outright.
 */
export function hasOddNumber(path: string) {
  return path.split('/').some((segment) => {
    let decoded: string
    try {
      decoded = decodeURIComponent(segment)
    } catch {
      return true
    }
    return decoded.trim() !== '' && !/^\d+$/.test(decoded) && Number.isFinite(Number(decoded))
  })
}

/** What a role is called in the language of the person asking. */
export const roleLabel = (role: Role) =>
  ({ viewer: t('Lesen'), operator: t('Bedienen'), admin: t('Verwalten') })[role]
