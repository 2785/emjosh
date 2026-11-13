/**
 * Static pieces of the remote control web app that the desktop renderer doesn't have: the
 * stand-in for the Electron preload bridge, the service worker for push notifications, the
 * web app manifest, and the pairing page.
 */

/**
 * Runs before the renderer bundle. Replaces the preload bridge (the wire comes over a
 * WebSocket instead; see seedDesktopWire), registers the service worker, and offers to turn on
 * notifications.
 */
export const REMOTE_SHIM_JS = String.raw`(function () {
  window.__EMJOSH_REMOTE__ = { wirePath: '/wire' };
  window.electronAPI = {
    getPathForFile: function () { return ''; },
    requestWirePort: function () { return Promise.resolve(); },
    onBootStuck: function () { return function () {}; },
    requestBootEscape: function () { return Promise.resolve(); },
    reportBootUsable: function () {},
  };

  function keyBytes(base64url) {
    var base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
    var raw = atob(base64 + '==='.slice((base64.length + 3) % 4));
    var bytes = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    return bytes;
  }

  function subscribe(registration) {
    return fetch('/api/push/key')
      .then(function (response) { return response.text(); })
      .then(function (key) {
        return registration.pushManager.getSubscription().then(function (existing) {
          return existing || registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: keyBytes(key),
          });
        });
      })
      .then(function (subscription) {
        return fetch('/api/push/subscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(subscription.toJSON()),
        });
      });
  }

  if (!('serviceWorker' in navigator)) return;
  var ready = navigator.serviceWorker.register('/sw.js').then(function () {
    return navigator.serviceWorker.ready;
  });
  var pushable = 'PushManager' in window && 'Notification' in window;
  // Keep the subscription current on every visit once allowed.
  if (pushable && Notification.permission === 'granted') ready.then(subscribe).catch(function () {});

  window.__EMJOSH_REMOTE__.enableNotifications = function () {
    return Notification.requestPermission().then(function (permission) {
      if (permission !== 'granted') return false;
      return ready.then(subscribe).then(function () { return true; });
    });
  };

  // Notifications need a user gesture to enable, so offer a button.
  if (!pushable || Notification.permission !== 'default') return;
  if (localStorage.getItem('emjosh-remote-notifications-dismissed')) return;
  document.addEventListener('DOMContentLoaded', function () {
    var bar = document.createElement('div');
    bar.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:2147483647;display:flex;gap:6px;align-items:center;padding:8px 10px;border-radius:10px;background:#1f2937;color:#f9fafb;font:13px system-ui,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.3)';
    var enable = document.createElement('button');
    enable.textContent = 'Enable notifications';
    enable.style.cssText = 'all:unset;cursor:pointer;font-weight:600';
    var close = document.createElement('button');
    close.textContent = '×';
    close.setAttribute('aria-label', 'Dismiss');
    close.style.cssText = 'all:unset;cursor:pointer;padding:0 4px;opacity:.7';
    enable.onclick = function () {
      window.__EMJOSH_REMOTE__.enableNotifications().finally(function () { bar.remove(); });
    };
    close.onclick = function () {
      localStorage.setItem('emjosh-remote-notifications-dismissed', '1');
      bar.remove();
    };
    bar.append(enable, close);
    document.body.append(bar);
  });
})();
`;

/**
 * Shows pushed notifications; a click focuses (or opens) the app and asks it to open the
 * notification's target.
 */
export const SERVICE_WORKER_JS = String.raw`self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (event) { event.waitUntil(self.clients.claim()); });

self.addEventListener('push', function (event) {
  var data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) {}
  event.waitUntil(self.registration.showNotification(data.title || 'Emjosh', {
    body: data.body || '',
    tag: data.tag,
    icon: '/icon.png',
    badge: '/icon.png',
    data: { target: data.target || null, notificationId: data.notificationId || null },
  }));
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  var message = {
    type: 'emjosh-open',
    target: event.notification.data && event.notification.data.target,
    notificationId: event.notification.data && event.notification.data.notificationId,
  };
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (clients) {
    for (var i = 0; i < clients.length; i++) {
      if ('focus' in clients[i]) {
        clients[i].postMessage(message);
        return clients[i].focus();
      }
    }
    return self.clients.openWindow('/?open=' + encodeURIComponent(JSON.stringify(message)));
  }));
});
`;

export function webManifest(productName: string): string {
  return JSON.stringify({
    name: productName,
    short_name: productName,
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#111111',
    theme_color: '#111111',
    icons: [{ src: '/icon.png', sizes: '512x512', type: 'image/png', purpose: 'any' }],
  });
}

/** Tags added to the renderer's `<head>` so the page installs as an app. */
export function headTags(productName: string): string {
  return [
    '<script src="/remote-shim.js"></script>',
    '<link rel="manifest" href="/manifest.webmanifest">',
    '<link rel="apple-touch-icon" href="/icon.png">',
    '<meta name="apple-mobile-web-app-capable" content="yes">',
    `<meta name="apple-mobile-web-app-title" content="${productName}">`,
    '<meta name="theme-color" content="#111111">',
  ].join('');
}

/** Pairing: the code shown in the desktop app's settings, and a name for this device. */
export function pairingPage(productName: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pair with ${productName}</title>
<link rel="manifest" href="/manifest.webmanifest">
<style>
  :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px; box-sizing: border-box; }
  form { width: min(100%, 360px); display: grid; gap: 12px; }
  h1 { font-size: 20px; margin: 0; }
  p { margin: 0; opacity: .75; font-size: 14px; line-height: 1.4; }
  input, button { font: inherit; padding: 10px 12px; border-radius: 8px; border: 1px solid #8884; }
  input[name=code] { font-size: 24px; letter-spacing: .3em; text-align: center; }
  button { background: #2563eb; color: white; border: 0; font-weight: 600; cursor: pointer; }
  .error { color: #dc2626; min-height: 1.2em; }
</style></head>
<body><form id="pair">
  <h1>Pair with ${productName}</h1>
  <p>In ${productName} on your computer, open Settings → Remote control and choose <b>Pair a device</b>. Enter the code it shows.</p>
  <input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="000000" required autofocus>
  <input name="name" placeholder="Device name (e.g. Phone)" maxlength="80">
  <button type="submit">Pair</button>
  <p class="error" id="error"></p>
</form>
<script>
  document.querySelector('input[name=name]').value = /iPhone|iPad/.test(navigator.userAgent) ? 'iPhone' : /Android/.test(navigator.userAgent) ? 'Android' : 'Browser';
  document.getElementById('pair').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.target);
    const response = await fetch('/api/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: String(form.get('code')).trim(), name: String(form.get('name')) }),
    });
    if (response.ok) location.replace('/');
    else document.getElementById('error').textContent = 'That code did not work. Create a new one and try again.';
  });
</script></body></html>`;
}
