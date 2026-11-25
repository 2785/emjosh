import type { Result, Unsubscribe } from '@emdash/shared';
import type { Logger } from '@emdash/shared/logger';
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import {
  conversationRegistryTable as conversations,
  liveConversations,
} from '@core/features/conversations/api/node/registry';
import type { ProjectAttachmentManager } from '@core/features/projects/api/node/project-attachment-manager';
import { PRODUCT_NAME } from '@core/primitives/app-identity/api/app-identity';
import type { AppDb } from '@core/services/app-db/node/db';
import { kv } from '@core/services/app-db/node/schema';

/** KV key holding the ids of conversations still owed a "keep going" message. */
export const INTERRUPTED_TURNS_KEY = 'interrupted-turns:pending';

export const INTERRUPTED_TURN_PROMPT =
  `[Automatic message: ${PRODUCT_NAME} restarted and interrupted your turn.] ` +
  'Keep going where you left off.';

export async function readInterruptedTurns(db: AppDb): Promise<string[]> {
  const [row] = await db
    .select({ value: kv.value })
    .from(kv)
    .where(eq(kv.key, INTERRUPTED_TURNS_KEY))
    .limit(1);
  if (!row) return [];
  const parsed: unknown = JSON.parse(row.value);
  return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
}

async function writeInterruptedTurns(db: AppDb, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) {
    await db.delete(kv).where(eq(kv.key, INTERRUPTED_TURNS_KEY));
    return;
  }
  const value = JSON.stringify([...new Set(ids)]);
  const now = Date.now();
  await db
    .insert(kv)
    .values({ key: INTERRUPTED_TURNS_KEY, value, updatedAt: now })
    .onConflictDoUpdate({ target: kv.key, set: { value, updatedAt: now } });
}

/**
 * Records the local chat conversations whose agent was still working when the app last stopped
 * (quit, Reload, update install, or crash): the persisted agent status is the live one until
 * shutdown, so a `working` row at boot is a turn the restart cut off. Runs at boot before the
 * stale status repair resets those rows to idle. Remote sessions keep running on their host
 * and are not recorded. Never throws: a failure only means no automatic resume.
 */
export async function recordInterruptedAcpTurns(
  db: AppDb,
  logger: Pick<Logger, 'warn'>
): Promise<void> {
  try {
    const rows = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(
        and(
          liveConversations(),
          eq(conversations.type, 'acp'),
          eq(conversations.location, 'local'),
          eq(conversations.agentStatus, 'working'),
          isNotNull(conversations.taskId)
        )
      );
    if (rows.length === 0) return;
    const pending = await readInterruptedTurns(db).catch(() => []);
    await writeInterruptedTurns(db, [...pending, ...rows.map((row) => row.id)]);
  } catch (error) {
    logger.warn('Failed to record interrupted chat turns', { error: String(error) });
  }
}

export type InterruptedTurnResumerDeps = {
  db: AppDb;
  projects: Pick<ProjectAttachmentManager, 'on' | 'requireAttached'>;
  isEnabled(): Promise<boolean>;
  /** Starts (resumes) the conversation's agent session. */
  start(conversationId: string): Promise<Result<unknown, unknown>>;
  /** Sends a prompt through the normal chat prompt path. */
  send(conversationId: string, text: string): Promise<Result<unknown, unknown>>;
  logger: Pick<Logger, 'warn'>;
};

/**
 * Sends each recorded conversation one "keep going" message once its project is attached and
 * its session resumed. A conversation is dropped from the record before its message is sent,
 * and without a message when the setting is off, the conversation is gone, or it is no longer
 * idle (the user or another sender got to it first).
 */
export function startInterruptedTurnResumer(deps: InterruptedTurnResumerDeps): Unsubscribe {
  const { db, logger } = deps;
  let disposed = false;
  let chain = Promise.resolve();

  const serialize = (work: () => Promise<void>): Promise<void> => {
    chain = chain.then(work).catch((error: unknown) => {
      logger.warn('Resuming interrupted chat turns failed', { error: String(error) });
    });
    return chain;
  };

  const loadPending = async () => {
    const ids = await readInterruptedTurns(db);
    if (ids.length === 0) return { ids, rows: [] };
    const rows = await db
      .select({
        id: conversations.id,
        projectId: conversations.projectId,
        agentStatus: conversations.agentStatus,
      })
      .from(conversations)
      .where(and(inArray(conversations.id, ids), liveConversations()));
    return { ids, rows };
  };

  const isIdle = async (conversationId: string): Promise<boolean> => {
    const [row] = await db
      .select({ agentStatus: conversations.agentStatus })
      .from(conversations)
      .where(and(eq(conversations.id, conversationId), liveConversations()))
      .limit(1);
    return row !== undefined && (row.agentStatus ?? 'idle') === 'idle';
  };

  const resume = async (conversationId: string): Promise<void> => {
    const started = await deps.start(conversationId);
    if (!started.success) {
      logger.warn('Could not resume interrupted chat turn: session did not start', {
        conversationId,
      });
      return;
    }
    if (disposed || !(await isIdle(conversationId))) return;
    const sent = await deps.send(conversationId, INTERRUPTED_TURN_PROMPT);
    if (!sent.success) {
      logger.warn('Could not resume interrupted chat turn: prompt was not sent', {
        conversationId,
      });
    }
  };

  /** Claims the pending conversations of the given projects (all attached ones when omitted). */
  const claim = (projectIds?: ReadonlySet<string>): Promise<string[]> => {
    const claimed: string[] = [];
    return serialize(async () => {
      if (disposed) return;
      const { ids, rows } = await loadPending();
      if (ids.length === 0) return;
      if (!(await deps.isEnabled())) {
        await writeInterruptedTurns(db, []);
        return;
      }
      const byId = new Map(rows.map((row) => [row.id, row]));
      const keep: string[] = [];
      for (const id of ids) {
        const row = byId.get(id);
        // Deleted or unlinked conversations are dropped.
        if (!row?.projectId) continue;
        const inScope = projectIds
          ? projectIds.has(row.projectId)
          : deps.projects.requireAttached(row.projectId).success;
        if (!inScope) keep.push(id);
        else if ((row.agentStatus ?? 'idle') === 'idle') claimed.push(id);
      }
      await writeInterruptedTurns(db, keep);
    }).then(() => claimed);
  };

  const run = (projectIds?: ReadonlySet<string>): void => {
    void claim(projectIds).then((ids) =>
      Promise.all(
        ids.map((id) =>
          resume(id).catch((error: unknown) => {
            logger.warn('Could not resume interrupted chat turn', {
              conversationId: id,
              error: String(error),
            });
          })
        )
      )
    );
  };

  const unsubscribe = deps.projects.on('projectOpened', (projectId) => run(new Set([projectId])));
  run();

  return () => {
    disposed = true;
    unsubscribe();
  };
}
