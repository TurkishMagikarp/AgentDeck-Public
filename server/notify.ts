// Mails the owner when an issue waits for a human. Sent through AgentMail, from the server,
// so it costs no agent run. Reviews between agents are not mailed.
import { getSecret, setSecret } from './auth.ts'
import { addComment } from './core.ts'
import { get, run } from './db.ts'
import { sendPush } from './push.ts'

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
  if (!inbox || !to || !key) throw new Error('Mail is not set up (inbox, recipient and key)')

  const res = await fetch(`https://api.agentmail.to/v0/inboxes/${encodeURIComponent(inbox)}/messages/send`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ to: [to], subject, text }),
  })
  if (!res.ok) throw new Error(`AgentMail answered with HTTP ${res.status}`)
}

const PUBLIC_URL = (process.env.AGENTDECK_PUBLIC_URL ?? '').replace(/\/$/, '')

/**
 * Tells the owner that an issue needs them: by push on every subscribed device, and by mail when
 * mail is set up. Quietly does nothing when the project does not want to be told.
 */
export function notifyOwner(project: any, issue: any, reason: string) {
  if (!project.settings.notifyOwner) return
  const key = `${project.key}-${issue.number}`
  sendPush(`${key}: ${issue.title}`, reason, `/#${key}`).catch((error) =>
    console.error('push', error.message),
  )

  const { inbox, to, hasKey } = mailSettings()
  if (!inbox || !to || !hasKey) return

  const text = [reason, issue.description, PUBLIC_URL && `${PUBLIC_URL}/#${key}`].filter(Boolean).join('\n\n')

  sendMail(`[${project.name}] ${key} waits for you: ${issue.title}`, text).catch((error) => {
    // A failed mail must not go unnoticed, and it must not break the run that caused it.
    addComment(issue.id, 'System', 'system', `Mail to the owner failed: ${error.message}`)
  })
}
