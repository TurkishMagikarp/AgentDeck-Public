import { For, Show } from 'solid-js'
import { board, providers, saveSettings } from './store'
import { t } from './i18n'
import { Icon } from './icons'
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
            {t('Überwacht laufende Agenten und prüft auf Wunsch jedes Ergebnis, bevor ein Issue weiterwandert.')}
          </p>
        </div>
        <Toggle
          label={t('Aktiv')}
          checked={watchdog().enabled}
          onChange={(on) => saveSettings((s) => void (s.watchdog.enabled = on))}
        />
      </div>

      <section class="section">
        <div class="section-head">
          <h3>{t('Regeln')}</h3>
          <button
            onClick={() =>
              saveSettings((s) => s.watchdog.rules.push({ type: 'stall', value: 10, action: 'comment' }))
            }
          >
            {t('Regel hinzufügen')}
          </button>
        </div>
        <ul class="rules">
          <For each={watchdog().rules} fallback={<li class="muted">{t('Keine Regeln.')}</li>}>
            {(rule, index) => (
              <li>
                <Select
                  value={rule.type}
                  options={RULE_TYPES.map(([value, label]) => [value, t(label)] as const)}
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
                  options={ACTIONS.map(([value, label]) => [value, t(label)] as const)}
                  onChange={(action) => changeRule(index(), { action })}
                />
                <button
                  class="ghost danger"
                  onClick={() => saveSettings((s) => s.watchdog.rules.splice(index(), 1))}
                  aria-label={t('Regel entfernen')}
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
          <h3>{t('Eigene Prüfung per KI')}</h3>
          <Toggle
            label={t('Nach jedem Lauf prüfen')}
            checked={watchdog().llm.enabled}
            onChange={(on) => saveSettings((s) => void (s.watchdog.llm.enabled = on))}
          />
        </div>
        <Show when={watchdog().llm.enabled}>
          <div class="form">
            <Field
              label={t('Was soll geprüft werden?')}
              hint={t('Der Prüfer liest das Arbeitsverzeichnis nur und antwortet mit PASS oder FAIL.')}
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
              <Field label={t('Prüfer läuft über')}>
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
              <Field label={t('Bei FAIL')}>
                <Select
                  value={watchdog().llm.onFail}
                  options={ON_FAIL.map(([value, label]) => [value, t(label)] as const)}
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
