// A small least-recently-used cache. AgentDeck trades RAM for CPU: git spawns and file reads are
// the expensive part of a request, and their answers are often the same for minutes.
export class Lru<V> {
  private map = new Map<string, { value: V; size: number }>()
  private total = 0
  private maxEntries: number
  private maxSize: number
  private sizeOf: (value: V) => number

  constructor(o: { maxEntries: number; maxSize?: number; sizeOf?: (value: V) => number }) {
    this.maxEntries = o.maxEntries
    this.maxSize = o.maxSize ?? Infinity
    this.sizeOf = o.sizeOf ?? (() => 1)
  }

  get(key: string): V | undefined {
    const entry = this.map.get(key)
    if (!entry) return undefined
    // Re-inserted at the end: the map's order is the order of use.
    this.map.delete(key)
    this.map.set(key, entry)
    return entry.value
  }

  set(key: string, value: V) {
    this.delete(key)
    const size = this.sizeOf(value)
    if (size > this.maxSize) return
    this.map.set(key, { value, size })
    this.total += size
    for (const [oldest, entry] of this.map) {
      if (this.map.size <= this.maxEntries && this.total <= this.maxSize) break
      this.map.delete(oldest)
      this.total -= entry.size
    }
  }

  delete(key: string) {
    const entry = this.map.get(key)
    if (!entry) return
    this.map.delete(key)
    this.total -= entry.size
  }

  get size() {
    return this.map.size
  }

  get bytes() {
    return this.total
  }

  /** The cached value, or the one `make` produces, which is then kept. Failures are not kept. */
  async remember(key: string, make: () => Promise<V>): Promise<V> {
    const hit = this.get(key)
    if (hit !== undefined) return hit
    const value = await make()
    this.set(key, value)
    return value
  }
}
