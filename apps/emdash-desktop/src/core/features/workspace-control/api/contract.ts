import { defineContract, procedure } from '@emdash/wire/rpc';
import { z } from 'zod';
import type { WorkspaceAskStatus, WorkspaceSearchResult } from './workspace-search';

/** How an MCP client outside the app reaches workspace control (via the stdio bridge). */
export type AgentConnection =
  | { available: false }
  | {
      available: true;
      /** argv for the stdio bridge, environment first (`env VAR=1 <executable> <script> ...`). */
      command: string[];
    };

export const workspaceControlDomain = 'workspaceControl' as const;

export const workspaceControlContract = defineContract({
  connection: procedure({ input: z.void(), output: z.custom<AgentConnection>() }),
  /** Instant metadata search over every workspace, archived ones included. */
  searchWorkspaces: procedure({
    input: z.object({ query: z.string() }),
    output: z.custom<WorkspaceSearchResult>(),
  }),
  /** Starts a cheap, read-only agent run for when the metadata search isn't conclusive. */
  startWorkspaceAsk: procedure({
    input: z.object({ query: z.string().min(1) }),
    output: z.object({ runId: z.string() }),
  }),
  /** Where a run is: its current step, and the result once done. Poll until not running. */
  workspaceAskStatus: procedure({
    input: z.object({ runId: z.string() }),
    output: z.custom<WorkspaceAskStatus>(),
  }),
  cancelWorkspaceAsk: procedure({
    input: z.object({ runId: z.string() }),
    output: z.void(),
  }),
});
