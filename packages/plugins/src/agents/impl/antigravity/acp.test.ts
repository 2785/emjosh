import type {
  Client,
  InitializeResponse,
  RequestPermissionRequest,
  SessionNotification,
} from '@agentclientprotocol/sdk';
import type { AcpAgentApi } from '@emdash/core/services/agent-plugins/api/plugins';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pluginRegistry } from '../../registry';
import {
  isAntigravitySessionNotFound,
  TURN_END_META_KEY,
  TURN_END_HOLD_MS,
  withHttpMcp,
  withTurnEndMarkers,
} from './acp';
import { enrichAntigravityUpdate } from './acp-enrich';

const acpBehavior = () => pluginRegistry.get('antigravity')!.behavior.acp!;

describe('antigravity acp behavior', () => {
  it('declares ACP support and spawns `agy acp` on the resolved binary', () => {
    expect(pluginRegistry.get('antigravity')!.capabilities.acp.kind).toBe('supported');
    expect(
      acpBehavior().buildSpawn({ cwd: '/work', env: {}, cli: '/Users/me/.local/bin/agy' })
    ).toEqual({ command: '/Users/me/.local/bin/agy', args: ['acp'], env: undefined });
  });

  it('marks agent-initiated turn ends through its enrich hook', () => {
    expect(acpBehavior().enrich).toBe(enrichAntigravityUpdate);
    expect(acpBehavior().reportsAgentTurnEnd).toBe(true);
  });

  it('recognizes agy session/load not-found errors only for the requested session', () => {
    const missing = { code: -32002, message: 'Session not found: saved' };
    expect(isAntigravitySessionNotFound(missing, 'saved')).toBe(true);
    expect(isAntigravitySessionNotFound(missing, 'other')).toBe(false);
    expect(isAntigravitySessionNotFound({ code: -32603, message: missing.message }, 'saved')).toBe(
      false
    );
    expect(acpBehavior().isSessionNotFound).toBe(isAntigravitySessionNotFound);
  });
});

describe('withHttpMcp', () => {
  const initialized: InitializeResponse = {
    protocolVersion: 1,
    agentCapabilities: { loadSession: true, promptCapabilities: { image: true } },
  };

  it('advertises HTTP MCP support and keeps the rest of the initialize response', async () => {
    const agent = withHttpMcp(fakeAgent(initialized));
    const response = await agent.initialize({ protocolVersion: 1 });
    expect(response.agentCapabilities).toEqual({
      loadSession: true,
      promptCapabilities: { image: true },
      mcpCapabilities: { http: true },
    });
  });

  it('forwards other methods to the wrapped agent and preserves optional ones', async () => {
    const inner = fakeAgent(initialized);
    const agent = withHttpMcp(inner);
    await agent.cancel({ sessionId: 's' });
    expect(inner.cancel).toHaveBeenCalledWith({ sessionId: 's' });
    expect(agent.loadSession).toBeDefined();
    expect(agent.extMethod).toBeUndefined();
  });
});

describe('withTurnEndMarkers', () => {
  let received: SessionNotification[];
  let client: Client;

  beforeEach(() => {
    vi.useFakeTimers();
    received = [];
    const inner = {
      sessionUpdate: vi.fn(async (notification: SessionNotification) => {
        received.push(notification);
      }),
      requestPermission: vi.fn(async (_params: RequestPermissionRequest) => ({
        outcome: { outcome: 'cancelled' as const },
      })),
    } as unknown as Client;
    client = withTurnEndMarkers(inner);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const usage = (sessionId = 's'): SessionNotification => ({
    sessionId,
    update: { sessionUpdate: 'usage_update', used: 100, size: 1000 },
  });
  const message = (sessionId = 's'): SessionNotification => ({
    sessionId,
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } },
  });
  const marked = (notification: SessionNotification | undefined) =>
    (notification?.update._meta as Record<string, unknown> | undefined)?.[TURN_END_META_KEY] ===
    true;

  it('marks a usage update that nothing follows as the end of a turn', async () => {
    await client.sessionUpdate(message());
    await client.sessionUpdate(usage());
    expect(received).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(TURN_END_HOLD_MS);

    expect(received).toHaveLength(2);
    expect(received[1]!.update.sessionUpdate).toBe('usage_update');
    expect(marked(received[1])).toBe(true);
  });

  it('forwards a usage update unmarked, in order, when the model call continues', async () => {
    await client.sessionUpdate(usage());
    await client.sessionUpdate({
      sessionId: 's',
      update: { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'ls' },
    });
    await vi.advanceTimersByTimeAsync(TURN_END_HOLD_MS);

    expect(received.map((n) => n.update.sessionUpdate)).toEqual(['usage_update', 'tool_call']);
    expect(marked(received[0])).toBe(false);
  });

  it('releases a held usage update before a permission request', async () => {
    await client.sessionUpdate(usage());
    await client.requestPermission({
      sessionId: 's',
      toolCall: { toolCallId: 't1' },
      options: [],
    });
    expect(received).toHaveLength(1);
    expect(marked(received[0])).toBe(false);
  });

  it('holds usage per session', async () => {
    await client.sessionUpdate(usage('a'));
    await client.sessionUpdate(message('b'));
    await vi.advanceTimersByTimeAsync(TURN_END_HOLD_MS);

    expect(received.map((n) => [n.sessionId, n.update.sessionUpdate, marked(n)])).toEqual([
      ['b', 'agent_message_chunk', false],
      ['a', 'usage_update', true],
    ]);
  });
});

describe('enrichAntigravityUpdate', () => {
  const event = {
    kind: 'usage' as const,
    usage: { contextSize: 1000, contextUsed: 100, cost: null },
  };

  it('ends the agent turn on a marked usage update', () => {
    expect(
      enrichAntigravityUpdate(event, {
        sessionUpdate: 'usage_update',
        used: 100,
        size: 1000,
        _meta: { [TURN_END_META_KEY]: true },
      })
    ).toEqual({ ...event, endsAgentTurn: true });
  });

  it('leaves unmarked usage updates alone', () => {
    expect(
      enrichAntigravityUpdate(event, { sessionUpdate: 'usage_update', used: 100, size: 1000 })
    ).toBe(event);
  });
});

function fakeAgent(initialized: InitializeResponse): AcpAgentApi {
  return {
    initialize: vi.fn(async () => initialized),
    newSession: vi.fn(),
    loadSession: vi.fn(),
    prompt: vi.fn(),
    cancel: vi.fn(async () => {}),
  };
}
