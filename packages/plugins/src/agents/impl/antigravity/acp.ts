import type { Client, SessionNotification } from '@agentclientprotocol/sdk';
import type { AcpAgentApi, IAcpBehavior } from '@emdash/core/services/agent-plugins/api/plugins';
import { connectStdioAcp } from '../../helpers/acp-stdio';
import { override } from './override';
import { withPermissionModes } from './permissions';

/** `_meta` key on a `usage_update` that closed a turn; read by `enrichAntigravityUpdate`. */
export const TURN_END_META_KEY = 'emdash/antigravityTurnEnd';

/**
 * How long a `usage_update` waits for a following update before it counts as a turn end. agy
 * sends one after every model call, and a model call that requests a tool sends its `tool_call`
 * immediately afterwards.
 */
export const TURN_END_HOLD_MS = 1_500;

/**
 * `agy acp` on the resolved binary. The host's MCP instructions arrive with the spawn context but
 * are needed on the connection; they are the same for every session on the host, so the latest
 * value is kept for the next sessions.
 */
export function createAntigravityAcpBehavior(): Pick<IAcpBehavior, 'buildSpawn' | 'connect'> {
  let instructions: string | undefined;
  return {
    buildSpawn: (ctx) => {
      instructions = ctx.controlInstructions;
      return { command: ctx.cli, args: ['acp'] };
    },
    connect: (io, toClient) =>
      withSessionSetup(
        withPermissionModes((wrapClient) =>
          connectStdioAcp(io, (agent) => wrapClient(withTurnEndMarkers(toClient(agent))))
        ),
        () => instructions
      ),
  };
}

/**
 * - agy accepts HTTP MCP servers in session/new and session/load but does not advertise
 *   `mcpCapabilities.http`; without it the runtime would drop HTTP servers such as `emjosh`.
 * - agy doesn't show MCP server instructions to the model, so the host's go into the system
 *   prompt through agy's `_meta.antigravity.systemPrompt.append` on session/new and session/load.
 */
export function withSessionSetup(
  agent: AcpAgentApi,
  instructions: () => string | undefined
): AcpAgentApi {
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
  const withInstructions = <T extends { _meta?: Record<string, unknown> | null }>(params: T): T => {
    const append = instructions();
    if (!append) return params;
    const antigravity = (params._meta?.antigravity ?? {}) as Record<string, unknown>;
    const systemPrompt = (antigravity.systemPrompt ?? {}) as Record<string, unknown>;
    return {
      ...params,
      _meta: {
        ...params._meta,
        antigravity: { ...antigravity, systemPrompt: { ...systemPrompt, append } },
      },
    };
  };
  const loadSession = agent.loadSession?.bind(agent);
  return override(agent, {
    initialize,
    newSession: (params) => agent.newSession(withInstructions(params)),
    ...(loadSession && { loadSession: (params) => loadSession(withInstructions(params)) }),
  });
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
