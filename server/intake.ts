// GitHub issue intake: a GitHub issue that gets the project's label ("agentdeck" by default)
// becomes an issue on the board, and the agents take it from there. Only labelling counts, not
// opening: on GitHub a label needs triage rights, so a stranger can write an issue but cannot
// hand it to the agents. The text still comes from outside, which is why the backlog is the
// default landing place. Deliveries arrive through the signed webhook (githubWebhook.ts).
import { createIssue, mergeSettings } from './core.ts'
import { all, get, run, tx } from './db.ts'

const BODY_CHARS = 18_000

export type TakenIssue = { projectId: number; issueId: number; number: number }

const text = (value: unknown, max: number) => (typeof value === 'string' ? value.slice(0, max) : '')

/** The projects that take issues of this repository under this label. */
function projectsFor(repo: string, label: string) {
  return all('SELECT id, settings FROM projects')
    .map((row) => ({ id: row.id as number, intake: mergeSettings(JSON.parse(row.settings || '{}')).intake }))
    .filter(
      ({ intake }) =>
        intake.enabled &&
        intake.repo.toLowerCase() === repo.toLowerCase() &&
        intake.label.toLowerCase() === label.toLowerCase(),
    )
}

/**
 * Files the GitHub issue of an "issues" delivery, once per project. Returns what it created;
 * empty for every other action, for pull requests, closed issues and repositories nobody takes.
 */
export function takeGithubIssue(payload: any): TakenIssue[] {
  if (payload?.action !== 'labeled') return []
  const source = payload.issue
  const repo = text(payload.repository?.full_name, 150)
  const label = text(payload.label?.name, 50)
  const url = text(source?.html_url, 300)
  if (!source || !repo || !label || source.pull_request || source.state !== 'open') return []
  if (!/^https:\/\/github\.com\//.test(url)) return []

  const title = text(source.title, 300).trim() || `GitHub issue #${source.number}`
  const author = text(source.user?.login, 60) || 'unknown'
  const body = text(source.body, BODY_CHARS + 1)
  const description = [
    `Source: [${repo}#${Number(source.number) || '?'}](${url}), reported by ${author} on GitHub.`,
    '',
    body.length > BODY_CHARS ? `${body.slice(0, BODY_CHARS)}\n\n… (cut)` : body,
  ].join('\n')

  const taken: TakenIssue[] = []
  for (const project of projectsFor(repo, label)) {
    const created = tx(() => {
      if (get('SELECT 1 FROM issues WHERE project_id=? AND source=?', project.id, url)) return null
      const issue = createIssue(project.id, {
        title,
        description,
        status: project.intake.status,
        created_by: 'GitHub',
      })
      run('UPDATE issues SET source=? WHERE id=?', url, issue.id)
      return issue
    })
    if (created) taken.push({ projectId: project.id, issueId: created.id, number: created.number })
  }
  return taken
}
