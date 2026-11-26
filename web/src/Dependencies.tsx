import { createMemo, createSignal, For, Show } from 'solid-js'
import { BOOST_FROM, cycles } from '../../server/blockers.ts'
import { PRIORITIES } from './Board'
import { Icon } from './icons'
import { board, fail, openIssue, saveSettings, weights } from './store'
import type { Issue } from './types'
import { Toggle } from './ui'
import { t } from './i18n'

const WIDTH = 230
const HEIGHT = 64
const COLUMN_GAP = 72
const ROW_GAP = 14
const PAD = 16

const STATUS_LABEL: Record<string, string> = {
  backlog: 'Backlog',
  todo: 'To Do',
  in_progress: 'In Arbeit',
  review: 'Review',
  blocked: 'Wartet',
  done: 'Fertig',
}

type Node = { issue: Issue; layer: number; x: number; y: number }

/**
 * Which issue holds up which: blockers on the left, what waits on them to the right. Only issues
 * that are part of a dependency show up. Hovering a card highlights its whole chain.
 */
export function Dependencies() {
  const [showDone, setShowDone] = createSignal(false)
  const [hovered, setHovered] = createSignal<number | null>(null)

  const loops = createMemo(() => cycles(board.issues))

  const layout = createMemo(() => {
    const byNumber = new Map(board.issues.map((issue) => [issue.number, issue]))
    const isOpen = (issue: Issue | undefined) => !!issue && issue.status !== 'done'
    const blockersOf = (issue: Issue) =>
      issue.blocked_by.filter((number) => number !== issue.number && byNumber.has(number))

    // Part of the graph: open issues with a blocker, and every issue that blocks an open one.
    const shown = new Set<number>()
    for (const issue of board.issues) {
      if (!isOpen(issue)) continue
      for (const blocker of blockersOf(issue)) {
        if (!isOpen(byNumber.get(blocker)) && !showDone()) continue
        shown.add(issue.number)
        shown.add(blocker)
      }
    }

    // Columns by the longest chain of blockers in front of an issue. Cycles stop at the guard.
    const layers = new Map<number, number>()
    const layerOf = (number: number, guard = new Set<number>()): number => {
      if (layers.has(number)) return layers.get(number)!
      if (guard.has(number)) return 0
      guard.add(number)
      const before = blockersOf(byNumber.get(number)!).filter((blocker) => shown.has(blocker))
      const layer = before.length ? 1 + Math.max(...before.map((blocker) => layerOf(blocker, guard))) : 0
      layers.set(number, layer)
      return layer
    }
    for (const number of shown) layerOf(number)

    const columns: number[][] = []
    for (const [number, layer] of layers) (columns[layer] ??= []).push(number)

    // First column: heaviest blockers on top. Further columns: near the blockers they wait on.
    const row = new Map<number, number>()
    columns.forEach((column, index) => {
      if (index === 0) {
        column.sort((a, b) => (weights().get(b)?.blocks ?? 0) - (weights().get(a)?.blocks ?? 0) || a - b)
      } else {
        const center = (number: number) => {
          const before = blockersOf(byNumber.get(number)!).filter((blocker) => row.has(blocker))
          return before.length
            ? before.reduce((sum, blocker) => sum + row.get(blocker)!, 0) / before.length
            : 0
        }
        column.sort((a, b) => center(a) - center(b) || a - b)
      }
      column.forEach((number, position) => row.set(number, position))
    })

    const nodes = new Map<number, Node>()
    columns.forEach((column, layer) =>
      column.forEach((number, position) =>
        nodes.set(number, {
          issue: byNumber.get(number)!,
          layer,
          x: PAD + layer * (WIDTH + COLUMN_GAP),
          y: PAD + position * (HEIGHT + ROW_GAP),
        }),
      ),
    )

    const inLoop = new Set(loops().flat())
    const edges = [...nodes.values()].flatMap((node) =>
      blockersOf(node.issue)
        .filter((blocker) => nodes.has(blocker))
        .map((blocker) => ({
          from: nodes.get(blocker)!,
          to: node,
          done: byNumber.get(blocker)!.status === 'done',
          loop: inLoop.has(blocker) && inLoop.has(node.issue.number),
        })),
    )

    const tallest = Math.max(0, ...columns.map((column) => column.length))
    return {
      nodes: [...nodes.values()],
      edges,
      width: PAD * 2 + columns.length * WIDTH + Math.max(0, columns.length - 1) * COLUMN_GAP,
      height: PAD * 2 + tallest * HEIGHT + Math.max(0, tallest - 1) * ROW_GAP,
    }
  })

  /** The hovered issue, everything it holds up and everything that holds it up. */
  const chain = createMemo(() => {
    const number = hovered()
    if (number === null) return null
    const linked = new Set([number, ...(weights().get(number)?.blocked ?? [])])
    for (const [blocker, weight] of weights()) if (weight.blocked.includes(number)) linked.add(blocker)
    return linked
  })
  const dimmed = (number: number) => !!chain() && !chain()!.has(number)

  const edgePath = (from: Node, to: Node) => {
    const x1 = from.x + WIDTH
    const y1 = from.y + HEIGHT / 2
    const x2 = to.x
    const y2 = to.y + HEIGHT / 2
    const bend = Math.max(30, (x2 - x1) / 2)
    return `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`
  }

  return (
    <div class="page">
      <div class="page-head">
        <div>
          <h2>{t('Abhängigkeiten')}</h2>
          <p class="muted">
            {t(
              'Links die Blocker, rechts was auf sie wartet. Wer andere aufhält, startet früher: Er bekommt die höchste Priorität der wartenden Issues, ab {a} aufgehaltenen eine Stufe mehr, ab {b} zwei.',
              { a: BOOST_FROM, b: BOOST_FROM * 2 },
            )}
          </p>
        </div>
      </div>

      <Show when={layout().nodes.length}>
        <ul class="dependency-summary" aria-label={t('Überblick über die Abhängigkeiten')}>
          <li classList={{ zero: String(layout().nodes.length) === '0' }}>
            <strong>{layout().nodes.length}</strong>
            <span>{t('Issues im Graph')}</span>
          </li>
          <li classList={{ zero: String(layout().nodes.filter((node) => node.layer === 0 && node.issue.status !== 'done').length) === '0' }}>
            <strong>{layout().nodes.filter((node) => node.layer === 0 && node.issue.status !== 'done').length}</strong>
            <span>{t('Blocker ohne Vorgänger: hier geht es los')}</span>
          </li>
          <li classList={{ zero: String(layout().nodes.filter((node) => node.layer > 0).length) === '0' }}>
            <strong>{layout().nodes.filter((node) => node.layer > 0).length}</strong>
            <span>{t('warten auf andere')}</span>
          </li>
          <li classList={{ zero: String(Math.max(...layout().nodes.map((node) => node.layer)) + 1) === '0' }}>
            <strong>{Math.max(...layout().nodes.map((node) => node.layer)) + 1}</strong>
            <span>{t('Stufen: die längste Kette')}</span>
          </li>
        </ul>
      </Show>

      <div class="dependency-options">
        <Toggle
          label={t('Blocker zuerst starten')}
          checked={board.project!.settings.blockerBoost}
          onChange={(on) => saveSettings((s) => void (s.blockerBoost = on))?.catch(fail)}
        />
        <Toggle label={t('Erledigte Blocker zeigen')} checked={showDone()} onChange={setShowDone} />
      </div>

      <Show when={loops().length}>
        <p class="dependency-loop">
          {t('Kreis gefunden:')}{' '}
          {loops()
            .map((loop) => loop.map((number) => `${board.project!.key}-${number}`).join(' → '))
            .join('; ')}
          .{' '}
          {board.project!.settings.autonomous
            ? t(
                'AgentDeck löst ihn auf: Erst entscheidet der Deputy, welche Abhängigkeit wegfällt, sonst fällt die auf das neueste Issue weg.',
              )
            : t(
                'Diese Issues warten aufeinander und starten nie von selbst. Entferne eine der Abhängigkeiten im Issue.',
              )}
        </p>
      </Show>

      <Show
        when={layout().nodes.length}
        fallback={
          <p class="muted">{t('Keine offenen Abhängigkeiten. Sie entstehen über „Wartet auf“ im Issue.')}</p>
        }
      >
        <div class="dependency-graph">
          <div
            class="dependency-canvas"
            style={{ width: `${layout().width}px`, height: `${layout().height}px` }}
          >
            <svg width={layout().width} height={layout().height} aria-hidden="true">
              <defs>
                <marker
                  id="dependency-arrow"
                  viewBox="0 0 8 8"
                  refX="7"
                  refY="4"
                  markerWidth="7"
                  markerHeight="7"
                  orient="auto"
                >
                  <path d="M 0 0 L 8 4 L 0 8 z" fill="currentColor" />
                </marker>
              </defs>
              <For each={layout().edges}>
                {(edge) => (
                  <path
                    d={edgePath(edge.from, edge.to)}
                    class="dependency-edge"
                    classList={{
                      done: edge.done,
                      loop: edge.loop,
                      dimmed: dimmed(edge.from.issue.number) || dimmed(edge.to.issue.number),
                    }}
                    marker-end="url(#dependency-arrow)"
                  />
                )}
              </For>
            </svg>
            <For each={layout().nodes}>
              {(node) => {
                const weight = () => weights().get(node.issue.number)
                const raised = () => (weight()?.effective ?? 0) > node.issue.priority
                return (
                  <button
                    class={`dependency-node ${node.issue.status}`}
                    classList={{ dimmed: dimmed(node.issue.number) }}
                    style={{
                      left: `${node.x}px`,
                      top: `${node.y}px`,
                      width: `${WIDTH}px`,
                      height: `${HEIGHT}px`,
                    }}
                    onMouseEnter={() => setHovered(node.issue.number)}
                    onMouseLeave={() => setHovered(null)}
                    onFocus={() => setHovered(node.issue.number)}
                    onBlur={() => setHovered(null)}
                    onClick={() => openIssue(node.issue.id).catch(fail)}
                  >
                    <span class="dependency-top">
                      <span class={`status-dot ${node.issue.status}`} />
                      <span class="mono">
                        {board.project!.key}-{node.issue.number}
                      </span>
                      <span class="muted">{t(STATUS_LABEL[node.issue.status])}</span>
                      <Show when={weight()?.blocks}>
                        <span class="holds" title={t('Hält {n} Issues auf', { n: weight()!.blocks })}>
                          {t('hält {n} auf', { n: weight()!.blocks })}
                        </span>
                      </Show>
                      <Show when={raised()}>
                        <span class="raised" title={t('Priorität angehoben, weil andere darauf warten')}>
                          <Icon name="arrowUp" size={11} />
                          {t(PRIORITIES[weight()!.effective])}
                        </span>
                      </Show>
                    </span>
                    <span class="dependency-title">{node.issue.title}</span>
                  </button>
                )
              }}
            </For>
          </div>
        </div>
      </Show>
    </div>
  )
}
