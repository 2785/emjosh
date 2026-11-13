import {
  reconnectingTransport,
  socketTransport,
  type SocketLike,
  type WireTransport,
} from '@emdash/wire/rpc';
import { runNotificationOpenHandler } from '@core/primitives/notifications/browser/open-handlers';

type RemoteWebConfig = { wirePath: string };

/** Set by the remote control server's shim when the app runs in a browser, not the window. */
export function remoteWebConfig(): RemoteWebConfig | null {
  return (window as unknown as { __EMJOSH_REMOTE__?: RemoteWebConfig }).__EMJOSH_REMOTE__ ?? null;
}

/** The desktop wire over the remote control WebSocket, reconnecting across network drops. */
export async function remoteWireTransport(config: RemoteWebConfig): Promise<WireTransport> {
  const url = new URL(config.wirePath, location.href);
  url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const transport = reconnectingTransport(
    () =>
      new Promise<WireTransport>((resolve, reject) => {
        const socket = new WebSocket(url);
        socket.addEventListener(
          'open',
          () => resolve(socketTransport(socket as unknown as SocketLike)),
          {
            once: true,
          }
        );
        socket.addEventListener('error', () => reject(new Error('Remote wire unreachable')), {
          once: true,
        });
      }),
    { backoffMs: [250, 500, 1000, 2000, 5000] }
  );
  await transport.ready();
  return transport;
}

/**
 * Opens what a clicked push notification points at, like a click on a desktop notification:
 * from the service worker while the app is open, or from `?open=` when the click opened it.
 */
export function installRemoteNotificationOpening(): void {
  const open = (message: unknown) => {
    const data = message as { type?: unknown; target?: unknown; notificationId?: unknown };
    if (data?.type !== 'emjosh-open' || !data.target) return;
    runNotificationOpenHandler(
      data.target as Parameters<typeof runNotificationOpenHandler>[0],
      typeof data.notificationId === 'string' ? data.notificationId : ''
    );
  };
  navigator.serviceWorker?.addEventListener('message', (event) => open(event.data));
  const pending = new URLSearchParams(location.search).get('open');
  if (pending) {
    history.replaceState(null, '', location.pathname);
    try {
      open(JSON.parse(pending));
    } catch {
      // A malformed link opens the app as usual.
    }
  }
}
