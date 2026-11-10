import { defineContract, eventStream, procedure } from '@emdash/wire/rpc';
import { z } from 'zod';

export type Initiative = {
  id: string;
  name: string;
  /** Messages addressed to a task are also delivered into its agent conversation. */
  pushMessages: boolean;
  archived: boolean;
  createdAt: string;
  taskIds: string[];
  /** The task orchestrating the initiative; null when it has none. */
  leadTaskId: string | null;
};

export type InitiativeMessage = {
  id: string;
  initiativeId: string;
  /** Sending task; null for the user or the app. */
  fromTaskId: string | null;
  /** Addressed task; null for everyone. */
  toTaskId: string | null;
  kind: 'message' | 'event';
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
