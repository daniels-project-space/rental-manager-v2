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

// Self-heal: when the browser rotates or expires the push subscription, resubscribe
// with the VAPID key and re-save it — so notifications never silently stop. (iOS
// Safari rarely fires this; the app also re-attaches on every open as the primary
// heal. This covers Chrome/Android background rotation.)
function urlB64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

// Workers cannot read localStorage. Retain the current opaque endpoint in
// IndexedDB so rotation can prove it belongs to the selected installation,
// even when oldSubscription is missing and all app windows are closed.
function subscriptionEndpoint(value,key="endpoint") {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("rental-manager-push", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("registration");
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("Push registration storage blocked"));
    request.onsuccess = () => {
      const db = request.result;
      const transaction = db.transaction("registration", value === undefined ? "readonly" : "readwrite");
      const store = transaction.objectStore("registration");
      const operation = value === undefined ? store.get(key) : store.put(value,key);
      let result;
      operation.onsuccess = () => { result = operation.result; };
      transaction.oncomplete = () => { db.close(); resolve(result); };
      transaction.onerror = () => { db.close(); reject(transaction.error); };
      transaction.onabort = () => { db.close(); reject(transaction.error); };
    };
  });
}
self.addEventListener("message", (event) => {
  if(event.origin && event.origin!==self.location.origin)return;
  if (event.data?.type === "push-registration-saved" && typeof event.data.endpoint === "string")
    event.waitUntil(Promise.all([subscriptionEndpoint(event.data.endpoint),
      ...(typeof event.data.renewal_credential === "string" && /^[a-f0-9]{64}$/.test(event.data.renewal_credential) ? [subscriptionEndpoint(event.data.renewal_credential,"renewal_credential")] : [])]));
});

self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(
    (async () => {
      try {
        const previousEndpoint = event.oldSubscription?.endpoint || await subscriptionEndpoint();
        const res = await fetch("/api/push/vapid");
        if (!res.ok) throw new Error("Could not load push configuration");
        const { key } = await res.json();
        if (!key) return;
        const sub = event.newSubscription || await self.registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlB64ToUint8Array(key),
        });
        const json = sub.toJSON();
        const renewalCredential=await subscriptionEndpoint(undefined,"renewal_credential");
        // Older installations migrate on their next foreground owner save.
        // The capability route works after that owner's login cookie expires.
        const saved = await fetch(renewalCredential ? "/api/push/renew" : "/api/push/save", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            endpoint: sub.endpoint,
            ...(renewalCredential ? {renewal_credential:renewalCredential} : {}),
            previous_endpoint: previousEndpoint,
            p256dh: (json.keys && json.keys.p256dh) || "",
            auth: (json.keys && json.keys.auth) || "",
          }),
        });
        if (!saved.ok) throw new Error("Could not save renewed push registration");
        const result = await saved.json();
        if (result.active) await subscriptionEndpoint(sub.endpoint);
      } catch (e) {
        console.warn("[push] Subscription renewal failed; foreground recovery will retry");
      }
    })(),
  );
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
    // The Notifications API rejects renotify=true without a non-empty tag.
    renotify: !!data.tag,
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
      // Reuse an existing dashboard tab if one is open. postMessage is the
      // RELIABLE path on iOS (where WindowClient.navigate() frequently no-ops,
      // so a tapped push wouldn't switch the open chat); the app listens for it
      // and routes to the thread. navigate() stays as a fallback for desktop.
      for (const client of all) {
        try {
          await client.focus();
          client.postMessage({ type: "deep-link", url: targetUrl });
          if ("navigate" in client) {
            try { await client.navigate(targetUrl); } catch (e) { /* iOS: ignore */ }
          }
          return;
        } catch (e) {
          /* fall through to openWindow */
        }
      }
      if (self.clients.openWindow) await self.clients.openWindow(targetUrl);
    })(),
  );
});
