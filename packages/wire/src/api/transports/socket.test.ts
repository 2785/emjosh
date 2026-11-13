import { describe, expect, it } from 'vitest';
import { connect } from '../connect';
import { serve } from '../serve';
import { decodeWireJson, encodeWireJson, socketTransport, type SocketLike } from './socket';

/** Two in-memory sockets wired to each other, delivering asynchronously like a real socket. */
function socketPair(): [SocketLike, SocketLike] {
  const make = () => {
    const listeners = new Map<string, Set<(event: { data: unknown }) => void>>();
    const socket = {
      peer: undefined as unknown as { emit(type: string, event: { data: unknown }): void },
      emit(type: string, event: { data: unknown }) {
        for (const listener of listeners.get(type) ?? []) listener(event);
      },
      send(data: string) {
        queueMicrotask(() => socket.peer.emit('message', { data }));
      },
      close() {
        socket.emit('close', { data: null });
        socket.peer.emit('close', { data: null });
      },
      addEventListener(type: string, listener: (event: { data: unknown }) => void) {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type)!.add(listener);
      },
      removeEventListener(type: string, listener: (...args: never[]) => void) {
        listeners.get(type)?.delete(listener as never);
      },
    };
    return socket;
  };
  const a = make();
  const b = make();
  a.peer = b;
  b.peer = a;
  return [a as unknown as SocketLike, b as unknown as SocketLike];
}

describe('socket transport', () => {
  it('round-trips values JSON alone would lose', () => {
    const value = {
      bytes: new Uint8Array([0, 1, 255]),
      when: new Date(1_700_000_000_000),
      map: new Map([['a', 1]]),
      set: new Set(['x']),
      big: 10n,
      list: [1, undefined, 'three'],
      nested: { keep: 'yes', drop: undefined },
    };
    expect(decodeWireJson(encodeWireJson(value))).toEqual({
      ...value,
      nested: { keep: 'yes' },
    });
  });

  it('carries wire calls between a client and a served controller', async () => {
    const [clientSocket, serverSocket] = socketPair();
    const stop = serve(socketTransport(serverSocket), {
      call: async (path: string, input: unknown) => ({
        success: true,
        data: { path, echo: input },
      }),
      resolveLive: () => {
        throw new Error('no live topics');
      },
      acquireLive: () => {
        throw new Error('no live topics');
      },
    } as never);
    const connection = connect(socketTransport(clientSocket));

    const result = await connection.call('demo.echo', { bytes: new Uint8Array([7]) });

    expect(result).toEqual({
      success: true,
      data: { path: 'demo.echo', echo: { bytes: new Uint8Array([7]) } },
    });
    stop();
  });
});
