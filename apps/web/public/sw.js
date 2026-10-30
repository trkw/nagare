// Service worker for Web Push: shows notifications and opens the entry when one is clicked.

self.addEventListener("activate", (event) => {
  // Control already open tabs, so a notification click can navigate them.
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: "Nagare", body: event.data ? event.data.text() : "" };
  }
  event.waitUntil(
    self.registration.showNotification(data.title || "Nagare", {
      body: data.body || "",
      tag: data.tag,
      data,
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  event.waitUntil(
    (async () => {
      if (!data.entry_id && data.url) return self.clients.openWindow(data.url);
      // The app opens ?entry= once the reader is ready, also after logging in.
      const target = new URL(data.entry_id ? `/?entry=${data.entry_id}` : "/", self.location.origin).href;
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const open = windows.find((w) => new URL(w.url).origin === self.location.origin);
      if (open) {
        const navigated = await open.navigate(target).catch(() => null);
        // A tab this worker does not control cannot be navigated; the reader listens for this message instead.
        if (!navigated && data.entry_id) open.postMessage({ type: "open-entry", entry_id: data.entry_id });
        return (navigated || open).focus();
      }
      return self.clients.openWindow(target);
    })(),
  );
});
