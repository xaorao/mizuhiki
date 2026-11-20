/*
 * Mizuhiki's service worker: Web Push only (spec 5.17). A push says what kind of thing happened; it never
 * carries content. Tapping the notification opens (or focuses) the matching dashboard page.
 */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let msg = { title: "Mizuhiki", body: "Something changed. Open Mizuhiki to see it.", url: "/app", type: "items" };
  try {
    if (event.data) msg = { ...msg, ...event.data.json() };
  } catch {
    // Not JSON: keep the plain words above.
  }
  event.waitUntil(
    Promise.all([
      // Open dashboards hear about it too (only the kind), so they can refresh.
      self.clients
        .matchAll({ type: "window", includeUncontrolled: true })
        .then((wins) => wins.forEach((w) => w.postMessage({ source: "mizuhiki-push", type: msg.type }))),
      self.registration.showNotification(msg.title, {
        body: msg.body,
        tag: msg.type,
        renotify: msg.type === "recovery",
        icon: "/icon-192.png",
        badge: "/badge-96.png",
        data: { url: msg.url },
      }),
    ]),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || "/app", self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
      for (const w of wins) {
        if (new URL(w.url).origin === self.location.origin && "focus" in w) {
          w.navigate(url);
          return w.focus();
        }
      }
      return self.clients.openWindow(url);
    }),
  );
});
