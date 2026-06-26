/* Rental Manager v2 — push service worker (2026-06-23).
 * Shows web-push notifications and, on tap, focuses/opens the dashboard at the
 * notification's deep link (/?thread=…) so the operator lands on the chat
 * thread ready to reply. */

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: "Rental Manager", body: event.data ? event.data.text() : "" };
  }
  const title = data.title || "Rental Manager";
  const options = {
    body: data.body || "",
    // Big icon: the blue Aputure mark, recoloured per account by the server
    // (data.icon) so you can tell the account at a glance. Falls back to blue.
    icon: data.icon || "/icons/notif-aputure.png",
    // Badge: OS-tinted monochrome silhouette (Android status bar).
    badge: data.badge || "/icons/notif-badge.png",
    tag: data.tag || undefined,
    renotify: true,
    data: { url: data.url || "/" },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      // Reuse an existing dashboard tab if one is open — navigate it to the thread.
      for (const client of all) {
        try {
          await client.focus();
          if ("navigate" in client) await client.navigate(targetUrl);
          return;
        } catch (e) {
          /* fall through to openWindow */
        }
      }
      if (self.clients.openWindow) await self.clients.openWindow(targetUrl);
    })(),
  );
});
