import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isOk } from '@emdash/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TranscriptTurn } from '#runtimes/acp/api/models/turns/turn';
import { makeAcpHarness, makeStartInput } from '#runtimes/acp/node/acp-test-support';
import {
  type AcpHistoryCache,
  type CachedAcpHistory,
  cachedHistoryPage,
  createFileHistoryCache,
} from './history-cache';
import { AcpRuntime } from './runtime';

const turn = (seq: number) =>
  ({
    id: `turn-${seq}`,
    seq,
    initiator: 'user',
    items: [],
    outcome: { kind: 'done', reason: 'end_turn' },
  }) as unknown as TranscriptTurn;

function memoryCache(): AcpHistoryCache & { entries: Map<string, CachedAcpHistory> } {
  const entries = new Map<string, CachedAcpHistory>();
  return {
    entries,
    read: async (id) => entries.get(id) ?? null,
    write: vi.fn(async (id: string, history: CachedAcpHistory) => {
      entries.set(id, history);
    }),
    remove: vi.fn(async (id: string) => {
      entries.delete(id);
    }),
  };
}

describe('ACP history cache', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('round-trips a conversation history through a file and removes it', async () => {
    dir = mkdtempSync(join(tmpdir(), 'acp-history-'));
    const cache = createFileHistoryCache(join(dir, 'nested'));
    const history = { savedAt: 5, turns: [turn(0), turn(1)] };

    expect(await cache.read('conv/1')).toBeNull();
    await cache.write('conv/1', history);
    expect(await cache.read('conv/1')).toEqual(history);
    await cache.remove('conv/1');
    expect(await cache.read('conv/1')).toBeNull();
  });

  it('serves the latest cached turns as a page with its own generation', () => {
    const page = cachedHistoryPage('conv-1', { savedAt: 7, turns: [0, 1, 2].map(turn) }, 2);
    expect(page).toEqual({
      kind: 'available',
      turns: [turn(1), turn(2)],
      nextCursor: null,
      position: { generation: 'cache:conv-1:7', historyRevision: 0, lastCommittedTurnSeq: 2 },
      coverage: { fromSeq: null, beforeSeq: null },
    });
  });

  it('stands in for history before the session starts, and forgets it when killed', async () => {
    const historyCache = memoryCache();
    historyCache.entries.set('conv-1', { savedAt: 1, turns: [turn(0)] });
    const h = makeAcpHarness({ historyCache });
    const rt = new AcpRuntime(h.deps);

    const page = await rt.loadCachedHistory('conv-1', 100);
    expect(isOk(page) && page.data.kind === 'available' && page.data.turns).toEqual([turn(0)]);

    await rt.terminateSession('conv-1');
    expect(historyCache.remove).toHaveBeenCalledWith('conv-1');
    await rt.dispose();
  });

  it('caches the settled history after a turn', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const historyCache = memoryCache();
      const h = makeAcpHarness({ historyCache });
      h.agent.prompt.mockResolvedValue({ stopReason: 'end_turn' });
      const rt = new AcpRuntime(h.deps);
      expect(isOk(await rt.startSession(makeStartInput(), 'resume'))).toBe(true);

      await rt.sendPrompt('conv-1', { text: 'hello' });
      await vi.waitFor(() => expect(rt.getSessionState('conv-1').lifecycle).toBe('ready'));
      await vi.advanceTimersByTimeAsync(2_500);

      await vi.waitFor(() => expect(historyCache.write).toHaveBeenCalled());
      expect(historyCache.entries.get('conv-1')?.turns).toHaveLength(1);
      await rt.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
