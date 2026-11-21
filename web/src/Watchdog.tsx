import { For, Show } from 'solid-js'
import { board, providers, saveSettings } from './store'
import type { WatchdogRule } from './types'
import { Field, Select, Toggle } from './ui'

const RULE_TYPES = [
  ['stall', 'Keine Aktivität seit (Minuten)'],
  ['runtime', 'Lauf dauert länger als (Minuten)'],
  ['attempts', 'Fehlversuche in Folge'],
] as const

const ACTIONS = [
  ['comment', 'nur kommentieren'],
  ['stop', 'Lauf stoppen und neu einplanen'],
  ['block', 'stoppen und auf Mensch warten'],
] as const

const ON_FAIL = [
  ['todo', 'zurück an den Agenten'],
  ['blocked', 'auf Mensch warten'],
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
            Überwacht laufende Agenten und prüft auf Wunsch jedes Ergebnis, bevor ein Issue weiterwandert.
          </p>
        </div>
        <Toggle
          label="Aktiv"
          checked={watchdog().enabled}
          onChange={(on) => saveSettings((s) => void (s.watchdog.enabled = on))}
        />
      </div>

      <section class="section">
        <div class="section-head">
          <h3>Regeln</h3>
          <button
            onClick={() =>
              saveSettings((s) => s.watchdog.rules.push({ type: 'stall', value: 10, action: 'comment' }))
            }
          >
            Regel hinzufügen
          </button>
        </div>
        <ul class="rules">
          <For each={watchdog().rules} fallback={<li class="muted">Keine Regeln.</li>}>
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
                  aria-label="Regel entfernen"
                >
                  ✕
                </button>
              </li>
            )}
          </For>
        </ul>
      </section>

      <section class="section">
        <div class="section-head">
          <h3>Eigene Prüfung per KI</h3>
          <Toggle
            label="Nach jedem Lauf prüfen"
            checked={watchdog().llm.enabled}
            onChange={(on) => saveSettings((s) => void (s.watchdog.llm.enabled = on))}
          />
        </div>
        <Show when={watchdog().llm.enabled}>
          <div class="form">
            <Field
              label="Was soll geprüft werden?"
              hint="Der Prüfer liest das Arbeitsverzeichnis nur und antwortet mit PASS oder FAIL."
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
              <Field label="Prüfer läuft über">
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
              <Field label="Bei FAIL">
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
