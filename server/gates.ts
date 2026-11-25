// Approval gates: rules that hold a branch before it lands until the owner approves it.
// A gate never refuses work, it only asks. The owner's approval is bound to one commit (the tip
// of the branch when it was held), so anything pushed after that needs a new approval.
//
// Only pure helpers and the git reads for the dependency check live here; landing.ts decides.
import { gitIn } from './sandbox.ts'

export type ApprovalSettings = {
  /** Every landing waits for the owner. */
  merge: boolean
  /** A branch that adds a dependency waits. Version bumps of known dependencies do not. */
  dependencies: boolean
  /** A branch that changes a file matching one of infraGlobs waits. */
  infra: boolean
  infraGlobs: string[]
}

export const DEFAULT_INFRA_GLOBS = [
  'Dockerfile',
  'Dockerfile.*',
  '*.dockerfile',
  'docker/**',
  '.github/**',
  '*.tf',
  '*.tfvars',
  'k8s/**',
  'compose*.yml',
  'compose*.yaml',
  'docker-compose*.yml',
  'docker-compose*.yaml',
]

// ---------- globs ----------

/**
 * Glob to regex, the way .gitignore reads them: a pattern without "/" matches the file name in
 * any folder, one with "/" is anchored at the repository root. "**" crosses folders, "*" and "?"
 * do not. Everything else is literal, so a pattern can never turn into a regex of its own.
 */
export function globToRegExp(glob: string): RegExp {
  let pattern = glob.trim().replace(/^\.\//, '')
  // "docker/" means everything below docker, and is anchored like "docker/**".
  if (pattern.endsWith('/')) pattern += '**'
  const anchored = pattern.includes('/')
  if (pattern.startsWith('/')) pattern = pattern.slice(1)
  let out = ''
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]
    if (char === '*' && pattern[i + 1] === '*') {
      i++
      if (pattern[i + 1] === '/') {
        i++
        out += '(?:.*/)?' // "a/**/b" also matches "a/b"
      } else out += '.*'
    } else if (char === '*') out += '[^/]*'
    else if (char === '?') out += '[^/]'
    else out += char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(anchored ? `^${out}$` : `(?:^|/)${out}$`)
}

// The globs come from the project settings and change rarely; landings ask often. Compiled once.
const compiled = new Map<string, RegExp[]>()
function matchersOf(globs: string[]) {
  const key = globs.join('\n')
  let matchers = compiled.get(key)
  if (!matchers) {
    if (compiled.size > 100) compiled.clear()
    matchers = globs.filter((glob) => glob.trim()).map(globToRegExp)
    compiled.set(key, matchers)
  }
  return matchers
}

/** The changed files that match one of the infrastructure globs. */
export function infraFiles(files: string[], globs: string[]) {
  const matchers = matchersOf(globs)
  return files.filter((file) => matchers.some((matcher) => matcher.test(file)))
}

// ---------- dependencies ----------

const MANIFESTS: [RegExp, (text: string) => Set<string>][] = [
  [
    /(^|\/)package\.json$/,
    (text) => jsonKeys(text, ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']),
  ],
  [/(^|\/)composer\.json$/, (text) => jsonKeys(text, ['require', 'require-dev'])],
  [/(^|\/)requirements[^/]*\.txt$/, requirementsNames],
  [/(^|\/)pyproject\.toml$/, pyprojectNames],
  [/(^|\/)Cargo\.toml$/, cargoNames],
  [/(^|\/)go\.mod$/, goModNames],
  [/(^|\/)Gemfile$/, gemfileNames],
]

export const isManifest = (file: string) => MANIFESTS.some(([pattern]) => pattern.test(file))

/**
 * The dependencies a manifest gains from before to after, by name. A version bump of a known
 * dependency is not new. A file that cannot be read counts as one unknown new dependency: a gate
 * that fails open would be no gate.
 */
export function addedDependencies(file: string, before: string, after: string): string[] {
  const parse = MANIFESTS.find(([pattern]) => pattern.test(file))?.[1]
  if (!parse) return []
  let now: Set<string>
  try {
    now = parse(after)
  } catch {
    return [`${file} (not readable)`]
  }
  let old = new Set<string>()
  try {
    if (before) old = parse(before)
  } catch {
    // The old state was broken; everything in the new one counts as new.
  }
  return [...now].filter((name) => !old.has(name))
}

function jsonKeys(text: string, sections: string[]) {
  const data = JSON.parse(text)
  const names = new Set<string>()
  for (const section of sections) {
    const deps = data?.[section]
    if (!deps || typeof deps !== 'object' || Array.isArray(deps)) continue
    for (const name of Object.keys(deps)) names.add(name)
  }
  return names
}

/** PEP 503: names compare case-insensitively, with runs of "-", "_" and "." alike. */
const pythonName = (name: string) => name.trim().toLowerCase().replace(/[-_.]+/g, '-')

/** The name at the start of a PEP 508 requirement, e.g. "requests[socks]>=2; python_version>'3'". */
const requirementName = (spec: string) => {
  const match = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(spec)
  return match ? pythonName(match[1]) : ''
}

function requirementsNames(text: string) {
  const names = new Set<string>()
  for (const raw of text.split('\n')) {
    const line = raw.replace(/(^|\s)#.*$/, '').trim()
    if (!line) continue
    const editable = /^(?:-e|--editable)\s*=?\s*(\S+)/.exec(line)
    if (editable) {
      // A path or VCS URL is a dependency too; "#egg=" names it when present.
      const egg = /[#&]egg=([A-Za-z0-9._-]+)/.exec(raw)
      names.add(egg ? pythonName(egg[1]) : editable[1])
      continue
    }
    if (line.startsWith('-')) continue // -r other.txt, --index-url and the like: not a dependency
    // A bare URL or path has no name; the line itself identifies it.
    const bare = /^[a-z][a-z0-9+.-]*:\/\//i.test(line) || line.startsWith('.') || line.startsWith('/')
    const name = bare ? line : requirementName(line)
    if (name) names.add(name)
  }
  return names
}

/**
 * A small TOML reader for what manifests use: [section] headers, "key = value" lines and string
 * arrays that may span lines. Calls visit for each key with its section and the strings in its value.
 */
function tomlEntries(text: string, visit: (section: string, key: string, strings: string[]) => void) {
  let section = ''
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = stripTomlComment(lines[i]).trim()
    if (!line) continue
    const header = /^\[\[?\s*([^\]]+?)\s*\]\]?$/.exec(line)
    if (header) {
      section = header[1].replace(/\s*\.\s*/g, '.').replace(/"/g, '')
      visit(section, '', [])
      continue
    }
    const entry = /^("[^"]*"|'[^']*'|[A-Za-z0-9_.-]+)\s*=\s*(.*)$/.exec(line)
    if (!entry) continue
    const key = entry[1].replace(/^["']|["']$/g, '')
    let value = entry[2]
    if (value.startsWith('[')) {
      // Collect a multi-line array up to its closing bracket.
      while (!arrayClosed(value) && i + 1 < lines.length) value += '\n' + stripTomlComment(lines[++i])
    }
    visit(section, key, [...value.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g)].map((m) => m[1] ?? m[2]))
  }
}

function stripTomlComment(line: string) {
  let quote = ''
  for (let i = 0; i < line.length; i++) {
    const char = line[i]
    if (quote) {
      if (char === '\\' && quote === '"') i++
      else if (char === quote) quote = ''
    } else if (char === '"' || char === "'") quote = char
    else if (char === '#') return line.slice(0, i)
  }
  return line
}

function arrayClosed(value: string) {
  let depth = 0
  let quote = ''
  for (let i = 0; i < value.length; i++) {
    const char = value[i]
    if (quote) {
      if (char === '\\' && quote === '"') i++
      else if (char === quote) quote = ''
    } else if (char === '"' || char === "'") quote = char
    else if (char === '[') depth++
    else if (char === ']' && --depth === 0) return true
  }
  return false
}

function pyprojectNames(text: string) {
  const names = new Set<string>()
  tomlEntries(text, (section, key, strings) => {
    if (!key) return
    // PEP 621 and PEP 735: lists of requirement strings.
    const listed =
      (section === 'project' && key === 'dependencies') ||
      section === 'project.optional-dependencies' ||
      section === 'dependency-groups' ||
      (section === 'build-system' && key === 'requires')
    if (listed) for (const spec of strings) requirementName(spec) && names.add(requirementName(spec))
    // Poetry: one key per dependency.
    const poetry = /^tool\.poetry\.(?:dependencies|dev-dependencies|group\.[^.]+\.dependencies)$/.test(section)
    if (poetry && key !== 'python') names.add(pythonName(key))
  })
  return names
}

const CARGO_DEPS = /^(?:(?:workspace|target\..+)\.)?(?:dependencies|dev-dependencies|build-dependencies)$/
const CARGO_DEP_TABLE = new RegExp(`${CARGO_DEPS.source.slice(0, -1)}\\.([^.]+)$`)

function cargoNames(text: string) {
  const names = new Set<string>()
  tomlEntries(text, (section, key) => {
    if (CARGO_DEPS.test(section)) {
      // serde.workspace = true is still serde.
      if (key) names.add(key.split('.')[0])
      return
    }
    // [dependencies.serde] names the dependency in its header.
    const table = CARGO_DEP_TABLE.exec(section)
    if (table && !key) names.add(table[1])
  })
  return names
}

function goModNames(text: string) {
  const names = new Set<string>()
  let inRequire = false
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\/\/.*$/, '').trim()
    if (inRequire) {
      if (line.startsWith(')')) inRequire = false
      else if (line) names.add(line.split(/\s+/)[0])
      continue
    }
    if (/^require\s*\($/.test(line)) inRequire = true
    else {
      const single = /^require\s+(\S+)/.exec(line)
      if (single) names.add(single[1])
    }
  }
  return names
}

function gemfileNames(text: string) {
  const names = new Set<string>()
  for (const match of text.matchAll(/^\s*gem\s*\(?\s*["']([^"']+)["']/gm)) names.add(match[1])
  return names
}

// ---------- reading the branch ----------

/** A file's content at a commit, '' when it does not exist there. Blobs are read raw, no filters. */
async function fileAt(repo: string, commit: string, file: string) {
  try {
    return (await gitIn(repo, ['cat-file', 'blob', `${commit}:${file}`])).stdout
  } catch {
    return ''
  }
}

/** The dependencies the branch adds, per manifest, compared to where it forked from the base. */
export async function newDependencies(repo: string, forkPoint: string, tip: string, files: string[]) {
  const added: string[] = []
  for (const file of files.filter(isManifest)) {
    const [before, after] = await Promise.all([fileAt(repo, forkPoint, file), fileAt(repo, tip, file)])
    if (!after) continue // deleted
    for (const name of addedDependencies(file, before, after)) added.push(`${name} (${file})`)
  }
  return added
}

/**
 * Why a branch has to wait for the owner, empty when it may land on its own. protected lists the
 * files under the project's protected paths, which wait for the owner as well.
 */
export async function gateReasons(
  repo: string,
  forkPoint: string,
  tip: string,
  files: string[],
  settings: ApprovalSettings,
  protectedFiles: string[],
): Promise<string[]> {
  const reasons: string[] = []
  if (protectedFiles.length) reasons.push(`protected files: ${list(protectedFiles)}`)
  if (settings.infra) {
    const infra = infraFiles(files, settings.infraGlobs)
    if (infra.length) reasons.push(`infrastructure files: ${list(infra)}`)
  }
  if (settings.dependencies) {
    const deps = await newDependencies(repo, forkPoint, tip, files)
    if (deps.length) reasons.push(`new dependencies: ${list(deps)}`)
  }
  if (settings.merge && !reasons.length) reasons.push('every landing needs your approval')
  return reasons
}

const list = (items: string[]) =>
  items.slice(0, 5).join(', ') + (items.length > 5 ? ` and ${items.length - 5} more` : '')
