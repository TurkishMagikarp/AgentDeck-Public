import { createMemo, For } from 'solid-js'
import { models } from './store'

/**
 * Model picker for one provider. The list comes from the server; a model that is set but no
 * longer listed stays selectable, so opening a form never changes it silently.
 */
export function ModelSelect(props: {
  provider: string
  value: string
  onChange: (model: string) => void
  emptyLabel?: string
}) {
  const options = createMemo(() => {
    const listed = models()[props.provider] ?? []
    return props.value && !listed.includes(props.value) ? [props.value, ...listed] : listed
  })

  return (
    <select onChange={(e) => props.onChange(e.currentTarget.value)}>
      <option value="" selected={!props.value}>
        {props.emptyLabel ?? "Provider's default"}
      </option>
      <For each={options()}>
        {(model) => (
          <option value={model} selected={model === props.value}>
            {model}
          </option>
        )}
      </For>
    </select>
  )
}
