// Small SVG charts for the dashboard. No chart library: three forms are all it needs.
//   Columns        one number per day
//   StackedColumns one number per day and series, stacked
//   Lines          one line per series over the days
// All share one frame (axis, grid, hover band, tooltip), so they line up when stacked on a page.
import { createMemo, createSignal, For, Show, type JSX } from 'solid-js'

export type Series = { name: string; color: string; values: (number | null)[] }

const WIDTH = 720
const HEIGHT = 220
const PAD = { top: 12, right: 12, bottom: 24, left: 44 }
const PLOT_WIDTH = WIDTH - PAD.left - PAD.right
const PLOT_HEIGHT = HEIGHT - PAD.top - PAD.bottom
const MAX_BAR = 24
const GAP = 2 // surface-coloured gap between stacked segments

/** A round upper end for the axis whose half is round too: 2, 4 or 10 times a power of ten. */
function niceMax(value: number) {
  if (value <= 2) return 2
  const magnitude = 10 ** Math.floor(Math.log10(value))
  const step = [1, 2, 4, 10].find((factor) => factor * magnitude >= value)!
  return step === 1 ? magnitude : step * magnitude
}

export function compact(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)} M`
  if (value >= 10_000) return `${Math.round(value / 1000)} k`
  return value.toLocaleString('de-DE')
}

const shortDay = (day: string) => `${day.slice(8, 10)}.${day.slice(5, 7)}.`

/** Axis, grid, day labels, the hover band and the tooltip. The marks come in as children. */
function Frame(props: {
  days: string[]
  max: number
  format: (value: number) => string
  rows: (index: number) => { name: string; color: string; value: string }[]
  children: (hovered: number | null) => JSX.Element
  label: string
}) {
  const [hovered, setHovered] = createSignal<number | null>(null)
  const band = () => PLOT_WIDTH / props.days.length
  const ticks = () => [0, 0.5, 1].map((share) => share * props.max)
  // Day labels would collide if every day got one.
  const labelEvery = () => Math.ceil(props.days.length / 8)

  function track(event: PointerEvent) {
    const box = (event.currentTarget as SVGElement).getBoundingClientRect()
    const x = ((event.clientX - box.left) / box.width) * WIDTH - PAD.left
    const index = Math.floor(x / band())
    setHovered(index >= 0 && index < props.days.length ? index : null)
  }

  return (
    <div class="chart">
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="img"
        aria-label={props.label}
        onPointerMove={track}
        onPointerLeave={() => setHovered(null)}
      >
        <For each={ticks()}>
          {(tick) => {
            const y = PAD.top + PLOT_HEIGHT * (1 - tick / props.max)
            return (
              <>
                <line class="grid" x1={PAD.left} x2={WIDTH - PAD.right} y1={y} y2={y} />
                <text class="tick" x={PAD.left - 8} y={y + 4} text-anchor="end">
                  {props.format(tick)}
                </text>
              </>
            )
          }}
        </For>
        <For each={props.days}>
          {(day, index) => (
            <Show when={index() % labelEvery() === 0}>
              <text class="tick" x={PAD.left + band() * (index() + 0.5)} y={HEIGHT - 6} text-anchor="middle">
                {shortDay(day)}
              </text>
            </Show>
          )}
        </For>
        <Show when={hovered() !== null}>
          <rect
            class="hover-band"
            x={PAD.left + band() * hovered()!}
            y={PAD.top}
            width={band()}
            height={PLOT_HEIGHT}
          />
        </Show>
        {props.children(hovered())}
      </svg>

      <Show when={hovered() !== null}>
        <div
          class="chart-tip"
          classList={{ left: hovered()! > props.days.length / 2 }}
          style={{ left: `${((PAD.left + band() * (hovered()! + 0.5)) / WIDTH) * 100}%` }}
        >
          <p class="tip-day">{shortDay(props.days[hovered()!])}</p>
          <For each={props.rows(hovered()!)}>
            {(row) => (
              <p>
                <span class="key" style={{ background: row.color }} />
                <strong>{row.value}</strong> {row.name}
              </p>
            )}
          </For>
        </div>
      </Show>
    </div>
  )
}

/** A column with a rounded top and a square foot on the baseline. */
function columnPath(x: number, y: number, width: number, height: number, rounded: boolean) {
  const radius = rounded ? Math.min(4, height, width / 2) : 0
  return `M${x},${y + height} V${y + radius} Q${x},${y} ${x + radius},${y} H${x + width - radius} Q${x + width},${y} ${x + width},${y + radius} V${y + height} Z`
}

export function Legend(props: { series: Series[]; line?: boolean }) {
  return (
    <ul class="legend">
      <For each={props.series}>
        {(series) => (
          <li>
            <span class="key" classList={{ line: props.line }} style={{ background: series.color }} />
            {series.name}
          </li>
        )}
      </For>
    </ul>
  )
}

export function Columns(props: { days: string[]; values: number[]; color: string; name: string }) {
  const max = createMemo(() => niceMax(Math.max(...props.values, 1)))
  const band = () => PLOT_WIDTH / props.days.length
  const width = () => Math.min(MAX_BAR, band() - GAP)

  return (
    <Frame
      days={props.days}
      max={max()}
      format={compact}
      label={props.name}
      rows={(index) => [{ name: props.name, color: props.color, value: compact(props.values[index]) }]}
    >
      {(hovered) => (
        <For each={props.values}>
          {(value, index) => {
            const height = (value / max()) * PLOT_HEIGHT
            const x = PAD.left + band() * index() + (band() - width()) / 2
            return (
              <Show when={value > 0}>
                <path
                  d={columnPath(x, PAD.top + PLOT_HEIGHT - height, width(), height, true)}
                  fill={props.color}
                  opacity={hovered === null || hovered === index() ? 1 : 0.55}
                />
              </Show>
            )
          }}
        </For>
      )}
    </Frame>
  )
}

export function StackedColumns(props: { days: string[]; series: Series[]; label: string }) {
  const totals = createMemo(() =>
    props.days.map((_, index) => props.series.reduce((sum, series) => sum + (series.values[index] ?? 0), 0)),
  )
  const max = createMemo(() => niceMax(Math.max(...totals(), 1)))
  const band = () => PLOT_WIDTH / props.days.length
  const width = () => Math.min(MAX_BAR, band() - GAP)

  /** The segments of one day, from the baseline up, each with where it starts and how tall it is. */
  function stack(index: number) {
    let top = PAD.top + PLOT_HEIGHT
    const present = props.series.filter((series) => (series.values[index] ?? 0) > 0)
    return present.map((series, position) => {
      const height = ((series.values[index] ?? 0) / max()) * PLOT_HEIGHT
      top -= height
      const isLast = position === present.length - 1
      // The gap is cut from the segment's foot, so the stack keeps its true total height.
      return { series, y: top, height: Math.max(1, height - (position === 0 ? 0 : GAP)), isLast }
    })
  }

  return (
    <>
      <Legend series={props.series} />
      <Frame
        days={props.days}
        max={max()}
        format={compact}
        label={props.label}
        rows={(index) => [
          ...props.series
            .filter((series) => (series.values[index] ?? 0) > 0)
            .map((series) => ({
              name: series.name,
              color: series.color,
              value: compact(series.values[index]!),
            })),
          { name: 'gesamt', color: 'transparent', value: compact(totals()[index]) },
        ]}
      >
        {(hovered) => (
          <For each={props.days}>
            {(_, index) => (
              <g opacity={hovered === null || hovered === index() ? 1 : 0.55}>
                <For each={stack(index())}>
                  {(segment) => (
                    <path
                      d={columnPath(
                        PAD.left + band() * index() + (band() - width()) / 2,
                        segment.y,
                        width(),
                        segment.height,
                        segment.isLast,
                      )}
                      fill={segment.series.color}
                    />
                  )}
                </For>
              </g>
            )}
          </For>
        )}
      </Frame>
    </>
  )
}

export function Lines(props: {
  days: string[]
  series: Series[]
  label: string
  max?: number
  unit?: string
}) {
  const max = createMemo(
    () =>
      props.max ??
      niceMax(Math.max(...props.series.flatMap((series) => series.values.map((value) => value ?? 0)), 1)),
  )
  const band = () => PLOT_WIDTH / props.days.length
  const x = (index: number) => PAD.left + band() * (index + 0.5)
  const y = (value: number) => PAD.top + PLOT_HEIGHT * (1 - value / max())
  const format = (value: number) => compact(value) + (props.unit ?? '')

  /** One path per series; a day without a value breaks the line instead of drawing through it. */
  function path(values: (number | null)[]) {
    let drawing = false
    return values
      .map((value, index) => {
        if (value === null) {
          drawing = false
          return ''
        }
        const command = `${drawing ? 'L' : 'M'}${x(index)},${y(value)}`
        drawing = true
        return command
      })
      .join(' ')
  }

  return (
    <>
      <Show when={props.series.length > 1}>
        <Legend series={props.series} line />
      </Show>
      <Frame
        days={props.days}
        max={max()}
        format={format}
        label={props.label}
        rows={(index) =>
          props.series
            .filter((series) => series.values[index] !== null)
            .map((series) => ({
              name: series.name,
              color: series.color,
              value: format(series.values[index]!),
            }))
        }
      >
        {(hovered) => (
          <For each={props.series}>
            {(series) => (
              <>
                <path class="line" d={path(series.values)} stroke={series.color} />
                <Show when={hovered !== null && series.values[hovered] !== null}>
                  <circle
                    class="dot"
                    cx={x(hovered!)}
                    cy={y(series.values[hovered!]!)}
                    r="4"
                    fill={series.color}
                  />
                </Show>
              </>
            )}
          </For>
        )}
      </Frame>
    </>
  )
}
