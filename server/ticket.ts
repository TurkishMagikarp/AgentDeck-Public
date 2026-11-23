// How an issue is written, so that the agent doing it needs no guessing: a smaller model can then
// do the work, and the strong models are left for planning and review. Agents that file issues
// get this format in their prompt, and the agent API refuses an issue without its core sections.

export const TICKET_FORMAT = `## How to write an issue
Write it so that a junior developer with no context could do it without asking. Use these headings:
- \`## Goal\`: why this matters, one to three sentences.
- \`## Task\`: what to do, as numbered steps.
- \`## Files\`: the files and folders to change or read, with paths. Name an existing example to copy from where one exists.
- \`## Done when\`: acceptance criteria as a checklist. Each item can be checked by reading the code, running a command or looking at a screenshot.
- \`## Out of scope\`: what not to touch.
- \`## Notes\`: optional. Pitfalls, decisions already made, commands to run.
One issue is one result. Split anything bigger.`

const REQUIRED = ['Task', 'Files', 'Done when']

/** A section counts as a heading ("## Task") or as a bold label ("**Done when:**"). */
function hasSection(description: string, name: string) {
  const escaped = name.replace(/ /g, '\\s+')
  return new RegExp(`^\\s*(#{1,4}\\s*${escaped}\\b|\\*\\*${escaped}:?\\*\\*)`, 'im').test(description)
}

export function missingSections(description: string) {
  return REQUIRED.filter((name) => !hasSection(description, name))
}
