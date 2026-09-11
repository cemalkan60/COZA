// COZA — minimal service worker, "installability" only.
//
// Deliberately does NOT cache anything. This exists so the site qualifies
// as an installable PWA (Add to Home Screen / desktop install), not to
// provide offline access — that's a separate, future feature (full-catalog
// offline caching needs a real strategy so it never shows stale photos).
//
// skipWaiting + clients.claim make a new deploy take over immediately
// instead of waiting for every open tab to close first, so users never get
// stuck on an old version.

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// Passthrough fetch handler — required by some browsers' installability
// checks, but does no caching: every request just goes to the network.
self.addEventListener("fetch", () => {});
