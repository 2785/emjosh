import { defineContract, eventStream, procedure } from '@emdash/wire/rpc';
import { z } from 'zod';
import type { DependencyEdge } from './dependency-order';

export type Initiative = {
  id: string;
  name: string;
  /** Messages addressed to a task are also delivered into its agent conversation. */
  pushMessages: boolean;
  archived: boolean;
  createdAt: string;
  taskIds: string[];
  /** Short labels of its tasks by task id (e.g. "F"); tasks without one are absent. */
  labels: Record<string, string>;
  /** The task orchestrating the initiative; null when it has none. */
  leadTaskId: string | null;
  /** What its active tasks declared they depend on; usually empty. */
  dependencies: InitiativeDependency[];
};

export type InitiativeDependency = DependencyEdge & {
  /** Why the dependency looked done when the lead was told (e.g. "PR #12 merged"); else null. */
  doneNotice: string | null;
};

/**
 * What a workspace's message is about. Only `done`, `blocked` and `decision` addressed to the lead
 * wake it (see messageWakesTask); `fyi` is stored for read_messages and list_workspaces.
 */
export const initiativeMessageKinds = ['done', 'blocked', 'decision', 'fyi'] as const;
export type InitiativeMessageKind = (typeof initiativeMessageKinds)[number];

/**
 * App events: `event` for status (a turn finished, an agent waits for the user's approval, a
 * workspace was created), which wakes nobody; `attention` for ones the lead must act on (an agent
 * stopped with an error), which wake whoever they reach.
 */
export type InitiativeEventKind = 'event' | 'attention';

/**
 * A message posted without a kind: by the user, by an agent whose tools predate kinds, or before
 * kinds existed. Addressed to the lead it wakes it like `done`; as a broadcast it stays quiet.
 */
export type UntypedMessageKind = 'message';

export function isInitiativeEvent(kind: InitiativeMessage['kind']): kind is InitiativeEventKind {
  return kind === 'event' || kind === 'attention';
}

export type InitiativeMessage = {
  id: string;
  initiativeId: string;
  /** Sending task; null for the user or the app. */
  fromTaskId: string | null;
  /** Addressed task; null for everyone. */
  toTaskId: string | null;
  kind: InitiativeMessageKind | UntypedMessageKind | InitiativeEventKind;
  body: string;
  createdAt: string;
};

export type InitiativeChange =
  | { type: 'initiatives-changed' }
  | { type: 'message-posted'; message: InitiativeMessage };

export const initiativesDomain = 'initiatives' as const;

export const initiativesContract = defineContract({
  list: procedure({
    input: z.object({ includeArchived: z.boolean().optional() }),
    output: z.custom<Initiative[]>(),
  }),
  create: procedure({ input: z.object({ name: z.string() }), output: z.custom<Initiative>() }),
  update: procedure({
    input: z.object({
      id: z.string(),
      name: z.string().optional(),
      pushMessages: z.boolean().optional(),
      archived: z.boolean().optional(),
    }),
    output: z.void(),
  }),
  /** Makes a task of the initiative its lead, or removes the lead with `taskId: null`. */
  setLead: procedure({
    input: z.object({ initiativeId: z.string(), taskId: z.string().nullable() }),
    output: z.void(),
  }),
  setTaskInitiative: procedure({
    input: z.object({ taskIds: z.array(z.string()), initiativeId: z.string().nullable() }),
    output: z.void(),
  }),
  /** Sets or (with null) clears a task's label in its initiative; rejects taken labels. */
  setLabel: procedure({
    input: z.object({ taskId: z.string(), label: z.string().nullable() }),
    output: z.void(),
  }),
  /** Replaces what a task depends on (tasks of its initiative); rejects cycles. */
  setDependencies: procedure({
    input: z.object({ taskId: z.string(), dependsOnTaskIds: z.array(z.string()) }),
    output: z.void(),
  }),
  messages: procedure({
    input: z.object({ initiativeId: z.string(), afterId: z.string().optional() }),
    output: z.custom<InitiativeMessage[]>(),
  }),
  /** Posts as the user, to everyone or one task. */
  post: procedure({
    input: z.object({
      initiativeId: z.string(),
      body: z.string(),
      toTaskId: z.string().nullable().optional(),
    }),
    output: z.custom<InitiativeMessage>(),
  }),
  events: eventStream({ key: z.void(), event: z.custom<InitiativeChange>() }),
});
