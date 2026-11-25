import { and, eq, inArray } from 'drizzle-orm';
import {
  conversationRegistryTable as conversationRows,
  liveConversations,
} from '@core/features/conversations/api/node/registry';
import type { AppDb } from '@core/services/app-db/node/db';
import type { AgentCliId } from '../api/schemas';

/** Agent CLI ids match provider ids in the conversations table. */
export function createHasActiveTurns(db: AppDb) {
  return async (id: AgentCliId): Promise<boolean> => {
    const rows = await db
      .select({ id: conversationRows.id })
      .from(conversationRows)
      .where(
        and(
          eq(conversationRows.provider, id),
          liveConversations(),
          inArray(conversationRows.agentStatus, ['working', 'background', 'awaiting-input'])
        )
      )
      .limit(1)
      .execute();
    return rows.length > 0;
  };
}
