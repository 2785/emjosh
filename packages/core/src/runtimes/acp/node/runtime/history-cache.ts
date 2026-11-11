import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { HistoryPage } from '#runtimes/acp/api';
import type { TranscriptTurn } from '#runtimes/acp/api/models/turns/turn';

/**
 * The latest committed turns of a conversation, kept across session restarts so its chat can
 * show history at once while the session starts (which replays the whole conversation).
 */
export type CachedAcpHistory = {
  savedAt: number;
  turns: TranscriptTurn[];
};

export type AcpHistoryCache = {
  read(conversationId: string): Promise<CachedAcpHistory | null>;
  write(conversationId: string, history: CachedAcpHistory): Promise<void>;
  remove(conversationId: string): Promise<void>;
};

/** Turns kept per conversation: the chat's first page. */
export const CACHED_HISTORY_TURNS = 100;

/** One JSON file per conversation under `dir`. */
export function createFileHistoryCache(dir: string): AcpHistoryCache {
  const file = (conversationId: string) =>
    join(dir, `${conversationId.replace(/[^\w-]/g, '_')}.json`);
  return {
    async read(conversationId) {
      try {
        const parsed = JSON.parse(await readFile(file(conversationId), 'utf8')) as CachedAcpHistory;
        return Array.isArray(parsed.turns) && typeof parsed.savedAt === 'number' ? parsed : null;
      } catch {
        return null;
      }
    },
    async write(conversationId, history) {
      await mkdir(dir, { recursive: true });
      const target = file(conversationId);
      const temporary = `${target}.${process.pid}.tmp`;
      await writeFile(temporary, JSON.stringify(history));
      await rename(temporary, target);
    },
    async remove(conversationId) {
      await rm(file(conversationId), { force: true });
    },
  };
}

/**
 * Cached turns as a history page. Its own transcript generation tells the chat it is a
 * stand-in: the live session's history replaces it once replay finishes.
 */
export function cachedHistoryPage(
  conversationId: string,
  cached: CachedAcpHistory,
  limit: number
): HistoryPage {
  const turns = cached.turns.slice(-limit);
  return {
    kind: 'available',
    turns,
    nextCursor: null,
    position: {
      generation: `cache:${conversationId}:${cached.savedAt}`,
      historyRevision: 0,
      lastCommittedTurnSeq: turns.at(-1)?.seq ?? null,
    },
    coverage: { fromSeq: null, beforeSeq: null },
  };
}
