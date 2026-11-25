import type { SessionUpdate } from '@agentclientprotocol/sdk';
import type { EnrichHook, NormalizedEvent } from '@emdash/core/runtimes/acp/api';

type CodexSessionInfoMeta = {
  codex?: { threadStatus?: { type?: unknown } };
  goal?: { status?: unknown } | null;
};

function sessionInfoMeta(raw: SessionUpdate): CodexSessionInfoMeta | null {
  if (raw.sessionUpdate !== 'session_info_update') return null;
  return (raw._meta as CodexSessionInfoMeta | null | undefined) ?? null;
}

/**
 * Turn markers. codex-acp brackets every turn, including ones Codex starts itself, with
 * `_meta.codex.threadStatus`. An active goal (`/goal`) runs as a series of turns Codex starts
 * after each other, ending when the goal stops being active.
 */
function codexTurnMarker(raw: SessionUpdate): NormalizedEvent | null {
  const meta = sessionInfoMeta(raw);
  if (!meta) return null;
  if ('goal' in meta)
    return { kind: 'agent_work_pending', pending: meta.goal?.status === 'active' };
  if (meta.codex?.threadStatus?.type === 'idle') return { kind: 'agent_turn_end' };
  return null;
}

/** Turn markers, and MCP startup diagnostics (which codex-acp sends as failed tool calls). */
export const enrichCodexUpdate: EnrichHook = (event, raw) => {
  if (event.kind === 'ignored') return codexTurnMarker(raw) ?? event;
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
