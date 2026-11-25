import { Readable, Writable } from 'node:stream';
import { type AnyMessage, ClientSideConnection, ndJsonStream } from '@agentclientprotocol/sdk';
import type {
  AcpAgentApi,
  AcpClientFactory,
  AcpProcessIo,
  AcpSpawnContext,
  AcpSpawnResult,
  IAcpBehavior,
} from '@emdash/core/services/agent-plugins/api/plugins';

type NativeAcpSpawnResult = Omit<AcpSpawnResult, 'command'> & {
  command?: string;
};

/**
 * `mapIncoming` rewrites (or, returning null, drops) each message from the agent before the SDK
 * validates it, for provider extensions the SDK would otherwise reject.
 */
export function connectStdioAcp(
  io: AcpProcessIo,
  toClient: AcpClientFactory,
  mapIncoming?: (message: AnyMessage) => AnyMessage | null
): AcpAgentApi {
  const stream = ndJsonStream(
    Writable.toWeb(io.stdin) as WritableStream<Uint8Array>,
    Readable.toWeb(io.stdout) as unknown as ReadableStream<Uint8Array>
  );
  const readable = mapIncoming
    ? stream.readable.pipeThrough(
        new TransformStream<AnyMessage, AnyMessage>({
          transform(message, controller) {
            const mapped = mapIncoming(message);
            if (mapped) controller.enqueue(mapped);
          },
        })
      )
    : stream.readable;
  return new ClientSideConnection((agent) => toClient(agent as never), {
    writable: stream.writable,
    readable,
  });
}

export function createNativeAcpBehavior(
  buildSpawn: (ctx: AcpSpawnContext) => NativeAcpSpawnResult
): IAcpBehavior {
  return {
    buildSpawn: (ctx) => {
      const spawn = buildSpawn(ctx);
      return {
        command: spawn.command ?? ctx.cli,
        args: spawn.args,
        env: spawn.env,
      };
    },
    connect: connectStdioAcp,
  };
}
