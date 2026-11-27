import { randomUUID } from 'node:crypto';
import type { AppApi } from './app-api';

const LOCAL_HOST = 'local:local';

export type TaskConversation = {
  id: string;
  provider: string;
  title: string;
  type: string | null;
};

export type WorkspaceConversationsDeps = {
  appApi: AppApi;
  /** A workspace's conversations, oldest first. */
  taskConversations(taskId: string): Promise<TaskConversation[]>;
  projectIdOf(taskId: string): Promise<string | null>;
};

export type PromptPlacement = 'auto' | 'queue' | 'steer' | 'interrupt';

type ConfigOption = {
  id: string;
  name?: string;
  category?: string;
  type?: string;
  currentValue?: string | boolean;
  options?: { value: string; name?: string; description?: string }[];
};

type SessionConfig = {
  options?: ConfigOption[];
  configuredOptions?: Record<string, string | boolean>;
};

export type ConversationSettings = {
  conversationId: string;
  provider: string;
  title: string;
  options: {
    id: string;
    name: string;
    kind: string;
    current: string | boolean | null;
    values?: { value: string; name: string }[];
  }[];
};

const isAcp = (conversation: TaskConversation) => (conversation.type ?? 'acp') === 'acp';

/**
 * What a user does in a workspace's chat from the app (change the model, effort or permission
 * mode, type a message, stop a turn, start another agent), as operations on the workspace's
 * conversations. Without a conversation id, the workspace's most recent chat is the one meant.
 */
export class WorkspaceConversations {
  constructor(private readonly deps: WorkspaceConversationsDeps) {}

  async settings(taskId: string, conversationId?: string): Promise<ConversationSettings[]> {
    const conversations = await this.select(taskId, conversationId, { all: true });
    return Promise.all(conversations.map((conversation) => this.settingsOf(conversation)));
  }

  /**
   * Applies session settings to a chat, live when its session runs. `forbidMode` refuses a
   * permission-mode change (an agent changing its own).
   */
  async updateSettings(
    taskId: string,
    input: {
      conversationId?: string;
      options: Record<string, string | boolean>;
      saveAsDefault?: boolean;
      forbidMode?: boolean;
    }
  ): Promise<{
    conversationId: string;
    applied: string[];
    failed: { id: string; error: string }[];
  }> {
    const [conversation] = await this.select(taskId, input.conversationId);
    if (!conversation) throw new Error('This workspace has no agent chat.');
    const known = await this.settingsOf(conversation);
    const applied: string[] = [];
    const failed: { id: string; error: string }[] = [];
    for (const [id, value] of Object.entries(input.options)) {
      const option = known.options.find((candidate) => candidate.id === id);
      if (input.forbidMode && (option?.kind === 'mode' || id === 'mode')) {
        failed.push({
          id,
          error: "An agent can't change its own permission mode; ask the user, or the lead.",
        });
        continue;
      }
      if (option?.values && !option.values.some((choice) => choice.value === value)) {
        failed.push({
          id,
          error: `Not an option of ${id}. Choose from: ${option.values.map((c) => c.value).join(', ')}.`,
        });
        continue;
      }
      try {
        const result = (await this.deps.appApi.call('conversations.acp.setOption', {
          conversationId: conversation.id,
          configId: id,
          value,
        })) as { success?: boolean; error?: unknown };
        if (result?.success === false) throw new Error(JSON.stringify(result.error));
        applied.push(id);
      } catch (error) {
        failed.push({ id, error: error instanceof Error ? error.message : String(error) });
      }
    }
    if (input.saveAsDefault && applied.length > 0) {
      await this.deps.appApi.call('conversations.providerSettings.patch', {
        host: LOCAL_HOST,
        providerId: conversation.provider,
        patch: {
          transport: 'acp',
          options: Object.fromEntries(applied.map((id) => [id, input.options[id]!])),
        },
      });
    }
    return { conversationId: conversation.id, applied, failed };
  }

  async send(
    taskId: string,
    input: { message: string; conversationId?: string; placement?: PromptPlacement }
  ): Promise<{ conversationId: string; sent: true }> {
    const text = input.message.trim();
    if (!text) throw new Error('The message is empty.');
    const [conversation] = await this.select(taskId, input.conversationId);
    if (!conversation) throw new Error('This workspace has no agent chat.');
    await this.deps.appApi.call('conversations.acp.sendPrompt', {
      conversationId: conversation.id,
      promptId: randomUUID(),
      prompt: { text },
      placement: input.placement ?? 'auto',
    });
    return { conversationId: conversation.id, sent: true };
  }

  async stop(taskId: string, conversationId?: string): Promise<{ stopped: string[] }> {
    const conversations = await this.select(taskId, conversationId, { all: !conversationId });
    for (const conversation of conversations) {
      await this.deps.appApi.call('conversations.acp.cancelTurn', {
        conversationId: conversation.id,
      });
    }
    return { stopped: conversations.map((conversation) => conversation.id) };
  }

  /** Starts another agent chat in a workspace, like the new-chat button. */
  async addAgent(
    taskId: string,
    input: {
      provider: string;
      title?: string;
      prompt?: string;
      options?: Record<string, string | boolean>;
    }
  ): Promise<{ conversationId: string; provider: string }> {
    const projectId = await this.deps.projectIdOf(taskId);
    if (!projectId) throw new Error('Unknown workspace.');
    const existing = await this.deps.taskConversations(taskId);
    const preferences = (await this.deps.appApi.read('conversations.providerSettings.model.value', {
      host: LOCAL_HOST,
      providerId: input.provider,
    })) as { acp?: { options?: Record<string, string | boolean> } } | undefined;
    const options = { ...preferences?.acp?.options, ...input.options };
    const conversationId = randomUUID();
    const prompt = input.prompt?.trim();
    await this.deps.appApi.call('conversations.createConversation', {
      id: conversationId,
      projectId,
      taskId,
      provider: input.provider,
      title: input.title?.trim() || `${input.provider} (${existing.length + 1})`,
      type: 'acp',
      ...(Object.keys(options).length > 0 && { options }),
      ...(prompt && { initialQueue: [{ text: prompt }] }),
      initialSize: { cols: 120, rows: 30 },
    });
    await this.deps.appApi.call('conversations.acp.startSession', {
      conversationId,
      mode: 'fresh',
    });
    return { conversationId, provider: input.provider };
  }

  async setPinned(taskId: string, pinned: boolean): Promise<{ pinned: boolean }> {
    const projectId = await this.deps.projectIdOf(taskId);
    if (!projectId) throw new Error('Unknown workspace.');
    await this.deps.appApi.call(
      'tasks.taskList.setPinned',
      { taskId, isPinned: pinned },
      { projectId }
    );
    return { pinned };
  }

  private async select(
    taskId: string,
    conversationId: string | undefined,
    options: { all?: boolean } = {}
  ): Promise<TaskConversation[]> {
    const acp = (await this.deps.taskConversations(taskId)).filter(isAcp);
    if (conversationId) {
      const match = acp.find((conversation) => conversation.id === conversationId);
      if (!match)
        throw new Error(`Conversation ${conversationId} isn't an agent chat of this workspace.`);
      return [match];
    }
    if (options.all) return acp;
    const latest = acp.at(-1);
    return latest ? [latest] : [];
  }

  private async settingsOf(conversation: TaskConversation): Promise<ConversationSettings> {
    let config: SessionConfig | undefined;
    try {
      config = (await this.deps.appApi.read('conversations.acp.session.config', {
        conversationId: conversation.id,
      })) as SessionConfig | undefined;
    } catch {
      config = undefined;
    }
    return {
      conversationId: conversation.id,
      provider: conversation.provider,
      title: conversation.title,
      options: (config?.options ?? []).map((option) => ({
        id: option.id,
        name: option.name ?? option.id,
        kind: option.category ?? option.type ?? 'other',
        current: option.currentValue ?? null,
        ...(option.options && {
          values: option.options.map((choice) => ({
            value: choice.value,
            name: choice.name ?? choice.value,
          })),
        }),
      })),
    };
  }
}
