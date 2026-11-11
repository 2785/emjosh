import type { Logger } from '@emdash/shared/logger';
import type { Clock } from '@emdash/shared/scheduling';
import type { McpServerRegistration } from '#primitives/mcp/api';
import type {
  AcpStartInputWire,
  PromptAttachment,
  PromptInput,
  PromptPlacement,
} from '#runtimes/acp/api';
import type { AcpProcessHost } from '#runtimes/acp/api/transport';
import type { AgentPluginHost, ResolvedAcpProvider } from '#services/agent-plugins/api/plugins';
import type { ConversationLifecycleReporter } from '#services/conversation-reports/node';
import type { SessionIntentStore } from '#services/session-intents/api';
import type { IdlePolicyConfig } from '#services/session-lifecycle/api';
import type { AcpHistoryCache } from './history-cache';

export type AcpStartInput = AcpStartInputWire;

export type ResolveAcpProvider = (providerId: string) => ResolvedAcpProvider | null;

export interface ResolvedPromptAttachment {
  data: string;
  mimeType: string;
}

export type ResolvePromptAttachment = (
  conversationId: string,
  attachment: PromptAttachment
) => Promise<ResolvedPromptAttachment>;

export type AcpRuntimeProcessHost = Omit<AcpProcessHost, 'resolveSpawnContext'>;

export interface AcpRuntimeDeps {
  agentHost: AgentPluginHost;
  host: AcpRuntimeProcessHost;
  resolveAttachment: ResolvePromptAttachment;
  intents: SessionIntentStore;
  /** Keeps recent history across session restarts, shown while a session starts. */
  historyCache?: AcpHistoryCache;
  /** Lifecycle reports into the conversation index (spec §3.3); defaults to a no-op. */
  conversationReports?: ConversationLifecycleReporter;
  clock?: Clock;
  /** Extra MCP servers for one conversation's session, beyond the provider's configured ones. */
  sessionMcpServers?: (conversationId: string) => Promise<readonly McpServerRegistration[]>;
  lifecycle?: {
    session?: IdlePolicyConfig;
    sweepIntervalMs?: number;
    connectionIdleTtlMs?: number;
    activationDrainTimeoutMs?: number;
  };
  logger: Logger;
}

export interface SendPromptInput {
  conversationId: string;
  promptId: string;
  prompt: PromptInput;
  /** 'queue' always queues; 'auto' (default) delivers if idle and queues while a turn is active. */
  placement?: PromptPlacement;
}
