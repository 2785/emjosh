import type { Unsubscribe } from '@emdash/shared';
import { isWireMessage, type WireMessage, type WireTransport } from '../protocol';

/**
 * The part of a WebSocket the transport needs; both the browser's `WebSocket` and the `ws`
 * package's sockets fit it.
 */
export type SocketLike = {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  addEventListener(type: 'close' | 'error', listener: () => void): void;
  removeEventListener(type: string, listener: (...args: never[]) => void): void;
};

/**
 * A wire transport over a WebSocket, for clients outside the Electron window (e.g. the remote
 * control web app). Messages travel as text frames in {@link encodeWireJson}, which keeps the
 * values structured clone carries over a MessagePort but JSON alone would lose.
 */
export function socketTransport(socket: SocketLike): WireTransport {
  const messageListeners = new Set<(message: WireMessage) => void>();
  const disconnectListeners = new Set<() => void>();
  let disconnected = false;

  const onMessage = (event: { data: unknown }) => {
    if (disconnected || typeof event.data !== 'string') return;
    let message: unknown;
    try {
      message = decodeWireJson(event.data);
    } catch {
      return;
    }
    if (!isWireMessage(message)) return;
    for (const listener of messageListeners) listener(message);
  };
  const onClose = () => {
    if (disconnected) return;
    disconnected = true;
    for (const listener of disconnectListeners) listener();
  };
  socket.addEventListener('message', onMessage);
  socket.addEventListener('close', onClose);
  socket.addEventListener('error', onClose);

  return {
    post(message) {
      if (disconnected) throw new Error('Socket transport disconnected');
      socket.send(encodeWireJson(message));
    },
    onMessage(cb): Unsubscribe {
      messageListeners.add(cb);
      return () => messageListeners.delete(cb);
    },
    onDisconnect(cb): Unsubscribe {
      disconnectListeners.add(cb);
      return () => disconnectListeners.delete(cb);
    },
    close() {
      socket.removeEventListener('message', onMessage);
      socket.removeEventListener('close', onClose);
      socket.removeEventListener('error', onClose);
      onClose();
      messageListeners.clear();
      disconnectListeners.clear();
      socket.close();
    },
  };
}

const TAG = '\u0000wire';

type Tagged =
  | { [TAG]: 'bytes'; data: string }
  | { [TAG]: 'buffer'; data: string }
  | { [TAG]: 'date'; value: number }
  | { [TAG]: 'map'; entries: unknown[] }
  | { [TAG]: 'set'; values: unknown[] }
  | { [TAG]: 'bigint'; value: string }
  | { [TAG]: 'undefined' };

/** JSON that also carries bytes, dates, maps, sets, bigints and `undefined`. */
export function encodeWireJson(value: unknown): string {
  return JSON.stringify(toJson(value));
}

export function decodeWireJson(text: string): unknown {
  return fromJson(JSON.parse(text));
}

function toJson(value: unknown): unknown {
  if (value === undefined) return { [TAG]: 'undefined' } satisfies Tagged;
  if (value === null || typeof value !== 'object') {
    return typeof value === 'bigint'
      ? ({ [TAG]: 'bigint', value: String(value) } satisfies Tagged)
      : value;
  }
  if (value instanceof Uint8Array)
    return { [TAG]: 'bytes', data: toBase64(value) } satisfies Tagged;
  if (value instanceof ArrayBuffer) {
    return { [TAG]: 'buffer', data: toBase64(new Uint8Array(value)) } satisfies Tagged;
  }
  if (ArrayBuffer.isView(value)) {
    const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    return { [TAG]: 'bytes', data: toBase64(bytes) } satisfies Tagged;
  }
  if (value instanceof Date) return { [TAG]: 'date', value: value.getTime() } satisfies Tagged;
  if (value instanceof Map) {
    return {
      [TAG]: 'map',
      entries: [...value].map(([k, v]) => [toJson(k), toJson(v)]),
    } satisfies Tagged;
  }
  if (value instanceof Set)
    return { [TAG]: 'set', values: [...value].map(toJson) } satisfies Tagged;
  if (Array.isArray(value)) return value.map(toJson);
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    // Structured clone keeps own `undefined` properties; JSON would drop them, which is what
    // optional fields expect anyway.
    if (entry !== undefined) out[key] = toJson(entry);
  }
  return out;
}

function fromJson(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(fromJson);
  const record = value as Record<string, unknown>;
  const tag = record[TAG];
  if (typeof tag === 'string') {
    const tagged = record as Tagged;
    switch (tagged[TAG]) {
      case 'undefined':
        return undefined;
      case 'bytes':
        return fromBase64(tagged.data);
      case 'buffer':
        return fromBase64(tagged.data).buffer;
      case 'date':
        return new Date(tagged.value);
      case 'map':
        return new Map(
          tagged.entries.map((entry) => {
            const [k, v] = entry as [unknown, unknown];
            return [fromJson(k), fromJson(v)];
          })
        );
      case 'set':
        return new Set(tagged.values.map(fromJson));
      case 'bigint':
        return BigInt(tagged.value);
    }
  }
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record)) out[key] = fromJson(entry);
  return out;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function fromBase64(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
