import { createEffect, createResource, For, on, onCleanup, Show } from 'solid-js'
import { createStore } from 'solid-js/store'
import { api } from './api'
import { onRunOutput } from './store'

type Line = { at: number; text: string }

const clock = (at: number) => new Date(at).toLocaleTimeString('en-US')

/**
 * What an agent printed during one run: its messages and every tool call. For a running agent
 * new lines arrive live and the view follows them, unless you scrolled up to read.
 */
export function RunLog(props: { runId: number; live?: boolean }) {
  const [lines, setLines] = createStore<Line[]>([])
  const [loaded] = createResource(
    () => props.runId,
    async (runId) => {
      setLines(await api.get<Line[]>(`/runs/${runId}/log`))
      return true
    },
  )

  let box: HTMLDivElement | undefined
  const isAtBottom = () => !box || box.scrollHeight - box.scrollTop - box.clientHeight < 40

  if (props.live) {
    const stop = onRunOutput(props.runId, (line) => {
      const follow = isAtBottom()
      setLines(lines.length, line)
      if (follow) queueMicrotask(() => box && (box.scrollTop = box.scrollHeight))
    })
    onCleanup(stop)
  }

  createEffect(on(loaded, () => box && (box.scrollTop = box.scrollHeight)))

  return (
    <div class="run-log" ref={box}>
      <Show when={!loaded.loading} fallback={<p class="muted">Loading output…</p>}>
        <For each={lines} fallback={<p class="muted">No output yet.</p>}>
          {(line) => (
            <p>
              <time>{clock(line.at)}</time>
              {line.text}
            </p>
          )}
        </For>
      </Show>
    </div>
  )
}
