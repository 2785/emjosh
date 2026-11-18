import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import type { Duplex } from 'node:stream';
import type { Unsubscribe } from '@emdash/shared';
import { socketTransport, type SocketLike, type WireTransport } from '@emdash/wire/rpc';
import { WebSocketServer } from 'ws';
import type { RemoteControlStore, RemoteDevice } from './remote-control-store';
import {
  REMOTE_SHIM_JS,
  SERVICE_WORKER_JS,
  headTags,
  pairingPage,
  webManifest,
} from './web-assets';
import type { PushSubscriptionJson } from './web-push';

export const DEVICE_COOKIE = 'emjosh_device';
const MAX_JSON_BODY = 64 * 1024;

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.map': 'application/json',
};

export type RemoteControlServerOptions = {
  port: number;
  /** The built renderer (`out/renderer`): the remote app is the desktop UI. */
  rendererRoot: string;
  iconFile: string;
  productName: string;
  store: RemoteControlStore;
  /** Serves the desktop wire over a transport, as the window's port is served. */
  serveWire(transport: WireTransport): Unsubscribe;
  onError?(error: unknown): void;
};

export type RemoteControlServer = {
  readonly port: number;
  close(): Promise<void>;
};

/**
 * The remote control web app on 127.0.0.1: the desktop renderer with the wire over a WebSocket
 * at `/wire`, for paired devices only. It never listens beyond loopback; remote access comes
 * through Tailscale Serve, which terminates HTTPS on the tailnet and proxies here.
 */
export async function startRemoteControlServer(
  options: RemoteControlServerOptions
): Promise<RemoteControlServer> {
  const root = normalize(options.rendererRoot);
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024 });
  const connections = new Set<() => void>();

  const server: Server = createServer((request, response) => {
    handleRequest(request, response).catch((error: unknown) => {
      options.onError?.(error);
      if (!response.headersSent) send(response, 500, 'text/plain', 'Internal error');
      else response.end();
    });
  });

  async function deviceFor(request: IncomingMessage): Promise<RemoteDevice | null> {
    return options.store.authenticate(cookie(request, DEVICE_COOKIE));
  }

  async function handleRequest(request: IncomingMessage, response: ServerResponse) {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const path = url.pathname;

    // Reachable without pairing: the pairing flow and what installing the app needs.
    if (path === '/pair' && request.method === 'GET') {
      return send(response, 200, 'text/html; charset=utf-8', pairingPage(options.productName));
    }
    if (path === '/api/pair' && request.method === 'POST') {
      const body = (await readJson(request)) as { code?: unknown; name?: unknown } | null;
      const paired =
        typeof body?.code === 'string'
          ? await options.store.pair(body.code, typeof body.name === 'string' ? body.name : '')
          : null;
      if (!paired) return send(response, 403, 'text/plain', 'Invalid or expired code');
      response.setHeader('Set-Cookie', deviceCookie(paired.token));
      return send(response, 204, 'text/plain', '');
    }
    if (path === '/manifest.webmanifest') {
      return send(response, 200, 'application/manifest+json', webManifest(options.productName));
    }
    if (path === '/icon.png') {
      return send(response, 200, 'image/png', await readFile(options.iconFile), 'max-age=86400');
    }

    const device = await deviceFor(request);
    if (!device) {
      if (path.startsWith('/api/')) return send(response, 401, 'text/plain', 'Not paired');
      response.writeHead(302, { Location: '/pair' });
      return response.end();
    }

    if (path === '/remote-shim.js')
      return send(response, 200, CONTENT_TYPES['.js']!, REMOTE_SHIM_JS);
    if (path === '/sw.js') {
      response.setHeader('Service-Worker-Allowed', '/');
      return send(response, 200, CONTENT_TYPES['.js']!, SERVICE_WORKER_JS, 'no-cache');
    }
    if (path === '/api/push/key') {
      return send(response, 200, 'text/plain', (await options.store.load()).vapid.publicKey);
    }
    if (path === '/api/push/subscribe' && request.method === 'POST') {
      const subscription = (await readJson(request)) as PushSubscriptionJson | null;
      if (
        !subscription ||
        typeof subscription.endpoint !== 'string' ||
        !subscription.endpoint.startsWith('https://') ||
        typeof subscription.keys?.p256dh !== 'string' ||
        typeof subscription.keys?.auth !== 'string'
      ) {
        return send(response, 400, 'text/plain', 'Invalid subscription');
      }
      await options.store.setPush(device.id, {
        endpoint: subscription.endpoint,
        keys: { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth },
      });
      return send(response, 204, 'text/plain', '');
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return send(response, 405, 'text/plain', 'Method not allowed');
    }
    if (path === '/' || path === '/index.html') {
      // Keeps the cookie a year past the last visit, and brings older cookies to its current form.
      response.setHeader('Set-Cookie', deviceCookie(cookie(request, DEVICE_COOKIE)!));
    }
    return serveRenderer(path, response);
  }

  async function serveRenderer(path: string, response: ServerResponse) {
    const relative = decodeURIComponent(path).replace(/^\/+/, '') || 'index.html';
    let file = normalize(join(root, relative));
    if (!file.startsWith(root + sep)) return send(response, 403, 'text/plain', 'Forbidden');
    let body: Buffer;
    try {
      body = await readFile(file);
    } catch {
      // Unknown paths are app routes: serve the app.
      file = join(root, 'index.html');
      body = await readFile(file);
    }
    const type = CONTENT_TYPES[extname(file)] ?? 'application/octet-stream';
    if (file.endsWith('index.html')) {
      const html = body
        .toString('utf8')
        .replace('<head>', `<head>${headTags(options.productName)}`)
        // Use the whole screen around the notch, and shrink with the on-screen keyboard.
        .replace(
          /<meta name="viewport"[^>]*>/,
          '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">'
        );
      return send(response, 200, type, html, 'no-cache');
    }
    // Hashed bundle files never change; everything else revalidates.
    const cache = relative.startsWith('assets/')
      ? 'public, max-age=31536000, immutable'
      : 'no-cache';
    return send(response, 200, type, body, cache);
  }

  server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      const device = url.pathname === '/wire' ? await deviceFor(request) : null;
      // The cookie alone would let another site's page open the socket; require our origin.
      if (!device || !sameOrigin(request)) {
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      sockets.handleUpgrade(request, socket, head, (ws) => {
        const stop = options.serveWire(socketTransport(ws as unknown as SocketLike));
        const end = () => {
          connections.delete(end);
          stop();
        };
        connections.add(end);
        ws.on('close', end);
        // Keep idle connections alive through proxies and notice dead ones.
        const ping = setInterval(() => ws.ping(), 30_000);
        ws.on('close', () => clearInterval(ping));
      });
    })().catch((error: unknown) => {
      options.onError?.(error);
      socket.destroy();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  server.on('error', (error) => options.onError?.(error));

  return {
    port: options.port,
    async close() {
      for (const end of [...connections]) end();
      for (const client of sockets.clients) client.terminate();
      sockets.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/**
 * The device cookie. `Lax`, not `Strict`: Chrome withholds `Strict` cookies when an installed
 * web app is opened from the home screen or a notification (it counts as arriving from outside),
 * which would ask a paired device to pair again. Cross-site POSTs still don't carry `Lax`
 * cookies, and the WebSocket checks its origin.
 */
export function deviceCookie(token: string): string {
  return `${DEVICE_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000`;
}

function send(
  response: ServerResponse,
  status: number,
  type: string,
  body: string | Buffer,
  cache = 'no-store'
): void {
  response.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': cache,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  response.end(body);
}

function cookie(request: IncomingMessage, name: string): string | undefined {
  for (const part of (request.headers.cookie ?? '').split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return value.join('=');
  }
  return undefined;
}

/** Whether a request's Origin is the host it was sent to (as Tailscale Serve forwards it). */
export function sameOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  const host = request.headers['x-forwarded-host'] ?? request.headers.host;
  if (!origin || typeof host !== 'string') return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_JSON_BODY) return null;
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return null;
  }
}
