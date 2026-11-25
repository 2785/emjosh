import type { SessionUpdate } from '@agentclientprotocol/sdk';
import { decodeSessionUpdate } from '@emdash/core/runtimes/acp/api';
import { describe, expect, it } from 'vitest';
import { enrichCodexUpdate } from './acp-enrich';

const startupFailure = (server: string): SessionUpdate => ({
  sessionUpdate: 'tool_call',
  toolCallId: `mcp_startup.${encodeURIComponent(server)}`,
  title: `mcp__${server}__startup`,
  kind: 'other',
  status: 'failed',
  content: [{ type: 'content', content: { type: 'text', text: 'Connection refused' } }],
});

describe('Codex MCP startup diagnostics', () => {
  it('extracts the server identity without parsing diagnostic prose', () => {
    const raw = startupFailure('docs / team_ä');
    expect(enrichCodexUpdate(decodeSessionUpdate(raw), raw)).toEqual({
      kind: 'mcp_startup_failure',
      server: 'docs / team_ä',
      error: 'Connection refused',
    });
  });

  it.each([
    { toolCallId: 'ordinary-tool-call' },
    { toolCallId: 'mcp_startup.%ZZ' },
    { title: 'mcp__docs__search' },
    { status: 'completed' as const },
    { kind: 'execute' as const },
  ])('preserves nonmatching events: %j', (overrides) => {
    const raw = { ...startupFailure('docs'), ...overrides } as SessionUpdate;
    const decoded = decodeSessionUpdate(raw);
    expect(enrichCodexUpdate(decoded, raw)).toBe(decoded);
  });
});

describe('Codex turn markers', () => {
  const threadStatus = (status: Record<string, unknown>): SessionUpdate =>
    ({
      sessionUpdate: 'session_info_update',
      _meta: { codex: { threadStatus: status } },
    }) as SessionUpdate;

  it('marks the end of a turn when the thread goes idle', () => {
    const raw = threadStatus({ type: 'idle' });
    expect(enrichCodexUpdate(decodeSessionUpdate(raw), raw)).toEqual({ kind: 'agent_turn_end' });
  });

  it.each([
    threadStatus({ type: 'active', activeFlags: [] }),
    threadStatus({ type: 'active', activeFlags: ['waitingOnApproval'] }),
    { sessionUpdate: 'session_info_update', title: 'Renamed' } as SessionUpdate,
  ])('passes other session info through: %j', (raw) => {
    const decoded = decodeSessionUpdate(raw);
    expect(enrichCodexUpdate(decoded, raw)).toBe(decoded);
  });
});
