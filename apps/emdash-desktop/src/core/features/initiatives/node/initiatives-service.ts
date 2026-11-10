import { and, asc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import type {
  Initiative,
  InitiativeChange,
  InitiativeMessage,
} from '@core/features/initiatives/api/contract';
import type { AppDb } from '@core/services/app-db/node/db';
import { appDbPokes } from '@core/services/app-db/node/pokes';
import {
  initiativeMessages,
  initiatives,
  initiativeSubscriptions,
  tasks,
} from '@core/services/app-db/node/schema';

type Listener = (change: InitiativeChange) => void;

export type SubscriptionTopic = 'messages' | 'events';

export type InitiativeSubscription = {
  topic: SubscriptionTopic;
  /** Only from this task; null for every task in the initiative. */
  sourceTaskId: string | null;
};

/**
 * Whether a message reaches a task. Messages addressed to it always do; so do the user's posts
 * to everyone. The initiative's lead gets everything, and every member gets the lead's
 * broadcasts. Other broadcasts from tasks ('messages') and app status events ('events') only
 * reach tasks subscribed to that topic from that task, or from every task.
 */
export function messageReachesTask(
  message: Pick<InitiativeMessage, 'kind' | 'fromTaskId' | 'toTaskId'>,
  taskId: string,
  subscriptions: readonly InitiativeSubscription[],
  leadTaskId: string | null = null
): boolean {
  if (message.fromTaskId === taskId) return false;
  if (taskId === leadTaskId) return true;
  if (message.toTaskId) return message.toTaskId === taskId;
  if (message.kind === 'message' && message.fromTaskId === null) return true;
  if (message.kind === 'message' && leadTaskId !== null && message.fromTaskId === leadTaskId) {
    return true;
  }
  const topic: SubscriptionTopic = message.kind === 'event' ? 'events' : 'messages';
  return subscriptions.some(
    (subscription) =>
      subscription.topic === topic &&
      (subscription.sourceTaskId === null || subscription.sourceTaskId === message.fromTaskId)
  );
}

/**
 * Initiatives: optional groups of tasks across projects, each with a message feed that its
 * tasks' agents (and the user) post to, plus app events about its tasks.
 */
export class InitiativesService {
  private readonly listeners = new Set<Listener>();

  constructor(private readonly db: AppDb) {}

  /** Subscribes to changes; returns the unsubscribe function. */
  onChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async list(options: { includeArchived?: boolean } = {}): Promise<Initiative[]> {
    const rows = await this.db
      .select()
      .from(initiatives)
      .where(options.includeArchived ? undefined : isNull(initiatives.archivedAt))
      .orderBy(asc(initiatives.createdAt));
    if (rows.length === 0) return [];
    const members = await this.db
      .select({ id: tasks.id, initiativeId: tasks.initiativeId })
      .from(tasks)
      .where(
        and(
          inArray(
            tasks.initiativeId,
            rows.map((row) => row.id)
          ),
          isNull(tasks.deletedAt)
        )
      );
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      pushMessages: row.pushMessages === 1,
      archived: row.archivedAt !== null,
      createdAt: row.createdAt,
      taskIds: members.filter((m) => m.initiativeId === row.id).map((m) => m.id),
      leadTaskId: row.leadTaskId,
    }));
  }

  async get(id: string): Promise<Initiative | null> {
    return (await this.list({ includeArchived: true })).find((i) => i.id === id) ?? null;
  }

  async create(name: string): Promise<Initiative> {
    const trimmed = name.trim();
    if (!trimmed) throw new Error('An initiative needs a name.');
    const id = crypto.randomUUID();
    await this.db.insert(initiatives).values({ id, name: trimmed });
    this.emit({ type: 'initiatives-changed' });
    return (await this.get(id))!;
  }

  /** Makes a task the initiative's lead, moving it into the initiative; null removes the lead. */
  async setLead(initiativeId: string, taskId: string | null): Promise<void> {
    if (!(await this.get(initiativeId))) {
      throw new Error(`Initiative '${initiativeId}' was not found.`);
    }
    if (taskId) await this.setTaskInitiative([taskId], initiativeId);
    await this.db
      .update(initiatives)
      .set({ leadTaskId: taskId, updatedAt: sql`CURRENT_TIMESTAMP` })
      .where(eq(initiatives.id, initiativeId));
    this.emit({ type: 'initiatives-changed' });
  }

  async update(
    id: string,
    changes: { name?: string; pushMessages?: boolean; archived?: boolean }
  ): Promise<void> {
    await this.db
      .update(initiatives)
      .set({
        ...(changes.name?.trim() ? { name: changes.name.trim() } : {}),
        ...(changes.pushMessages !== undefined
          ? { pushMessages: changes.pushMessages ? 1 : 0 }
          : {}),
        ...(changes.archived !== undefined
          ? { archivedAt: changes.archived ? sql`CURRENT_TIMESTAMP` : null }
          : {}),
        updatedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(eq(initiatives.id, id));
    this.emit({ type: 'initiatives-changed' });
  }

  /** Moves tasks into an initiative, or out of any with `initiativeId: null`. */
  async setTaskInitiative(taskIds: string[], initiativeId: string | null): Promise<void> {
    if (taskIds.length === 0) return;
    if (initiativeId && !(await this.get(initiativeId))) {
      throw new Error(`Initiative '${initiativeId}' was not found.`);
    }
    const rows = await this.db
      .update(tasks)
      .set({ initiativeId })
      .where(inArray(tasks.id, taskIds))
      .returning({ id: tasks.id, projectId: tasks.projectId });
    for (const row of rows) appDbPokes.tasks.poke({ projectId: row.projectId, taskId: row.id });
    // A lead that leaves its initiative stops leading it.
    await this.db
      .update(initiatives)
      .set({ leadTaskId: null })
      .where(
        and(
          inArray(initiatives.leadTaskId, taskIds),
          initiativeId ? ne(initiatives.id, initiativeId) : undefined
        )
      );
    this.emit({ type: 'initiatives-changed' });
  }

  async initiativeOfTask(taskId: string): Promise<Initiative | null> {
    const [row] = await this.db
      .select({ initiativeId: tasks.initiativeId })
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .limit(1);
    return row?.initiativeId ? this.get(row.initiativeId) : null;
  }

  async post(input: {
    initiativeId: string;
    fromTaskId: string | null;
    toTaskId?: string | null;
    kind?: 'message' | 'event';
    body: string;
  }): Promise<InitiativeMessage> {
    const body = input.body.trim();
    if (!body) throw new Error('A message needs text.');
    const [row] = await this.db
      .insert(initiativeMessages)
      .values({
        id: crypto.randomUUID(),
        initiativeId: input.initiativeId,
        fromTaskId: input.fromTaskId,
        toTaskId: input.toTaskId ?? null,
        kind: input.kind ?? 'message',
        body,
      })
      .returning();
    const message = toMessage(row!);
    this.emit({ type: 'message-posted', message });
    return message;
  }

  /**
   * Messages of an initiative in posting order, optionally only those reaching a task (see
   * messageReachesTask) and only after a given message.
   */
  async messages(input: {
    initiativeId: string;
    forTaskId?: string;
    afterId?: string;
    limit?: number;
  }): Promise<InitiativeMessage[]> {
    // rowid orders by insertion; timestamps can tie within a millisecond.
    const rows = await this.db
      .select()
      .from(initiativeMessages)
      .where(
        and(
          eq(initiativeMessages.initiativeId, input.initiativeId),
          input.afterId
            ? sql`rowid > (SELECT rowid FROM initiative_messages WHERE id = ${input.afterId})`
            : undefined
        )
      )
      .orderBy(sql`rowid`);
    const messages = rows.map(toMessage);
    const { forTaskId } = input;
    if (!forTaskId) return messages.slice(0, input.limit ?? 200);
    const [subscriptions, initiative] = await Promise.all([
      this.subscriptions(input.initiativeId, forTaskId),
      this.get(input.initiativeId),
    ]);
    const leadTaskId = initiative?.leadTaskId ?? null;
    const visible = messages.filter((message) =>
      messageReachesTask(message, forTaskId, subscriptions, leadTaskId)
    );
    return visible.slice(0, input.limit ?? 200);
  }

  /** The tasks of the initiative a message reaches, for delivery into their chats. */
  async recipients(message: InitiativeMessage): Promise<string[]> {
    const initiative = await this.get(message.initiativeId);
    if (!initiative) return [];
    const reached = await Promise.all(
      initiative.taskIds.map(async (taskId) =>
        messageReachesTask(
          message,
          taskId,
          await this.subscriptions(initiative.id, taskId),
          initiative.leadTaskId
        )
          ? taskId
          : null
      )
    );
    return reached.filter((taskId): taskId is string => taskId !== null);
  }

  async subscriptions(initiativeId: string, taskId: string): Promise<InitiativeSubscription[]> {
    const rows = await this.db
      .select({
        topic: initiativeSubscriptions.topic,
        sourceTaskId: initiativeSubscriptions.sourceTaskId,
      })
      .from(initiativeSubscriptions)
      .where(
        and(
          eq(initiativeSubscriptions.initiativeId, initiativeId),
          eq(initiativeSubscriptions.taskId, taskId)
        )
      );
    return rows;
  }

  /** Subscribes a task to a topic from the given tasks, or from every task when none are given. */
  async subscribe(input: {
    initiativeId: string;
    taskId: string;
    topic: SubscriptionTopic;
    sourceTaskIds?: string[];
  }): Promise<InitiativeSubscription[]> {
    const existing = await this.subscriptions(input.initiativeId, input.taskId);
    const sources: (string | null)[] = input.sourceTaskIds?.length
      ? [...new Set(input.sourceTaskIds)]
      : [null];
    const added = sources.filter(
      (source) =>
        !existing.some(
          (subscription) =>
            subscription.topic === input.topic && subscription.sourceTaskId === source
        )
    );
    if (added.length > 0) {
      await this.db.insert(initiativeSubscriptions).values(
        added.map((sourceTaskId) => ({
          id: crypto.randomUUID(),
          initiativeId: input.initiativeId,
          taskId: input.taskId,
          topic: input.topic,
          sourceTaskId,
        }))
      );
    }
    return this.subscriptions(input.initiativeId, input.taskId);
  }

  /** Drops the topic from the given tasks, or the whole topic when none are given. */
  async unsubscribe(input: {
    initiativeId: string;
    taskId: string;
    topic: SubscriptionTopic;
    sourceTaskIds?: string[];
  }): Promise<InitiativeSubscription[]> {
    await this.db
      .delete(initiativeSubscriptions)
      .where(
        and(
          eq(initiativeSubscriptions.initiativeId, input.initiativeId),
          eq(initiativeSubscriptions.taskId, input.taskId),
          eq(initiativeSubscriptions.topic, input.topic),
          input.sourceTaskIds?.length
            ? inArray(initiativeSubscriptions.sourceTaskId, input.sourceTaskIds)
            : undefined
        )
      );
    return this.subscriptions(input.initiativeId, input.taskId);
  }

  /** Resolves with the first new message for the task, or an empty list after the timeout. */
  waitForMessages(
    input: { initiativeId: string; forTaskId?: string; afterId?: string },
    timeoutMs: number
  ): Promise<InitiativeMessage[]> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (messages: InitiativeMessage[]) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        resolve(messages);
      };
      const unsubscribe = this.onChange((change) => {
        if (change.type !== 'message-posted') return;
        if (change.message.initiativeId !== input.initiativeId) return;
        // Only messages reaching the task (messages() applies the rules) end the wait.
        void this.messages(input).then((messages) => {
          if (messages.length > 0) finish(messages);
        });
      });
      const timer = setTimeout(() => finish([]), timeoutMs);
      // Messages posted between the caller's last read and subscribing.
      void this.messages(input).then((existing) => {
        if (existing.length > 0) finish(existing);
      });
    });
  }

  private emit(change: InitiativeChange): void {
    for (const listener of this.listeners) listener(change);
  }
}

function toMessage(row: typeof initiativeMessages.$inferSelect): InitiativeMessage {
  return {
    id: row.id,
    initiativeId: row.initiativeId,
    fromTaskId: row.fromTaskId,
    toTaskId: row.toTaskId,
    kind: row.kind,
    body: row.body,
    createdAt: row.createdAt,
  };
}
