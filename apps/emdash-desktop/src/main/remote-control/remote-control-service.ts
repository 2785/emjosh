import { execFile, spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { promisify } from 'node:util';
import type { Unsubscribe } from '@emdash/shared';
import type { Logger } from '@emdash/shared/logger';
import type { WireTransport } from '@emdash/wire/rpc';
import type { WorkspaceControlService } from '@core/features/workspace-control/node/workspace-control-service';
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
    /** Where to turn on Serve for the tailnet (needed once), after an attempt found it off. */
    setupUrl: string | null;
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
  /** Where to turn Serve on for the tailnet, when the last attempt found it off. */
  private tailscaleSetupUrl: string | null = null;
  private workspaceControl: Pick<WorkspaceControlService, 'createWorkspace'> | null = null;

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

  /** Provided once workspace control is up; creating workspaces waits for it. */
  setWorkspaceControl(service: Pick<WorkspaceControlService, 'createWorkspace'>): void {
    this.workspaceControl = service;
  }

  async createWorkspace(input: { projectId: string; prompt: string }) {
    if (!this.workspaceControl) throw new Error('Workspaces cannot be created yet.');
    const created = await this.workspaceControl.createWorkspace(
      { conversationId: null },
      { projectId: input.projectId, prompt: input.prompt }
    );
    return { id: created.id, name: created.name };
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
    const result = await runTailscaleServe(binary, [
      'serve',
      '--bg',
      `--https=${TAILSCALE_HTTPS_PORT}`,
      `http://127.0.0.1:${port}`,
    ]);
    this.tailscaleSetupUrl = result.setupUrl;
    if (!result.setupUrl && result.code !== 0) {
      throw new Error(result.output.trim() || 'Tailscale Serve did not start.');
    }
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
    if (!binary) return { installed: false, dnsName: null, servedUrl: null, setupUrl: null };
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
    if (served) this.tailscaleSetupUrl = null;
    return {
      installed: true,
      dnsName,
      servedUrl: served && dnsName ? `https://${dnsName}:${TAILSCALE_HTTPS_PORT}/` : null,
      setupUrl: this.tailscaleSetupUrl,
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

/**
 * Runs a `tailscale serve` command. When Serve is off for the tailnet, the CLI prints a link to
 * turn it on and then waits indefinitely; that link is returned instead of waiting.
 */
export function runTailscaleServe(
  binary: string,
  args: string[],
  timeoutMs = 20_000
): Promise<{ code: number | null; output: string; setupUrl: string | null }> {
  return new Promise((resolve) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let settled = false;
    const finish = (code: number | null, setupUrl: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, output, setupUrl });
    };
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      const setupUrl = tailscaleSetupUrl(output);
      if (setupUrl) {
        child.kill();
        finish(null, setupUrl);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (error) => {
      output += String(error);
      finish(null, null);
    });
    child.on('close', (code) => finish(code, tailscaleSetupUrl(output)));
    const timer = setTimeout(() => {
      child.kill();
      output += '\nTailscale did not respond in time.';
      finish(null, tailscaleSetupUrl(output));
    }, timeoutMs);
  });
}

/** The "turn on Serve" link Tailscale prints when Serve is off for the tailnet. */
export function tailscaleSetupUrl(output: string): string | null {
  return /https:\/\/login\.tailscale\.com\/f\/[^\s]+/.exec(output)?.[0] ?? null;
}
