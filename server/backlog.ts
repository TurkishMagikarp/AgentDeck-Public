type BacklogIssue = {
  id: number
  number: number
  status: string
  grp: string
  blocked_by: number[]
  capped: number
  parked_until: number
  review_index: number
}

/** The input is all unfinished issues, in scheduling order (priority, rank, id). */
export function readyBacklog(issues: BacklogIssue[], slots: number, groupsInOrder: boolean, now = Date.now()) {
  const open = new Set(issues.map((issue) => issue.number))
  const dependenciesDone = (issue: BacklogIssue) => !issue.blocked_by.some((number) => open.has(number))
  const queued = issues.filter((i) => (i.status === 'todo' || (i.status === 'review' && i.review_index >= 0))
    && dependenciesDone(i))
  const wanted = slots - queued.length
  if (wanted <= 0) return []

  const candidates = issues.filter((i) =>
    i.status === 'backlog' && !i.capped && i.parked_until <= now && dependenciesDone(i),
  )
  if (!groupsInOrder) return candidates.slice(0, wanted)

  // Respect work already in flight (including review/approval). When no group is active,
  // a group containing only parked, capped or dependency-blocked backlog issues must not
  // stop the whole project. Choose the earliest group with work that can actually be pulled.
  const activeGroups = [...queued, ...issues.filter((i) =>
    i.status === 'in_progress' || i.status === 'review' || i.status === 'blocked',
  )].map((i) => i.grp).filter(Boolean).sort()
  const first = activeGroups[0] ?? candidates.map((i) => i.grp).filter(Boolean).sort()[0]
  return candidates.filter((i) => !i.grp || i.grp === first).slice(0, wanted)
}
