import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect, serve, socketTransport, type SocketLike } from '@emdash/wire/rpc';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import {
  DEVICE_COOKIE,
  startRemoteControlServer,
  type RemoteControlServer,
} from './remote-control-server';
import { RemoteControlStore } from './remote-control-store';

describe('remote control server', () => {
  let dir: string;
  let store: RemoteControlStore;
  let server: RemoteControlServer;
  let base: string;
  const served: string[] = [];

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'remote-control-'));
    const renderer = join(dir, 'renderer');
    mkdirSync(join(renderer, 'assets'), { recursive: true });
    writeFileSync(join(renderer, 'index.html'), '<html><head><title>App</title></head></html>');
    writeFileSync(join(renderer, 'assets', 'app.js'), 'console.log(1)');
    writeFileSync(join(dir, 'secret.txt'), 'nope');
    writeFileSync(join(dir, 'icon.png'), 'png');
    store = new RemoteControlStore(join(dir, 'remote-control.json'));
    const port = 20_000 + Math.floor(Math.random() * 20_000);
    server = await startRemoteControlServer({
      port,
      rendererRoot: renderer,
      iconFile: join(dir, 'icon.png'),
      productName: 'Emjosh',
      store,
      serveWire: (transport) => {
        served.push('connection');
        return serve(transport, {
          call: async (path: string, input: unknown) => ({ success: true, data: { path, input } }),
          resolveLive: () => {
            throw new Error('none');
          },
          acquireLive: () => {
            throw new Error('none');
          },
        } as never);
      },
    });
    base = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
    served.length = 0;
  });

  async function pairedCookie(): Promise<string> {
    const { code } = store.createPairingCode();
    const response = await fetch(`${base}/api/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, name: 'Phone' }),
    });
    expect(response.status).toBe(204);
    const setCookie = response.headers.get('set-cookie')!;
    expect(setCookie).toMatch(/HttpOnly; Secure; SameSite=Strict/);
    return setCookie.split(';')[0]!;
  }

  it('sends unpaired visitors to pairing and refuses wrong codes', async () => {
    const home = await fetch(`${base}/`, { redirect: 'manual' });
    expect(home.status).toBe(302);
    expect(home.headers.get('location')).toBe('/pair');
    expect((await fetch(`${base}/api/push/key`)).status).toBe(401);

    store.createPairingCode();
    const wrong = await fetch(`${base}/api/pair`, {
      method: 'POST',
      body: JSON.stringify({ code: '-1', name: 'x' }),
    });
    expect(wrong.status).toBe(403);
  });

  it('serves the app with the remote shim to a paired device, and nothing outside it', async () => {
    const cookie = await pairedCookie();
    const html = await (await fetch(`${base}/`, { headers: { cookie } })).text();
    expect(html).toContain('<head><script src="/remote-shim.js"></script>');
    expect(await (await fetch(`${base}/assets/app.js`, { headers: { cookie } })).text()).toBe(
      'console.log(1)'
    );
    const escape = await fetch(`${base}/..%2Fsecret.txt`, { headers: { cookie } });
    expect(await escape.text()).not.toBe('nope');
    expect((await store.load()).devices.map((device) => device.name)).toEqual(['Phone']);
  });

  it('stores a push subscription for the device', async () => {
    const cookie = await pairedCookie();
    const response = await fetch(`${base}/api/push/subscribe`, {
      method: 'POST',
      headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        endpoint: 'https://push.example.com/x',
        keys: { p256dh: 'a', auth: 'b' },
      }),
    });
    expect(response.status).toBe(204);
    expect((await store.load()).devices[0]?.push?.endpoint).toBe('https://push.example.com/x');
  });

  it('carries the wire over a WebSocket from its own origin only', async () => {
    const cookie = await pairedCookie();
    const open = (origin: string) =>
      new Promise<WebSocket>((resolve, reject) => {
        const Socket = WebSocket as unknown as new (
          url: string,
          options: { headers: Record<string, string> }
        ) => WebSocket;
        const socket = new Socket(`${base.replace('http', 'ws')}/wire`, {
          headers: { cookie, origin },
        });
        socket.addEventListener('open', () => resolve(socket));
        socket.addEventListener('error', () => reject(new Error('refused')));
      });

    await expect(open('https://evil.example')).rejects.toThrow();
    expect(served).toEqual([]);

    const socket = await open(base);
    const connection = connect(socketTransport(socket as unknown as SocketLike));
    expect(await connection.call('tasks.list', { limit: 1 })).toEqual({
      success: true,
      data: { path: 'tasks.list', input: { limit: 1 } },
    });
    expect(served).toEqual(['connection']);
    socket.close();
  });
});
