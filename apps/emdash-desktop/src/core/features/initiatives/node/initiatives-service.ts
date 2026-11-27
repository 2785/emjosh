import { and, asc, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import {
  isInitiativeEvent,
  type Initiative,
  type InitiativeChange,
  type InitiativeDependency,
  type InitiativeMessage,
} from '@core/features/initiatives/api/contract';
import { findCycle } from '@core/features/initiatives/api/dependency-order';
import { nextLabel, normalizeLabel } from '@core/features/initiatives/api/labels';
import type { AppDb } from '@core/services/app-db/node/db';
import { appDbPokes } from '@core/services/app-db/node/pokes';
import {
  initiativeLabels,
  initiativeMessages,
  initiatives,
  initiativeSubscriptions,
  taskDependencies,
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
  const event = isInitiativeEvent(message.kind);
  if (!event && message.fromTaskId === null) return true;
  if (!event && leadTaskId !== null && message.fromTaskId === leadTaskId) return true;
  const topic: SubscriptionTopic = event ? 'events' : 'messages';
  return subscriptions.some(
    (subscription) =>
      subscription.topic === topic &&
      (subscription.sourceTaskId === null || subscription.sourceTaskId === message.fromTaskId)
  );
}

/**
 * Whether a message that reaches a task (messageReachesTask) is pushed into its chat, rather than
 * only stored for read_messages:
 *
 * - `attention` events wake whoever they reach; other events wake nobody.
 * - The user's posts wake everyone they reach.
 * - The lead wakes for anything addressed to it except `fyi` (a message without a kind comes from
 *   an agent that can't mark it, so it may be the report the lead waits for), for `done`,
 *   `blocked` and `decision` broadcasts, and not for messages between other workspaces.
 * - Other tasks wake for anything addressed to them, and for `done`, `blocked` and `decision`
 *   broadcasts.
 */
export function messageWakesTask(
  message: Pick<InitiativeMessage, 'kind' | 'fromTaskId' | 'toTaskId'>,
  taskId: string,
  leadTaskId: string | null
): boolean {
  if (message.kind === 'attention') return true;
  if (message.kind === 'event') return false;
  if (message.fromTaskId === null) return true;
  const marked = message.kind !== 'fyi' && message.kind !== 'message';
  if (message.toTaskId === null) return marked;
  if (message.toTaskId !== taskId) return false;
  return taskId !== leadTaskId || message.kind !== 'fyi';
}

/**
 * Whether a delivered message should reach a busy agent now rather than after a pause: decisions
 * and blockers, and anything the user posted. Others (reports, notes) can wait and be batched.
 */
export function messageIsUrgent(message: Pick<InitiativeMessage, 'kind' | 'fromTaskId'>): boolean {
  if (message.kind === 'decision' || message.kind === 'blocked') return true;
  return message.fromTaskId === null && message.kind === 'message';
}

/** A workspace's latest status event and latest message, as shown in list_workspaces. */
export type InitiativeTaskActivity = {
  lastEvent: Pick<InitiativeMessage, 'kind' | 'body' | 'createdAt'> | null;
  lastMessage: Pick<InitiativeMessage, 'kind' | 'toTaskId' | 'body' | 'createdAt'> | null;
};

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
    const dependencies = await this.dependencies();
    const members = await this.db
      .select({ id: tasks.id, initiativeId: tasks.initiativeId, label: tasks.initiativeLabel })
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
    return rows.map((row) => {
      const own = members.filter((m) => m.initiativeId === row.id);
      return {
        id: row.id,
        name: row.name,
        pushMessages: row.pushMessages === 1,
        archived: row.archivedAt !== null,
        createdAt: row.createdAt,
        taskIds: own.map((m) => m.id),
        labels: Object.fromEntries(own.flatMap((m) => (m.label ? [[m.id, m.label]] : []))),
        leadTaskId: row.leadTaskId,
        dependencies: dependencies.filter((dependency) => dependency.initiativeId === row.id),
      };
    });
  }

  /**
   * Every live dependency with its initiative. Drops (deletes) the stale ones on the way: those
   * whose tasks were archived or deleted, or are no longer in the same initiative.
   */
  async dependencies(): Promise<(InitiativeDependency & { initiativeId: string })[]> {
    const rows = await this.db.select().from(taskDependencies);
    if (rows.length === 0) return [];
    const ids = [...new Set(rows.flatMap((row) => [row.taskId, row.dependsOnTaskId]))];
    const taskRows = await this.db
      .select({ id: tasks.id, initiativeId: tasks.initiativeId })
      .from(tasks)
      .where(and(inArray(tasks.id, ids), isNull(tasks.deletedAt), isNull(tasks.archivedAt)));
    const initiativeOf = new Map(taskRows.map((row) => [row.id, row.initiativeId]));
    const live: (InitiativeDependency & { initiativeId: string })[] = [];
    const stale: typeof rows = [];
    for (const row of rows) {
      const initiativeId = initiativeOf.get(row.taskId);
      if (initiativeId && initiativeId === initiativeOf.get(row.dependsOnTaskId)) {
        live.push({
          initiativeId,
          taskId: row.taskId,
          dependsOnTaskId: row.dependsOnTaskId,
          doneNotice: row.doneNotice,
        });
      } else stale.push(row);
    }
    if (stale.length > 0) {
      for (const row of stale) await this.deleteDependency(row);
      this.emit({ type: 'initiatives-changed' });
    }
    return live;
  }

  /**
   * Replaces what a task depends on. The task and its dependencies must be active tasks of one
   * initiative, and the result must have no cycle.
   */
  async setDependencies(taskId: string, dependsOnTaskIds: string[]): Promise<void> {
    const wanted = [...new Set(dependsOnTaskIds)];
    const initiative = await this.initiativeOfTask(taskId);
    if (!initiative) throw new Error('The workspace is not in an initiative.');
    const active = new Set(
      (
        await this.db
          .select({ id: tasks.id })
          .from(tasks)
          .where(
            and(
              eq(tasks.initiativeId, initiative.id),
              isNull(tasks.deletedAt),
              isNull(tasks.archivedAt)
            )
          )
      ).map((row) => row.id)
    );
    if (!active.has(taskId)) throw new Error('An archived workspace cannot have dependencies.');
    const outside = wanted.filter((id) => !active.has(id));
    if (outside.length > 0) {
      throw new Error(
        `Not active workspaces of initiative "${initiative.name}": ${outside.join(', ')}.`
      );
    }
    const cycle = findCycle(initiative.dependencies, taskId, wanted);
    if (cycle) {
      const names = await this.taskNames(cycle);
      throw new Error(
        `That would create a dependency cycle: ${cycle.map((id) => names.get(id) ?? id).join(' → ')}.`
      );
    }
    const existing = initiative.dependencies.filter((dependency) => dependency.taskId === taskId);
    for (const dependency of existing) {
      if (!wanted.includes(dependency.dependsOnTaskId)) await this.deleteDependency(dependency);
    }
    const added = wanted.filter((id) => !existing.some((d) => d.dependsOnTaskId === id));
    if (added.length > 0) {
      await this.db
        .insert(taskDependencies)
        .values(added.map((dependsOnTaskId) => ({ taskId, dependsOnTaskId })));
    }
    this.emit({ type: 'initiatives-changed' });
  }

  /** Drops every dependency on or of the given tasks (when they are archived or deleted). */
  async removeDependencies(taskIds: string[]): Promise<void> {
    if (taskIds.length === 0) return;
    const removed = await this.db
      .delete(taskDependencies)
      .where(
        or(
          inArray(taskDependencies.taskId, taskIds),
          inArray(taskDependencies.dependsOnTaskId, taskIds)
        )
      )
      .returning({ taskId: taskDependencies.taskId });
    if (removed.length > 0) this.emit({ type: 'initiatives-changed' });
  }

  /** Records (or, with null, clears) that the lead was told the dependency looks done. */
  async setDependencyDoneNotice(
    dependency: { taskId: string; dependsOnTaskId: string },
    doneNotice: string | null
  ): Promise<void> {
    await this.db
      .update(taskDependencies)
      .set({ doneNotice })
      .where(
        and(
          eq(taskDependencies.taskId, dependency.taskId),
          eq(taskDependencies.dependsOnTaskId, dependency.dependsOnTaskId)
        )
      );
    this.emit({ type: 'initiatives-changed' });
  }

  /**
   * Moves a task's dependencies and dependents onto another task of its initiative (when one
   * is folded into the other). Edges that would point at itself or form a cycle are skipped
   * and reported by name.
   */
  async moveDependencies(fromTaskId: string, intoTaskId: string): Promise<{ skipped: string[] }> {
    const all = (await this.dependencies()).filter(
      (dependency) => dependency.taskId !== fromTaskId && dependency.dependsOnTaskId !== fromTaskId
    );
    const moved = (await this.db.select().from(taskDependencies))
      .filter((row) => row.taskId === fromTaskId || row.dependsOnTaskId === fromTaskId)
      .map((row) => ({
        taskId: row.taskId === fromTaskId ? intoTaskId : row.taskId,
        dependsOnTaskId: row.dependsOnTaskId === fromTaskId ? intoTaskId : row.dependsOnTaskId,
      }))
      .filter((edge) => edge.taskId !== edge.dependsOnTaskId);
    const skipped: { taskId: string; dependsOnTaskId: string }[] = [];
    const kept = [...all];
    for (const edge of moved) {
      if (kept.some((k) => k.taskId === edge.taskId && k.dependsOnTaskId === edge.dependsOnTaskId))
        continue;
      const current = kept.filter((k) => k.taskId === edge.taskId).map((k) => k.dependsOnTaskId);
      if (findCycle(kept, edge.taskId, [...current, edge.dependsOnTaskId])) {
        skipped.push(edge);
        continue;
      }
      await this.db.insert(taskDependencies).values(edge);
      kept.push({ ...edge, doneNotice: null, initiativeId: '' });
    }
    await this.db
      .delete(taskDependencies)
      .where(
        or(
          eq(taskDependencies.taskId, fromTaskId),
          eq(taskDependencies.dependsOnTaskId, fromTaskId)
        )
      );
    this.emit({ type: 'initiatives-changed' });
    const names = await this.taskNames(skipped.flatMap((e) => [e.taskId, e.dependsOnTaskId]));
    return {
      skipped: skipped.map(
        (e) =>
          `"${names.get(e.taskId) ?? e.taskId}" on "${names.get(e.dependsOnTaskId) ?? e.dependsOnTaskId}"`
      ),
    };
  }

  async removeDependency(dependency: { taskId: string; dependsOnTaskId: string }): Promise<void> {
    await this.deleteDependency(dependency);
    this.emit({ type: 'initiatives-changed' });
  }

  private async deleteDependency(dependency: { taskId: string; dependsOnTaskId: string }) {
    await this.db
      .delete(taskDependencies)
      .where(
        and(
          eq(taskDependencies.taskId, dependency.taskId),
          eq(taskDependencies.dependsOnTaskId, dependency.dependsOnTaskId)
        )
      );
  }

  private async taskNames(ids: string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const rows = await this.db
      .select({ id: tasks.id, name: tasks.name })
      .from(tasks)
      .where(inArray(tasks.id, [...new Set(ids)]));
    return new Map(rows.map((row) => [row.id, row.name]));
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

  /**
   * Makes a task the initiative's lead, moving it into the initiative (without a label; a member
   * keeps its own); null removes the lead.
   */
  async setLead(initiativeId: string, taskId: string | null): Promise<void> {
    const initiative = await this.get(initiativeId);
    if (!initiative) throw new Error(`Initiative '${initiativeId}' was not found.`);
    if (taskId && !initiative.taskIds.includes(taskId)) {
      await this.setTaskInitiative([taskId], initiativeId, { label: null });
    }
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

  /**
   * Moves tasks into an initiative, or out of any with `initiativeId: null`. Tasks that join get
   * the next free label unless `label` is given (null for none, or one label for one task); a
   * task that leaves loses its label. Tasks already in the initiative keep theirs unless `label`
   * is given.
   */
  /**
   * Throws when a new workspace could not join the initiative with this label. Callers check
   * this before starting a workspace so a bad initiative or label fails before anything exists.
   */
  async assertCanJoin(initiativeId: string, label?: string | null): Promise<void> {
    if (!(await this.get(initiativeId))) {
      throw new Error(`Initiative '${initiativeId}' was not found.`);
    }
    const normalized = label ? normalizeLabel(label) : null;
    if (normalized) await this.ensureLabelFree(initiativeId, '', normalized);
  }

  async setTaskInitiative(
    taskIds: string[],
    initiativeId: string | null,
    options: { label?: string | null } = {}
  ): Promise<void> {
    if (taskIds.length === 0) return;
    if (initiativeId && !(await this.get(initiativeId))) {
      throw new Error(`Initiative '${initiativeId}' was not found.`);
    }
    if (options.label && new Set(taskIds).size > 1) {
      throw new Error('A label names one workspace; add them one at a time to give labels.');
    }
    const label = options.label ? normalizeLabel(options.label) : options.label;
    if (initiativeId && label) await this.ensureLabelFree(initiativeId, taskIds[0]!, label);
    const current = await this.db
      .select({ id: tasks.id, initiativeId: tasks.initiativeId })
      .from(tasks)
      .where(inArray(tasks.id, taskIds));
    const joining = current.filter((row) => row.initiativeId !== initiativeId).map((r) => r.id);
    const rows = joining.length
      ? await this.db
          .update(tasks)
          .set({ initiativeId, initiativeLabel: null })
          .where(inArray(tasks.id, joining))
          .returning({ id: tasks.id, projectId: tasks.projectId })
      : [];
    for (const row of rows) appDbPokes.tasks.poke({ projectId: row.projectId, taskId: row.id });
    if (initiativeId) {
      if (label !== undefined) await this.writeLabel(initiativeId, taskIds[0]!, label);
      else for (const taskId of joining) await this.assignNextLabel(initiativeId, taskId);
    }
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

  /**
   * Sets or (with null) clears a task's label in its initiative. Rejects a label another task of
   * the initiative holds or held: labels aren't reused while the initiative exists.
   */
  async setLabel(taskId: string, raw: string | null): Promise<void> {
    const initiative = await this.initiativeOfTask(taskId);
    if (!initiative) throw new Error('The workspace is not in an initiative.');
    const label = raw === null || !raw.trim() ? null : normalizeLabel(raw);
    if (label) await this.ensureLabelFree(initiative.id, taskId, label);
    await this.writeLabel(initiative.id, taskId, label);
    this.emit({ type: 'initiatives-changed' });
  }

  private async ensureLabelFree(initiativeId: string, taskId: string, label: string) {
    const [holder] = await this.db
      .select({ name: tasks.name })
      .from(tasks)
      .where(
        and(
          eq(tasks.initiativeId, initiativeId),
          eq(tasks.initiativeLabel, label),
          ne(tasks.id, taskId),
          isNull(tasks.deletedAt)
        )
      )
      .limit(1);
    if (holder) throw new Error(`Label "${label}" is taken by workspace "${holder.name}".`);
    const [issued] = await this.db
      .select({ taskId: initiativeLabels.taskId })
      .from(initiativeLabels)
      .where(
        and(eq(initiativeLabels.initiativeId, initiativeId), eq(initiativeLabels.label, label))
      )
      .limit(1);
    if (issued && issued.taskId !== taskId) {
      const name = (await this.taskNames([issued.taskId])).get(issued.taskId) ?? issued.taskId;
      throw new Error(
        `Label "${label}" was given to workspace "${name}" earlier in this initiative; labels ` +
          "aren't reused, so pick another."
      );
    }
  }

  /** Records the label as issued to the task (once) and sets it, or clears it with null. */
  private async writeLabel(initiativeId: string, taskId: string, label: string | null) {
    if (label) {
      await this.db
        .insert(initiativeLabels)
        .values({ initiativeId, label, taskId })
        .onConflictDoNothing();
    }
    await this.db.update(tasks).set({ initiativeLabel: label }).where(eq(tasks.id, taskId));
  }

  /**
   * Gives a task that joined an initiative its label from an earlier stay, when no other member
   * holds it, else the first letter never issued in the initiative.
   */
  private async assignNextLabel(initiativeId: string, taskId: string) {
    const issued = await this.db
      .select({ label: initiativeLabels.label, taskId: initiativeLabels.taskId })
      .from(initiativeLabels)
      .where(eq(initiativeLabels.initiativeId, initiativeId))
      .orderBy(sql`rowid`);
    const held = new Set(
      (
        await this.db
          .select({ label: tasks.initiativeLabel })
          .from(tasks)
          .where(and(eq(tasks.initiativeId, initiativeId), isNull(tasks.deletedAt)))
      ).flatMap((row) => (row.label ? [row.label] : []))
    );
    const previous = issued.filter((row) => row.taskId === taskId && !held.has(row.label)).pop();
    const label = previous?.label ?? nextLabel(new Set(issued.map((row) => row.label)));
    await this.writeLabel(initiativeId, taskId, label);
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
    kind?: InitiativeMessage['kind'];
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

  /** The tasks a message reaches, split by whether it wakes them (messageWakesTask). */
  async deliveryTargets(message: InitiativeMessage): Promise<{ wake: string[]; quiet: string[] }> {
    const leadTaskId = (await this.get(message.initiativeId))?.leadTaskId ?? null;
    const wake: string[] = [];
    const quiet: string[] = [];
    for (const taskId of await this.recipients(message)) {
      (messageWakesTask(message, taskId, leadTaskId) ? wake : quiet).push(taskId);
    }
    return { wake, quiet };
  }

  /** Each sending task's latest status event and latest message in the initiative. */
  async activity(initiativeId: string): Promise<Map<string, InitiativeTaskActivity>> {
    const rows = await this.db
      .select()
      .from(initiativeMessages)
      .where(eq(initiativeMessages.initiativeId, initiativeId))
      .orderBy(sql`rowid`);
    const byTask = new Map<string, InitiativeTaskActivity>();
    for (const message of rows.map(toMessage)) {
      if (!message.fromTaskId) continue;
      const entry = byTask.get(message.fromTaskId) ?? { lastEvent: null, lastMessage: null };
      const { kind, body, createdAt } = message;
      if (isInitiativeEvent(kind)) entry.lastEvent = { kind, body, createdAt };
      else entry.lastMessage = { kind, toTaskId: message.toTaskId, body, createdAt };
      byTask.set(message.fromTaskId, entry);
    }
    return byTask;
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
