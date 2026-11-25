import { createResource, createSignal, For, Show } from 'solid-js'
import { api } from './api'
import { RunLog } from './RunLog'
import { RunReplay } from './RunReplay'
import { fail, providerLabel } from './store'
import type { Comment, Run } from './types'
import { formatTokens, timeAgo } from './ui'

export function CommentItem(props: { comment: Comment }) {
  return (
    <li class={`comment ${props.comment.kind}`}>
      <div class="comment-head">
        <span class="avatar small">{props.comment.author.slice(0, 2).toUpperCase()}</span>
        <strong>{props.comment.author}</strong>
        <span class="muted" title={new Date(props.comment.created_at).toLocaleString('en-US')}>
          {timeAgo(props.comment.created_at)}
        </span>
      </div>
      <p>{props.comment.body}</p>
    </li>
  )
}

export function RunItem(props: { run: Run }) {
  const run = () => props.run
  const [showsOutput, setShowsOutput] = createSignal(false)
  const [showsReplay, setShowsReplay] = createSignal(false)
  // What was actually new for the model: input that did not come from the cache, plus its output.
  const freshTokens = () =>
    (run().input_tokens ?? 0) - (run().cached_tokens ?? 0) + (run().output_tokens ?? 0)
  const seconds = () => Math.round(((run().ended_at ?? Date.now()) - run().started_at) / 1000)
  const label = () =>
    ({ done: 'finished', failed: 'failed', stopped: 'stopped', running: 'running' })[
      run().status ?? ''
    ] ?? run().status

  return (
    <li class={`run-item ${run().status}`}>
      Run by {run().agent_name} {label()} · {providerLabel(run().provider)}
      {run().model ? ` (${run().model})` : ''} · {seconds()} s ·{' '}
      <span title="An agent resends its whole context on every step. This part comes from the cache and costs about a tenth.">
        {formatTokens(freshTokens())} tokens new, {formatTokens(run().cached_tokens ?? 0)} from the cache
      </span>
      <Show when={run().cost_usd}> · ${run().cost_usd!.toFixed(2)}</Show>
      <Show when={run().note}>
        <span class="muted"> · {run().note}</span>
      </Show>{' '}
      <button class="link" onClick={() => setShowsOutput(!showsOutput())}>
        {showsOutput() ? 'Hide output' : 'Show output'}
      </button>{' '}
      <button class="link" onClick={() => setShowsReplay(!showsReplay())}>
        {showsReplay() ? 'Hide history' : 'Show history'}
      </button>
      <Show when={showsOutput()}>
        <RunLog runId={run().id} />
      </Show>
      <Show when={showsReplay()}>
        <RunReplay runId={run().id} />
      </Show>
    </li>
  )
}

/** The newest preview screenshots of the branch: desktop and phone, taken when work went to review. */
export function Screenshots(props: { issueId: number; comments: number }) {
  // A new screenshot always comes with a comment, so the comment count is the signal to look again.
  const [shots] = createResource(
    () => ({ id: props.issueId, comments: props.comments }),
    ({ id }) => api.get<string[]>(`/issues/${id}/shots`),
  )
  const latest = () => {
    const files = shots() ?? []
    const run = files[0]?.split('-')[0]
    return files.filter((file) => file.startsWith(`${run}-`)).sort()
  }

  return (
    <Show when={latest().length}>
      <section class="issue-section">
        <h3>Preview</h3>
        <div class="shots-row">
          <For each={latest()}>
            {(file) => {
              const url = `/api/issues/${props.issueId}/shots/${file}`
              return (
                <a href={url} target="_blank" rel="noreferrer" classList={{ phone: file.includes('phone') }}>
                  <img
                    src={url}
                    alt={file.includes('phone') ? 'Preview phone' : 'Preview desktop'}
                    loading="lazy"
                  />
                </a>
              )
            }}
          </For>
        </div>
      </section>
    </Show>
  )
}

type ForecastRange = { median: number; low: number; high: number }
type ForecastInfo = {
  forecast: { sample: number; usd: ForecastRange; tokens: ForecastRange; runs: ForecastRange } | null
  cap: { usd: number; tokens: number }
  overCap: boolean
}

/**
 * What similar finished issues cost (server/forecast.ts). Dollars when the providers reported
 * any, fresh tokens otherwise (subscriptions report no price). Nothing below three similar issues.
 */
export function CostForecast(props: { issueId: number; version: number }) {
  const [data] = createResource(
    () => ({ id: props.issueId, version: props.version }),
    ({ id }) => api.get<ForecastInfo>(`/issues/${id}/forecast`),
  )
  const thousands = (tokens: number) => `${Math.round(tokens / 1000).toLocaleString('en-US')}k`
  const text = (info: ForecastInfo) => {
    const f = info.forecast!
    const amount =
      f.usd.high > 0
        ? `~$${f.usd.median.toFixed(2)} (${f.usd.low.toFixed(2)}–${f.usd.high.toFixed(2)})`
        : `~${thousands(f.tokens.median)} tokens (${thousands(f.tokens.low)}–${thousands(f.tokens.high)})`
    return `Expected: ${amount}, from ${f.sample} similar issues`
  }

  return (
    <Show when={data()?.forecast ? data() : null} fallback={<span class="muted">–</span>}>
      {(info) => (
        <span class="spending" classList={{ capped: info().overCap }}>
          {text(info())}
          <Show when={info().overCap}> · above the cost cap</Show>
        </span>
      )}
    </Show>
  )
}

type Spent = { spent: { usd: number; tokens: number }; cap: { usd: number; tokens: number }; capped: boolean }

/** What the issue has used so far, against its cost cap. Parked issues get a button to go on. */
export function Spending(props: { issueId: number; version: number }) {
  const [data, { refetch }] = createResource(
    () => ({ id: props.issueId, version: props.version }),
    ({ id }) => api.get<Spent>(`/issues/${id}/spent`),
  )
  const thousands = (tokens: number) => `${Math.round(tokens / 1000).toLocaleString('en-US')}k`

  return (
    <Show when={data()} fallback={<span class="muted">–</span>}>
      {(info) => (
        <span class="spending" classList={{ capped: info().capped }}>
          ${info().spent.usd.toFixed(2)}
          {info().cap.usd ? ` of $${info().cap.usd.toFixed(2)}` : ''} · {thousands(info().spent.tokens)}
          {info().cap.tokens ? ` of ${thousands(info().cap.tokens)}` : ''} tokens
          <Show when={info().capped}>
            <button
              class="link"
              onClick={() => api.post(`/issues/${props.issueId}/raise-cap`).then(refetch).catch(fail)}
            >
              Allow another round
            </button>
          </Show>
        </span>
      )}
    </Show>
  )
}
