// Web Push to the owner's devices. Unlike mail it has no daily send limit and lands on the phone
// at once. The VAPID key pair is made on first use and kept encrypted like every other secret.
import webpush from 'web-push'
import { getSecret, setSecret } from './auth.ts'
import { all, run } from './db.ts'
import { t } from './i18n.ts'

const SECRET = 'vapid'
const SUBJECT = process.env.AGENTDECK_PUBLIC_URL || 'https://localhost'

function vapidKeys(): { publicKey: string; privateKey: string } {
  const stored = getSecret(SECRET)
  if (stored) return JSON.parse(stored)
  const keys = webpush.generateVAPIDKeys()
  setSecret(SECRET, JSON.stringify(keys))
  return keys
}

export const pushPublicKey = () => vapidKeys().publicKey

type Subscription = { endpoint: string; keys: { p256dh: string; auth: string } }

export function subscribe(subscription: Subscription, device: string) {
  if (
    !/^https:\/\//.test(subscription?.endpoint ?? '') ||
    !subscription.keys?.p256dh ||
    !subscription.keys?.auth
  ) {
    throw new Error(t('Ungültiges Push-Abo'))
  }
  run(
    'INSERT OR REPLACE INTO push_subscriptions (endpoint, keys, device, created_at) VALUES (?,?,?,?)',
    subscription.endpoint,
    JSON.stringify(subscription.keys),
    device.slice(0, 120),
    Date.now(),
  )
}

export function unsubscribe(endpoint: string) {
  run('DELETE FROM push_subscriptions WHERE endpoint=?', endpoint)
}

export const pushDevices = () =>
  all('SELECT endpoint, device, created_at FROM push_subscriptions ORDER BY created_at')

/** Sends to every subscribed device. Devices the push service no longer knows are dropped. */
export async function sendPush(title: string, body: string, url = '/') {
  const subscriptions = all('SELECT endpoint, keys FROM push_subscriptions')
  if (!subscriptions.length) return 0
  const { publicKey, privateKey } = vapidKeys()
  const payload = JSON.stringify({ title, body: body.slice(0, 400), url })

  let delivered = 0
  await Promise.all(
    subscriptions.map(async (row) => {
      try {
        await webpush.sendNotification({ endpoint: row.endpoint, keys: JSON.parse(row.keys) }, payload, {
          vapidDetails: {
            subject: SUBJECT.startsWith('http') ? SUBJECT : `mailto:${SUBJECT}`,
            publicKey,
            privateKey,
          },
          TTL: 6 * 3600,
        })
        delivered++
      } catch (error: any) {
        if (error.statusCode === 404 || error.statusCode === 410) unsubscribe(row.endpoint)
        else console.error('push', error.statusCode ?? '', error.message)
      }
    }),
  )
  return delivered
}
