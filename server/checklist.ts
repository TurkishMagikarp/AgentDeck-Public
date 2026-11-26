// Acceptance checklists: what "done" means for one issue, written down before the work starts.
// The maker reports on every item with proof, the server checks what it can (precheck.ts), and
// reviewers judge against the same list. That keeps reviewers from finding new wishes each round.
//
// An issue's list is its "Done when" from the description, split into single items, plus the
// project's templates. Templates are plain text in the project settings:
//
//   ## Karte
//   Agenten: World builder
//   Titel: map, route, karte
//   - Jede Kartenansicht neu aufgenommen, kein Bild einfarbig.
//
//   ## Alle
//   - Nur Dateien geändert, die das Issue verlangt.
//
// A section with "Agenten" and/or "Titel" applies when the issue's agent and/or a title word
// match; only the first such section is used. A section without either applies to every issue.
import { t } from './i18n.ts'
import { prompts } from './prompts/index.ts'

const MAX_ITEMS = 16
const MAX_ITEM_LENGTH = 300

export type Template = { name: string; agents: string[]; titleWords: string[]; items: string[] }

export type Report = {
  /** Item numbers (1-based) the maker marked as met. */
  met: number[]
  /** Item numbers the maker marked as open, or did not mention. */
  open: number[]
  /** The proof text per met item. */
  proofs: Map<number, string>
}

const words = (line: string) =>
  line
    .split(',')
    .map((word) => word.trim().toLowerCase())
    .filter(Boolean)

export function parseTemplates(text: string): Template[] {
  const templates: Template[] = []
  let current: Template | null = null
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    const heading = line.match(/^##\s+(.+)$/)
    if (heading) {
      current = { name: heading[1].trim(), agents: [], titleWords: [], items: [] }
      templates.push(current)
      continue
    }
    if (!current) continue
    const agents = line.match(/^(agenten|agents)\s*:\s*(.*)$/i)
    const title = line.match(/^(titel|title)\s*:\s*(.*)$/i)
    if (agents) current.agents = words(agents[2])
    else if (title) current.titleWords = words(title[2])
    else if (/^[-*]\s+/.test(line)) current.items.push(line.replace(/^[-*]\s+/, '').slice(0, MAX_ITEM_LENGTH))
  }
  return templates.filter((template) => template.items.length)
}

const isGeneral = (template: Template) => !template.agents.length && !template.titleWords.length

function matches(template: Template, title: string, agentName: string) {
  const lowerTitle = title.toLowerCase()
  const agentFits = !template.agents.length || template.agents.includes(agentName.toLowerCase())
  const titleFits =
    !template.titleWords.length || template.titleWords.some((word) => lowerTitle.includes(word))
  return agentFits && titleFits
}

/** A long "Done when" stays one item; cut into sentences it would lose its meaning. */
const MAX_DONE_WHEN_LENGTH = 1500
/** Up to this many sentences, each long enough to stand alone, a "Done when" is split into items. */
const MAX_SPLIT_SENTENCES = 5
const MIN_SENTENCE_LENGTH = 20

const cleanItem = (item: string) =>
  item
    .replace(/^\s*[-*]\s+/, '')
    .trim()
    .replace(/\.$/, '')

/**
 * The "Done when" of a description as checklist items: one per bullet when it is a list, one per
 * sentence when it is a few plain sentences, otherwise the whole text as a single item.
 */
export function doneWhenItems(description: string): string[] {
  const found = description.match(
    /(?:\*\*)?(?:done when|fertig,?\s+wenn)\s*:?\s*(?:\*\*)?\s*:?\s*([\s\S]*?)(?:\n\s*\n|\n\s*\*\*[^*\n]+:\*\*|$)/i,
  )
  const text = found?.[1].trim() ?? ''
  if (!text) return []

  const bullets = text
    .split(/\n\s*[-*]\s+/)
    .map(cleanItem)
    .filter(Boolean)
  if (bullets.length > 1) return bullets.map((item) => item.slice(0, MAX_DONE_WHEN_LENGTH))

  const sentences = text
    .split(/;\s+|(?<=[.!])\s+(?=[A-ZÄÖÜ`])/)
    .map(cleanItem)
    .filter(Boolean)
  const splits =
    sentences.length <= MAX_SPLIT_SENTENCES && sentences.every((s) => s.length >= MIN_SENTENCE_LENGTH)
  if (splits) return sentences
  // The description is in every prompt, so a long text is pointed to rather than copied and cut.
  if (text.length <= MAX_DONE_WHEN_LENGTH) return [cleanItem(text)]
  return [t('Jeder Teil von „Done when“ in der Beschreibung ist erfüllt und einzeln belegt')]
}

/** The checklist an issue gets when it has none yet, and the template it came from. */
export function checklistFor(
  issue: { title: string; description: string },
  agentName: string,
  templatesText: string,
): { items: string[]; template: string } {
  const templates = parseTemplates(templatesText)
  const specific = templates.find(
    (template) => !isGeneral(template) && matches(template, issue.title, agentName),
  )
  const general = templates.filter(isGeneral)
  // The templates' items always make it in; the issue's own items fill the room that is left.
  const fromTemplates = [...(specific?.items ?? []), ...general.flatMap((template) => template.items)]
  const fromIssue = doneWhenItems(issue.description).slice(0, Math.max(0, MAX_ITEMS - fromTemplates.length))
  const unique = [...new Set([...fromIssue, ...fromTemplates])].slice(0, MAX_ITEMS)
  return { items: unique, template: specific?.name ?? '' }
}

/** Splits text an agent or the owner wrote ("a | b", or one item per line) into items. */
export function itemsFromText(text: unknown): string[] {
  return String(text ?? '')
    .split(/\n|\s\|\s/)
    .map((item) => item.replace(/^\s*(?:[-*]|\d+[.)])\s+/, '').trim())
    .filter(Boolean)
    .slice(0, MAX_ITEMS)
    .map((item) => item.slice(0, MAX_ITEM_LENGTH))
}

const MET = /^(ok|done|erledigt|erfüllt|ja|yes|n\/a|entfällt)$/i

/** Reads the maker's <checklist> block. Returns null when there is none. */
export function parseReport(block: string | undefined, count: number): Report | null {
  if (block === undefined) return null
  const met = new Set<number>()
  const proofs = new Map<number, string>()
  for (const line of block.split('\n')) {
    const found = line.match(/^\s*(\d+)[.)]?\s*\[?([a-zäöü/]+)\]?\s*[:—–-]?\s*(.*)$/i)
    if (!found) continue
    const number = Number(found[1])
    if (number < 1 || number > count || !MET.test(found[2])) continue
    met.add(number)
    proofs.set(number, found[3].trim())
  }
  const open = Array.from({ length: count }, (_, index) => index + 1).filter((number) => !met.has(number))
  return { met: [...met], open, proofs }
}

/**
 * File paths named as proof: in backticks, as a markdown link, or bare with a folder and an
 * extension. Commands in backticks (they contain spaces) and web addresses are skipped.
 */
export function proofPaths(proof: string): string[] {
  const candidates = [
    ...[...proof.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]),
    ...[...proof.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]),
    ...[...proof.matchAll(/(?:^|[\s(])((?:\/|[\w.-]+\/)[\w./-]*\.[A-Za-z0-9]{2,5})(?=$|[\s),;:])/g)].map(
      (m) => m[1],
    ),
  ]
  const paths = candidates
    .map((path) => path.trim().replace(/[.,;:]$/, ''))
    .filter((path) => !/\s/.test(path) && !/^[a-z]+:\/\//i.test(path))
    .filter((path) => path.includes('/') && /\.[A-Za-z0-9]{2,5}$/.test(path))
  return [...new Set(paths)]
}

export function checklistSection(items: string[]) {
  if (!items.length) return ''
  return prompts().checklistSection(items.map((item, index) => `${index + 1}. ${item}`).join('\n'))
}

/** What a maker is told about reporting on the checklist, in the language of the run. */
export const MAKER_RULES = () => prompts().makerRules

export function reviewSection(items: string[], report: string, interim: boolean) {
  const list = items.map((item, index) => `${index + 1}. ${item}`).join('\n')
  const text = prompts()
  return text.reviewSection({ list, report: report || text.noReport, interim })
}
