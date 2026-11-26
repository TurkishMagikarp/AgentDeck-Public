// How an issue is written, so that the agent doing it needs no guessing: a smaller model can then
// do the work, and the strong models are left for planning and review. Agents that file issues
// get this format in their prompt, and the agent API refuses an issue without its core sections.
import { say } from './i18n.ts'
import { prompts } from './prompts/index.ts'

/**
 * What one issue should use at most, all its runs together, counted like issueCap.ts counts
 * (fresh tokens). A project with a token cap per issue names that instead.
 */
export const ISSUE_TOKENS = 500_000

/** The format in the language of the run, with that language's headings. */
export const TICKET_FORMAT = (tokens = ISSUE_TOKENS) => prompts().ticketFormat(tokens)

/** The sections an issue must have, each under its English or its German heading. */
const REQUIRED = [
  ['Task', 'Aufgabe'],
  ['Files', 'Dateien'],
  ['Done when', 'Fertig wenn'],
]

/** A section counts as a heading ("## Task") or as a bold label ("**Done when:**"). */
function hasSection(description: string, name: string) {
  const escaped = name.replace(/ /g, ',?\\s+')
  // Not \b: it does not know umlauts, and a heading must not match a longer word either.
  const end = '(?![\\p{L}\\p{N}_])'
  return new RegExp(`^\\s*(#{1,4}\\s*${escaped}${end}|\\*\\*${escaped}:?\\*\\*)`, 'imu').test(description)
}

/** The missing sections by their English names. */
export function missingSections(description: string) {
  return REQUIRED.filter((names) => !names.some((name) => hasSection(description, name))).map(
    ([english]) => english,
  )
}

/** The heading to name in a message about a missing section, in the language of the reader. */
export const sectionHeading = (english: string) =>
  say({ de: REQUIRED.find(([name]) => name === english)?.[1] ?? english, en: english })
