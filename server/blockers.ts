// Blockers first: an issue that holds up others gets their priority and a boost for how many it
// holds up, counted through the whole chain (A blocks B, B blocks C: A holds up two). Used by
// the scheduler to pick the next issue and by the board to show the same order.
// Pure functions without imports, so the server and the web interface share this file.

export type DependencyIssue = { number: number; priority: number; status: string; blocked_by: number[] }

export type Weight = {
  /** Open issues that wait on this one, directly or through others. */
  blocks: number
  /** The issue numbers behind `blocks`. */
  blocked: number[]
  /** The priority the scheduler uses: own, inherited from what it blocks, plus the boost. */
  effective: number
}

/** Holding up this many issues raises the priority by one step, twice this many by two. */
export const BOOST_FROM = 3
const MAX_PRIORITY = 3

const isOpen = (issue: DependencyIssue) => issue.status !== 'done'

/** Direct dependents: blocker number → open issues that list it in blocked_by. */
function dependentsOf(issues: DependencyIssue[]) {
  const dependents = new Map<number, number[]>()
  for (const issue of issues) {
    if (!isOpen(issue)) continue
    for (const blocker of issue.blocked_by) {
      if (blocker === issue.number) continue
      dependents.set(blocker, [...(dependents.get(blocker) ?? []), issue.number])
    }
  }
  return dependents
}

export function blockerWeights(issues: DependencyIssue[]): Map<number, Weight> {
  const byNumber = new Map(issues.map((issue) => [issue.number, issue]))
  const dependents = dependentsOf(issues)
  const weights = new Map<number, Weight>()

  for (const issue of issues) {
    if (!isOpen(issue)) continue
    // Walk everything that waits on this issue. The visited set also stops cycles.
    const seen = new Set<number>()
    const queue = [...(dependents.get(issue.number) ?? [])]
    while (queue.length) {
      const next = queue.pop()!
      if (seen.has(next) || next === issue.number) continue
      seen.add(next)
      queue.push(...(dependents.get(next) ?? []))
    }
    const blocked = [...seen].sort((a, b) => a - b)
    const inherited = Math.max(
      issue.priority,
      ...blocked.map((number) => byNumber.get(number)?.priority ?? 0),
    )
    const boost = blocked.length >= BOOST_FROM * 2 ? 2 : blocked.length >= BOOST_FROM ? 1 : 0
    weights.set(issue.number, {
      blocks: blocked.length,
      blocked,
      effective: Math.min(MAX_PRIORITY, inherited + boost),
    })
  }
  return weights
}

/** Higher effective priority first, then the issue that holds up more, then the given order. */
export function byBlockerWeight(weights: Map<number, Weight>) {
  return (a: { number: number; priority: number }, b: { number: number; priority: number }) => {
    const wa = weights.get(a.number)
    const wb = weights.get(b.number)
    return (
      (wb?.effective ?? b.priority) - (wa?.effective ?? a.priority) || (wb?.blocks ?? 0) - (wa?.blocks ?? 0)
    )
  }
}

/** Open issues that block each other in a circle; they can never start on their own. */
export function cycles(issues: DependencyIssue[]): number[][] {
  const open = new Map(issues.filter(isOpen).map((issue) => [issue.number, issue]))
  const state = new Map<number, 'active' | 'done'>()
  const found: number[][] = []
  const path: number[] = []

  const visit = (number: number) => {
    state.set(number, 'active')
    path.push(number)
    for (const blocker of open.get(number)?.blocked_by ?? []) {
      if (!open.has(blocker)) continue
      if (state.get(blocker) === 'active') found.push(path.slice(path.indexOf(blocker)))
      else if (!state.has(blocker)) visit(blocker)
    }
    path.pop()
    state.set(number, 'done')
  }
  for (const number of open.keys()) if (!state.has(number)) visit(number)
  return found
}
