// Service worker for Web Push: shows notifications and opens the entry when one is clicked.

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
      const target = data.entry_id ? `/?entry=${data.entry_id}` : "/";
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const open = windows.find((w) => new URL(w.url).origin === self.location.origin);
      if (open) {
        open.postMessage({ type: "open-entry", entry_id: data.entry_id });
        return open.focus();
      }
      return self.clients.openWindow(target);
    })(),
  );
});
