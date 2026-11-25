import { SEGMENTERS } from '@components/engine/unit-registry';
import type { TurnGroupData } from '@components/rows/turn-group/turn-group.def';
import type { SegmentCtx } from '@core/units';
import { flattenTier } from '@state/flatten';
import { afterEach, describe, expect, it } from 'vitest';
import { createChatContext } from '@/chat-context';
import { createChatView } from '@/chat-view';
import type { ChatItem, CollapsedTurn, TranscriptTurn } from '@/model';
import { createChatState } from '@/state/chat-state';

const message = (id: string, role: 'user' | 'assistant', text: string): ChatItem =>
  ({ kind: 'message', id, seq: 0, role, text }) as ChatItem;

const mcpCall = (id: string): ChatItem =>
  ({
    kind: 'mcp-tool-call',
    id,
    toolCallId: id,
    seq: 0,
    status: 'done',
    server: 'emjosh',
    tool: 'post_message',
  }) as unknown as ChatItem;

const turn = (id: string, ...items: ChatItem[]): TranscriptTurn => ({
  id,
  seq: 0,
  initiator: 'user',
  items: items as TranscriptTurn['items'],
});

/** Collapses turns whose prompt starts with "[bg]", keeping the last assistant message visible. */
const collapseTurn = (t: TranscriptTurn): CollapsedTurn | null => {
  const first = t.items[0];
  if (first?.kind !== 'message' || !first.text.startsWith('[bg]')) return null;
  const last = [...t.items].reverse().find((i) => i.kind === 'message' && i.role === 'assistant');
  return { label: 'Background (1)', visibleItemId: last?.id ?? null };
};

const ctx = (active = false) =>
  ({
    caches: {},
    expanded: () => false,
    active,
    plan: () => null,
    pendingToolCallIds: () => new Set<string>(),
    terminalOutput: () => null,
    collapseTurn,
  }) as unknown as SegmentCtx;

describe('collapsed turns', () => {
  const turns = [
    turn('t1', message('u1', 'user', 'Please plan it')),
    turn(
      't2',
      message('d1', 'user', '[bg] update\n\n— Workspace "API" · done\nShipped.'),
      message('a1', 'assistant', 'Checking.'),
      mcpCall('c1'),
      message('a2', 'assistant', 'API is done; ready for you to review.')
    ),
  ];

  it('folds a background turn into one group, keeping its final reply visible', () => {
    const units = flattenTier(turns, ctx(), SEGMENTERS);
    expect(units.map((u) => [u.kind, u.itemId])).toEqual([
      ['message', 'u1'],
      ['turn-group', 't2:turn-group'],
      ['message', 'a2'],
    ]);
    const group = units[1]!.data as TurnGroupData;
    expect(group.label).toBe('Background (1)');
    expect(group.lines).toEqual([
      { text: '[bg] update', tone: 'prompt' },
      { text: '— Workspace "API" · done', tone: 'prompt' },
      { text: 'Shipped.', tone: 'prompt' },
      { text: 'Checking.', tone: 'assistant' },
      { text: 'MCP emjosh.post_message', tone: 'tool' },
    ]);
  });

  it('folds everything when the host keeps nothing visible', () => {
    const quiet: CollapsedTurn = { label: 'Background (1)', visibleItemId: null };
    const units = flattenTier(
      [turns[1]!],
      { ...ctx(true), collapseTurn: () => quiet } as SegmentCtx,
      SEGMENTERS
    );
    expect(units.map((u) => u.kind)).toEqual(['turn-group']);
    expect((units[0]!.data as TurnGroupData).active).toBe(true);
  });

  it('leaves turns alone without the hook', () => {
    const units = flattenTier(turns, { ...ctx(), collapseTurn: undefined }, SEGMENTERS);
    expect(units.map((u) => u.itemId)).toEqual(['u1', 'd1', 'a1', 'c1', 'a2']);
  });
});

const nextPaint = (): Promise<void> =>
  new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

describe('collapsed turn row', () => {
  it('shows only its label and the visible reply until expanded', async () => {
    const context = createChatContext();
    const state = createChatState(context);
    state.transcript.history.seed([
      turn(
        't2',
        message('d1', 'user', '[bg] update\n\nShipped the endpoint.'),
        mcpCall('c1'),
        message('a2', 'assistant', 'API is done.')
      ),
    ]);
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;top:0;left:0;width:800px;height:400px;';
    document.body.appendChild(host);
    const view = createChatView({ context, state, parent: host, collapseTurn });
    cleanups.push(() => {
      view.dispose();
      state.dispose();
      context.dispose();
      host.remove();
    });
    await nextPaint();

    const header = host.querySelector<HTMLElement>('[data-collapse-id="t2:turn-group"]');
    expect(header?.textContent).toContain('Background (1)');
    expect(header?.getAttribute('aria-expanded')).toBe('false');
    expect(host.textContent).toContain('API is done.');
    expect(host.textContent).not.toContain('Shipped the endpoint.');

    header?.click();
    await nextPaint();
    expect(header?.getAttribute('aria-expanded')).toBe('true');
    expect(host.textContent).toContain('Shipped the endpoint.');
    expect(host.textContent).toContain('MCP emjosh.post_message');
  });
});
