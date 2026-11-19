/**
 * sw.js - Inkie Deck service worker.
 *
 * Static asset at root scope. No fs/env access here: every push
 * payload carries everything the notification needs (title, body, deepLink).
 *
 * push          -> show the notification verbatim from the payload.
 * notificationclick -> focus an existing Deck window on the deep link, or
 *                      open a fresh one.
 *
 * ASCII only - no em-dashes.
 */

self.addEventListener("install", () => {
  // Activate immediately on update - the SW carries no caches to migrate.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let payload = { title: "Inkie Deck", body: "", deepLink: "/" };
  try {
    if (event.data) payload = { ...payload, ...event.data.json() };
  } catch {
    // Unparseable payload - show the generic notification rather than nothing.
  }
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: "/icons/mc-192.png",
      badge: "/icons/mc-192.png",
      data: { deepLink: payload.deepLink },
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const deepLink = (event.notification.data && event.notification.data.deepLink) || "/";
  const target = new URL(deepLink, self.location.origin).href;
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clientList) => {
        for (const client of clientList) {
          if (client.url.startsWith(self.location.origin) && "focus" in client) {
            client.navigate(target);
            return client.focus();
          }
        }
        return self.clients.openWindow(target);
      })
  );
});
