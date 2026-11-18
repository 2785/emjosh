// The subset of the `ws` package the remote control server uses (ws ships no types).
declare module 'ws' {
  import type { IncomingMessage } from 'node:http';
  import type { Duplex } from 'node:stream';

  export class WebSocket {
    send(data: string): void;
    close(code?: number, reason?: string): void;
    terminate(): void;
    ping(): void;
    on(event: 'close', listener: () => void): this;
    addEventListener(type: string, listener: (event: { data: unknown }) => void): void;
    removeEventListener(type: string, listener: (...args: never[]) => void): void;
  }

  export class WebSocketServer {
    constructor(options: { noServer: true; maxPayload?: number });
    readonly clients: Set<WebSocket>;
    handleUpgrade(
      request: IncomingMessage,
      socket: Duplex,
      head: Buffer,
      callback: (socket: WebSocket) => void
    ): void;
    close(): void;
  }
}
