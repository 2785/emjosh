import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { promisify } from 'node:util';
import type { Unsubscribe } from '@emdash/shared';
import type { Logger } from '@emdash/shared/logger';
import type { WireTransport } from '@emdash/wire/rpc';
import type { NotificationSink } from '@core/services/notifications/api/ports';
import { startRemoteControlServer, type RemoteControlServer } from './remote-control-server';
import type { RemoteControlStore } from './remote-control-store';
import { sendWebPush } from './web-push';

const run = promisify(execFile);

/** The tailnet HTTPS port Tailscale Serve exposes remote control on (443 stays the user's). */
export const TAILSCALE_HTTPS_PORT = 8443;
const TAILSCALE_BINARIES = [
  '/usr/local/bin/tailscale',
  '/opt/homebrew/bin/tailscale',
  '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
  '/usr/bin/tailscale',
];

export type RemoteControlStatus = {
  enabled: boolean;
  /** Listening on 127.0.0.1 now; false when enabled but the port was taken. */
  running: boolean;
  port: number;
  error: string | null;
  tailscale: {
    installed: boolean;
    /** This machine's tailnet name, e.g. `mac.tailnet.ts.net`; null when not connected. */
    dnsName: string | null;
    /** The remote control URL when Tailscale Serve forwards to it. */
    servedUrl: string | null;
  };
  devices: {
    id: string;
    name: string;
    createdAt: number;
    lastSeenAt: number | null;
    push: boolean;
  }[];
};

export type RemoteControlServiceDeps = {
  store: RemoteControlStore;
  rendererRoot: string;
  iconFile: string;
  productName: string;
  serveWire(transport: WireTransport): Unsubscribe;
  logger: Logger;
};

/**
 * Remote control: the desktop UI served to paired devices over Tailscale, with push
 * notifications. Off until the user turns it on in settings.
 */
export class RemoteControlService {
  private server: RemoteControlServer | null = null;
  private error: string | null = null;
  private tailscaleBinary: string | null | undefined;

  constructor(private readonly deps: RemoteControlServiceDeps) {}

  /** Starts serving if it was left on. */
  async initialize(): Promise<void> {
    const state = await this.deps.store.load();
    if (state.enabled) await this.startServer();
  }

  async status(): Promise<RemoteControlStatus> {
    const state = await this.deps.store.load();
    return {
      enabled: state.enabled,
      running: this.server !== null,
      port: state.port,
      error: this.error,
      tailscale: await this.tailscaleStatus(state.port),
      devices: state.devices.map((device) => ({
        id: device.id,
        name: device.name,
        createdAt: device.createdAt,
        lastSeenAt: device.lastSeenAt,
        push: device.push !== null,
      })),
    };
  }

  async setEnabled(enabled: boolean): Promise<RemoteControlStatus> {
    await this.deps.store.update({ enabled });
    if (enabled) await this.startServer();
    else {
      await this.stopServer();
      await this.disableTailscale().catch(() => {});
    }
    return this.status();
  }

  createPairingCode(): { code: string; expiresAt: number } {
    return this.deps.store.createPairingCode();
  }

  async revokeDevice(id: string): Promise<RemoteControlStatus> {
    await this.deps.store.revoke(id);
    return this.status();
  }

  /** Has Tailscale Serve forward this machine's tailnet HTTPS port to the local server. */
  async enableTailscale(): Promise<RemoteControlStatus> {
    const binary = await this.findTailscale();
    if (!binary) throw new Error('Tailscale is not installed.');
    const { port } = await this.deps.store.load();
    await run(binary, [
      'serve',
      '--bg',
      `--https=${TAILSCALE_HTTPS_PORT}`,
      `http://127.0.0.1:${port}`,
    ]);
    return this.status();
  }

  async disableTailscale(): Promise<RemoteControlStatus> {
    const binary = await this.findTailscale();
    if (binary && (await this.servedByTailscale(binary, (await this.deps.store.load()).port))) {
      await run(binary, ['serve', `--https=${TAILSCALE_HTTPS_PORT}`, 'off']);
    }
    return this.status();
  }

  /** Pushes desktop notifications to paired devices that turned notifications on. */
  pushSink(): NotificationSink {
    return {
      id: 'push',
      deliver: async ({ notification, summary }) => {
        const state = await this.deps.store.load();
        if (!state.enabled) return;
        await Promise.all(
          state.devices.map(async (device) => {
            if (!device.push) return;
            try {
              const result = await sendWebPush(
                device.push,
                {
                  title: summary.title,
                  body: summary.body,
                  tag: notification.groupKey,
                  target: notification.target,
                  notificationId: notification.id,
                },
                state.vapid,
                'mailto:remote-control@emjosh.invalid'
              );
              if (result === 'gone') await this.deps.store.setPush(device.id, null);
              else if (result === 'failed') {
                this.deps.logger.warn('Remote control: push failed', { device: device.id });
              }
            } catch (error) {
              this.deps.logger.warn('Remote control: push failed', { device: device.id, error });
            }
          })
        );
      },
    };
  }

  async dispose(): Promise<void> {
    await this.stopServer();
  }

  private async startServer(): Promise<void> {
    if (this.server) return;
    const { port } = await this.deps.store.load();
    try {
      this.server = await startRemoteControlServer({
        port,
        rendererRoot: this.deps.rendererRoot,
        iconFile: this.deps.iconFile,
        productName: this.deps.productName,
        store: this.deps.store,
        serveWire: this.deps.serveWire,
        onError: (error) => this.deps.logger.warn('Remote control server error', { error }),
      });
      this.error = null;
    } catch (error) {
      this.error =
        (error as NodeJS.ErrnoException).code === 'EADDRINUSE'
          ? `Port ${port} is in use.`
          : error instanceof Error
            ? error.message
            : String(error);
      this.deps.logger.warn('Remote control server did not start', { error });
    }
  }

  private async stopServer(): Promise<void> {
    const server = this.server;
    this.server = null;
    await server?.close();
  }

  private async findTailscale(): Promise<string | null> {
    if (this.tailscaleBinary !== undefined) return this.tailscaleBinary;
    for (const candidate of TAILSCALE_BINARIES) {
      try {
        await access(candidate);
        this.tailscaleBinary = candidate;
        return candidate;
      } catch {
        // Try the next location.
      }
    }
    this.tailscaleBinary = null;
    return null;
  }

  private async tailscaleStatus(port: number): Promise<RemoteControlStatus['tailscale']> {
    const binary = await this.findTailscale();
    if (!binary) return { installed: false, dnsName: null, servedUrl: null };
    let dnsName: string | null = null;
    try {
      const { stdout } = await run(binary, ['status', '--json'], { timeout: 5_000 });
      const parsed = JSON.parse(stdout) as { BackendState?: string; Self?: { DNSName?: string } };
      if (parsed.BackendState === 'Running' && parsed.Self?.DNSName) {
        dnsName = parsed.Self.DNSName.replace(/\.$/, '');
      }
    } catch {
      // Not running or not logged in.
    }
    const served = dnsName ? await this.servedByTailscale(binary, port) : false;
    return {
      installed: true,
      dnsName,
      servedUrl: served && dnsName ? `https://${dnsName}:${TAILSCALE_HTTPS_PORT}/` : null,
    };
  }

  /** Whether Tailscale Serve forwards our tailnet port to the local server. */
  private async servedByTailscale(binary: string, port: number): Promise<boolean> {
    try {
      const { stdout } = await run(binary, ['serve', 'status', '--json'], { timeout: 5_000 });
      return servesPort(JSON.parse(stdout), port);
    } catch {
      return false;
    }
  }
}

/** Whether a `tailscale serve status --json` config proxies our HTTPS port to `port`. */
export function servesPort(config: unknown, port: number): boolean {
  const web = (
    config as { Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }> }
  ).Web;
  return Object.entries(web ?? {}).some(
    ([host, entry]) =>
      host.endsWith(`:${TAILSCALE_HTTPS_PORT}`) &&
      Object.values(entry.Handlers ?? {}).some((handler) =>
        /^http:\/\/(127\.0\.0\.1|localhost):(\d+)\/?$/.test(handler.Proxy ?? '')
          ? handler.Proxy!.includes(`:${port}`)
          : false
      )
  );
}
