import { For, Show } from 'solid-js'
import { board, providers, saveSettings } from './store'
import { Icon } from './icons'
import type { WatchdogRule } from './types'
import { Field, Select, Toggle } from './ui'

const RULE_TYPES = [
  ['stall', 'No activity for (minutes)'],
  ['runtime', 'Run takes longer than (minutes)'],
  ['attempts', 'Failed attempts in a row'],
] as const

const ACTIONS = [
  ['comment', 'Comment only'],
  ['stop', 'Stop run and reschedule'],
  ['block', 'Stop and wait for a human'],
] as const

const ON_FAIL = [
  ['todo', 'Back to the agent'],
  ['blocked', 'Wait for a human'],
] as const

export function Watchdog() {
  const watchdog = () => board.project!.settings.watchdog

  function changeRule(index: number, patch: Partial<WatchdogRule>) {
    saveSettings((s) => Object.assign(s.watchdog.rules[index], patch))
  }

  return (
    <div class="page narrow">
      <div class="page-head">
        <div>
          <h2>Watchdog</h2>
          <p class="muted">
            Watches running agents and, if you want, checks every result before an issue moves on.
          </p>
        </div>
        <Toggle
          label="Active"
          checked={watchdog().enabled}
          onChange={(on) => saveSettings((s) => void (s.watchdog.enabled = on))}
        />
      </div>

      <section class="section">
        <div class="section-head">
          <h3>Rules</h3>
          <button
            onClick={() =>
              saveSettings((s) => s.watchdog.rules.push({ type: 'stall', value: 10, action: 'comment' }))
            }
          >
            Add rule
          </button>
        </div>
        <ul class="rules">
          <For each={watchdog().rules} fallback={<li class="muted">No rules.</li>}>
            {(rule, index) => (
              <li>
                <Select
                  value={rule.type}
                  options={RULE_TYPES}
                  onChange={(type) => changeRule(index(), { type })}
                />
                <input
                  type="number"
                  min="1"
                  value={rule.value}
                  onChange={(e) => changeRule(index(), { value: Number(e.currentTarget.value) || 1 })}
                />
                <Select
                  value={rule.action}
                  options={ACTIONS}
                  onChange={(action) => changeRule(index(), { action })}
                />
                <button
                  class="ghost danger"
                  onClick={() => saveSettings((s) => s.watchdog.rules.splice(index(), 1))}
                  aria-label="Remove rule"
                >
                  <Icon name="close" size={14} />
                </button>
              </li>
            )}
          </For>
        </ul>
      </section>

      <section class="section">
        <div class="section-head">
          <h3>Custom AI review</h3>
          <Toggle
            label="Review after every run"
            checked={watchdog().llm.enabled}
            onChange={(on) => saveSettings((s) => void (s.watchdog.llm.enabled = on))}
          />
        </div>
        <Show when={watchdog().llm.enabled}>
          <div class="form">
            <Field
              label="What should be checked?"
              hint="The reviewer only reads the working directory and answers PASS or FAIL."
            >
              <textarea
                rows="5"
                value={watchdog().llm.prompt}
                onChange={(e) => {
                  const prompt = e.currentTarget.value
                  saveSettings((s) => void (s.watchdog.llm.prompt = prompt))
                }}
              />
            </Field>
            <div class="row">
              <Field label="Reviewer runs on">
                <select
                  onChange={(e) => {
                    const provider = e.currentTarget.value
                    saveSettings((s) => void (s.watchdog.llm.provider = provider))
                  }}
                >
                  <For each={providers()}>
                    {(provider) => (
                      <option value={provider.id} selected={provider.id === watchdog().llm.provider}>
                        {provider.label}
                      </option>
                    )}
                  </For>
                </select>
              </Field>
              <Field label="On FAIL">
                <Select
                  value={watchdog().llm.onFail}
                  options={ON_FAIL}
                  onChange={(onFail) => saveSettings((s) => void (s.watchdog.llm.onFail = onFail))}
                />
              </Field>
            </div>
          </div>
        </Show>
      </section>
    </div>
  )
}
