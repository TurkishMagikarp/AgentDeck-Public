// What happens to a partial delivery: the maker handed in with checklist items still open.
// Pure functions without imports, so they can be tested without a database. Used by engine.ts.
//
// Without these rules an issue could circle for an hour: the maker hands in a part, the first
// reviewer approves the part, the maker starts again, cannot do more because it waits for another
// issue, hands in the same part, and so on (SHOP-710, 22 Nov 2026).

export type PartialStep =
  /** The maker says it waits for these open issues: the issue waits for them, nobody runs. */
  | { kind: 'wait'; on: number[] }
  /** First partial delivery: the first reviewer looks at the pieces so far. */
  | { kind: 'interim' }
  /** A later one that met more items: straight back to the maker, the final review sees all. */
  | { kind: 'goOn' }
  /** A later one that met nothing new: another round would only repeat it, a human decides. */
  | { kind: 'stuck' }

export function partialStep(o: {
  /** Open issues the maker names as what it waits for, see waitingLines. */
  waitsFor: number[]
  /** Open items of the report before this delivery, null when there was none. */
  openBefore: number[] | null
  openNow: number[]
}): PartialStep {
  if (o.waitsFor.length) return { kind: 'wait', on: o.waitsFor }
  if (!o.openBefore?.length) return { kind: 'interim' }
  const newlyMet = o.openBefore.filter((item) => !o.openNow.includes(item))
  return newlyMet.length ? { kind: 'goOn' } : { kind: 'stuck' }
}

/**
 * The lines of a report that say something waits, so that "Exits wait on SHOP-826" counts as
 * waiting, while "collectors stay with SHOP-845" does not.
 */
export function waitingLines(text: string): string {
  return text
    .split('\n')
    .filter((line) => /\b(wart\w*|wait\w*|block\w*|fehl\w*|missing|lack\w*|braucht|needs?)\b/i.test(line))
    .join('\n')
}
