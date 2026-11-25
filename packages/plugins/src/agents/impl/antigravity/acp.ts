import type { Client, SessionNotification } from '@agentclientprotocol/sdk';
import type {
  AcpAgentApi,
  AcpClientFactory,
  AcpProcessIo,
} from '@emdash/core/services/agent-plugins/api/plugins';
import { connectStdioAcp } from '../../helpers/acp-stdio';

/** `_meta` key on a `usage_update` that closed a turn; read by `enrichAntigravityUpdate`. */
export const TURN_END_META_KEY = 'emdash/antigravityTurnEnd';

/**
 * How long a `usage_update` waits for a following update before it counts as a turn end. agy
 * sends one after every model call, and a model call that requests a tool sends its `tool_call`
 * immediately afterwards.
 */
export const TURN_END_HOLD_MS = 1_500;

export function connectAntigravityAcp(io: AcpProcessIo, toClient: AcpClientFactory): AcpAgentApi {
  return withHttpMcp(connectStdioAcp(io, (agent) => withTurnEndMarkers(toClient(agent))));
}

/**
 * `agy acp` accepts HTTP MCP servers in session/new and session/load but does not advertise
 * `mcpCapabilities.http`; without this the runtime would drop HTTP servers such as `emjosh`.
 */
export function withHttpMcp(agent: AcpAgentApi): AcpAgentApi {
  const initialize: AcpAgentApi['initialize'] = async (params) => {
    const response = await agent.initialize(params);
    const capabilities = response.agentCapabilities ?? {};
    return {
      ...response,
      agentCapabilities: {
        ...capabilities,
        mcpCapabilities: { ...capabilities.mcpCapabilities, http: true },
      },
    };
  };
  return override(agent, { initialize });
}

/**
 * Turns agy starts on its own (a daemon task or timer waking it after `end_turn`) carry no end
 * marker. The last update of every agy turn is the `usage_update` of its final model call, so a
 * `usage_update` that nothing follows within TURN_END_HOLD_MS is forwarded marked as a turn end.
 * Order is preserved: a held update is forwarded before anything that arrives after it.
 */
export function withTurnEndMarkers(
  client: Client,
  holdMs: number = TURN_END_HOLD_MS,
  timers: Pick<typeof globalThis, 'setTimeout' | 'clearTimeout'> = globalThis
): Client {
  const held = new Map<
    string,
    { notification: SessionNotification; timer: ReturnType<typeof setTimeout> }
  >();

  const flush = async (sessionId: string, marked: boolean) => {
    const entry = held.get(sessionId);
    if (!entry) return;
    held.delete(sessionId);
    timers.clearTimeout(entry.timer);
    const { notification } = entry;
    await client.sessionUpdate(
      marked
        ? {
            ...notification,
            update: {
              ...notification.update,
              _meta: { ...notification.update._meta, [TURN_END_META_KEY]: true },
            },
          }
        : notification
    );
  };

  const sessionUpdate: Client['sessionUpdate'] = async (notification) => {
    const { sessionId } = notification;
    await flush(sessionId, false);
    if (notification.update.sessionUpdate !== 'usage_update') {
      await client.sessionUpdate(notification);
      return;
    }
    const timer = timers.setTimeout(() => {
      void flush(sessionId, true);
    }, holdMs);
    held.set(sessionId, { notification, timer });
  };

  const requestPermission: Client['requestPermission'] = async (params) => {
    await flush(params.sessionId, false);
    return client.requestPermission(params);
  };

  return override(client, { sessionUpdate, requestPermission });
}

/** agy answers session/load for an unknown id with `-32002 Session not found: <id>` and no data. */
export function isAntigravitySessionNotFound(error: unknown, sessionId: string): boolean {
  if (!error || typeof error !== 'object') return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  return code === -32002 && message === `Session not found: ${sessionId}`;
}

/** Replaces some methods while keeping the rest bound to the original (which may be a class). */
function override<T extends object>(target: T, replacements: Partial<T>): T {
  return new Proxy(target, {
    get(object, property, receiver) {
      if (Object.hasOwn(replacements, property)) {
        return replacements[property as keyof T];
      }
      const value: unknown = Reflect.get(object, property, receiver);
      return typeof value === 'function' ? value.bind(object) : value;
    },
    has(object, property) {
      return Object.hasOwn(replacements, property) || Reflect.has(object, property);
    },
  });
}
