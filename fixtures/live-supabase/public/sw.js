// Here so the live pane meets a service worker (#55). It passes page requests through; Supabase calls are cross-origin and skip it.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (e) => {
  if (new URL(e.request.url).origin === location.origin) e.respondWith(fetch(e.request));
});
