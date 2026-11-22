// Service worker: shows AgentDeck's push messages and opens the issue on a tap.
// It caches nothing; the board always comes live from the server.
self.addEventListener('push', (event) => {
  const message = event.data ? event.data.json() : { title: 'AgentDeck', body: '' }
  event.waitUntil(
    self.registration.showNotification(message.title, {
      body: message.body,
      icon: '/icon.svg',
      badge: '/icon.svg',
      data: { url: message.url || '/' },
    }),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = new URL(event.notification.data.url, self.location.origin).href
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then((windows) => {
      const open = windows.find((client) => client.url.startsWith(self.location.origin))
      if (open) return open.navigate(url).then((client) => client && client.focus())
      return self.clients.openWindow(url)
    }),
  )
})
