// Mails the owner when an issue waits for a human. Sent through AgentMail, from the server,
// so it costs no agent run. Reviews between agents are not mailed.
import { getSecret, setSecret } from './auth.ts'
import { addComment } from './core.ts'
import { get, run } from './db.ts'

type MailSettings = { inbox: string; to: string; hasKey: boolean }

const SECRET = 'agentmail'
const setting = (key: string): string => get('SELECT value FROM settings WHERE key=?', key)?.value ?? ''
const saveSetting = (key: string, value: string) =>
  run('INSERT OR REPLACE INTO settings (key, value) VALUES (?,?)', key, value)

export function mailSettings(): MailSettings {
  return { inbox: setting('mail.inbox'), to: setting('mail.to'), hasKey: !!getSecret(SECRET) }
}

export function saveMailSettings(input: { inbox?: string; to?: string; apiKey?: string }) {
  if (typeof input.inbox === 'string') saveSetting('mail.inbox', input.inbox.trim().slice(0, 200))
  if (typeof input.to === 'string') saveSetting('mail.to', input.to.trim().slice(0, 200))
  if (typeof input.apiKey === 'string') setSecret(SECRET, input.apiKey.trim())
  return mailSettings()
}

export async function sendMail(subject: string, text: string) {
  const { inbox, to } = mailSettings()
  const key = getSecret(SECRET)
  if (!inbox || !to || !key) throw new Error('Mail ist nicht eingerichtet (Postfach, Empfänger und Key)')

  const res = await fetch(`https://api.agentmail.to/v0/inboxes/${encodeURIComponent(inbox)}/messages/send`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ to: [to], subject, text }),
  })
  if (!res.ok) throw new Error(`AgentMail antwortet mit HTTP ${res.status}`)
}

const PUBLIC_URL = (process.env.AGENTDECK_PUBLIC_URL ?? '').replace(/\/$/, '')

/** Tells the owner that an issue needs them. Quietly does nothing when mail is off or not set up. */
export function notifyOwner(project: any, issue: any, reason: string) {
  const { inbox, to, hasKey } = mailSettings()
  if (!project.settings.notifyOwner || !inbox || !to || !hasKey) return

  const key = `${project.key}-${issue.number}`
  const text = [reason, issue.description, PUBLIC_URL && `${PUBLIC_URL}/#${key}`].filter(Boolean).join('\n\n')

  sendMail(`[${project.name}] ${key} wartet auf dich: ${issue.title}`, text).catch((error) => {
    // A failed mail must not go unnoticed, and it must not break the run that caused it.
    addComment(issue.id, 'System', 'system', `Mail an den Owner fehlgeschlagen: ${error.message}`)
  })
}
