import { z } from 'zod';

export const agentCliIdSchema = z.enum(['claude', 'opencode', 'codex', 'antigravity']);
export type AgentCliId = z.infer<typeof agentCliIdSchema>;

export const agentCliUpdateResultSchema = z.object({
  ok: z.boolean(),
  at: z.number(),
  trigger: z.enum(['manual', 'auto']),
  /** The command that ran, as an argument array. */
  command: z.array(z.string()),
  before: z.string().nullable(),
  after: z.string().nullable(),
  /** Combined stdout and stderr of the update command, unmodified. */
  output: z.string(),
  /** Set when the update failed, or ran but did not do what was expected. */
  error: z.string().nullable(),
});
export type AgentCliUpdateResult = z.infer<typeof agentCliUpdateResultSchema>;

export const agentCliAutoUpdateSchema = z.object({
  /** Who performs the automatic update: the CLI itself (via its config file) or Emjosh. */
  owner: z.enum(['cli', 'emjosh']),
  enabled: z.boolean(),
  /** Extra context, e.g. the CLI's own "notify" mode or an unreadable config file. */
  detail: z.string().nullable(),
});

export const agentCliInfoSchema = z.object({
  id: agentCliIdSchema,
  name: z.string(),
  installed: z.boolean(),
  path: z.string().nullable(),
  version: z.string().nullable(),
  latestVersion: z.string().nullable(),
  updateAvailable: z.boolean(),
  installMethod: z.string().nullable(),
  /** The command an update would run. */
  updateCommand: z.array(z.string()).nullable(),
  /** Why Update is unavailable, when it is. */
  updateBlockedReason: z.string().nullable(),
  autoUpdate: agentCliAutoUpdateSchema,
  updating: z.boolean(),
  lastUpdate: agentCliUpdateResultSchema.nullable(),
});
export type AgentCliInfo = z.infer<typeof agentCliInfoSchema>;

export const agentCliUpdateSettingsSchema = z.object({
  /** Emjosh-owned auto-update toggles, by CLI id. */
  autoUpdate: z.record(z.string(), z.boolean()),
  lastResults: z.record(z.string(), agentCliUpdateResultSchema),
  /** Last completed automatic check, by CLI id. */
  lastCheckedAt: z.record(z.string(), z.number()),
});
export type AgentCliUpdateSettings = z.infer<typeof agentCliUpdateSettingsSchema>;
