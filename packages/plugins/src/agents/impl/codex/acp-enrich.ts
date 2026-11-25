import type { SessionUpdate } from '@agentclientprotocol/sdk';
import type { EnrichHook } from '@emdash/core/runtimes/acp/api';

/**
 * codex-acp brackets every turn, including ones Codex starts itself (such as `/goal`
 * continuations), with `session_info_update` carrying `_meta.codex.threadStatus`.
 */
function isThreadIdle(raw: SessionUpdate): boolean {
  if (raw.sessionUpdate !== 'session_info_update') return false;
  const meta = raw._meta as { codex?: { threadStatus?: { type?: unknown } } } | null | undefined;
  return meta?.codex?.threadStatus?.type === 'idle';
}

/** codex-acp represents startup diagnostics as synthetic failed tool calls. */
export const enrichCodexUpdate: EnrichHook = (event, raw) => {
  if (event.kind === 'ignored' && isThreadIdle(raw)) return { kind: 'agent_turn_end' };
  if (
    event.kind !== 'tool_call' ||
    event.status !== 'failed' ||
    event.toolKind !== 'other' ||
    event.parentToolCallId !== null ||
    !event.toolCallId.startsWith('mcp_startup.')
  )
    return event;

  let server: string;
  try {
    server = decodeURIComponent(event.toolCallId.slice('mcp_startup.'.length));
  } catch {
    return event;
  }
  if (!server || event.title !== `mcp__${server}__startup`) return event;
  const error =
    raw.sessionUpdate === 'tool_call'
      ? raw.content
          ?.flatMap((entry) =>
            entry.type === 'content' && entry.content.type === 'text' ? [entry.content.text] : []
          )
          .join('\n')
      : undefined;
  return {
    kind: 'mcp_startup_failure',
    server,
    error: error || 'MCP server failed to start.',
  };
};
