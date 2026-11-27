import { describe, expect, it, vi } from 'vitest';
import type { AppApi } from './app-api';
import { WorkspaceConversations, type TaskConversation } from './workspace-conversations';

const chats: TaskConversation[] = [
  { id: 'c1', provider: 'claude', title: 'claude (1)', type: 'acp' },
  { id: 'c2', provider: 'codex', title: 'codex (2)', type: 'acp' },
  { id: 'term', provider: 'claude', title: 'tui', type: 'pty' },
];

const config = {
  options: [
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      currentValue: 'sonnet',
      options: [
        { value: 'sonnet', name: 'Sonnet' },
        { value: 'opus', name: 'Opus' },
      ],
    },
    {
      id: 'mode',
      name: 'Mode',
      category: 'mode',
      currentValue: 'default',
      options: [
        { value: 'default', name: 'Default' },
        { value: 'bypass', name: 'Bypass' },
      ],
    },
  ],
};

function setup() {
  const call = vi.fn(async (path: string, _input?: unknown, _key?: unknown) => {
    if (path === 'conversations.acp.setOption') return { success: true, data: {} };
    return undefined;
  });
  const read = vi.fn(async (path: string, _key?: unknown) =>
    path === 'conversations.acp.session.config'
      ? config
      : { acp: { options: { mode: 'bypass', model: 'sonnet' } } }
  );
  const conversations = new WorkspaceConversations({
    appApi: { call, read } as unknown as AppApi,
    taskConversations: async () => chats,
    projectIdOf: async (taskId) => (taskId === 't1' ? 'p1' : null),
  });
  return { conversations, call, read };
}

describe('WorkspaceConversations', () => {
  it('lists the options of a workspace’s agent chats with their values, skipping terminals', async () => {
    const { conversations } = setup();
    const settings = await conversations.settings('t1');
    expect(settings.map((chat) => chat.conversationId)).toEqual(['c1', 'c2']);
    expect(settings[0]!.options[0]).toEqual({
      id: 'model',
      name: 'Model',
      kind: 'model',
      current: 'sonnet',
      values: [
        { value: 'sonnet', name: 'Sonnet' },
        { value: 'opus', name: 'Opus' },
      ],
    });
  });

  it('applies settings to the most recent chat, one option at a time', async () => {
    const { conversations, call } = setup();
    const result = await conversations.updateSettings('t1', { options: { model: 'opus' } });
    expect(result).toEqual({ conversationId: 'c2', applied: ['model'], failed: [] });
    expect(call).toHaveBeenCalledWith('conversations.acp.setOption', {
      conversationId: 'c2',
      configId: 'model',
      value: 'opus',
    });
  });

  it('refuses values the agent does not offer, naming the valid ones', async () => {
    const { conversations, call } = setup();
    const result = await conversations.updateSettings('t1', { options: { model: 'gpt-9' } });
    expect(result.applied).toEqual([]);
    expect(result.failed[0]!.error).toContain('sonnet, opus');
    expect(call).not.toHaveBeenCalled();
  });

  it('refuses a permission-mode change when asked to (an agent changing its own)', async () => {
    const { conversations, call } = setup();
    const result = await conversations.updateSettings('t1', {
      options: { mode: 'bypass', model: 'opus' },
      forbidMode: true,
    });
    expect(result.applied).toEqual(['model']);
    expect(result.failed).toEqual([
      { id: 'mode', error: expect.stringContaining('own permission mode') },
    ]);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('saves applied settings as the agent’s defaults on request', async () => {
    const { conversations, call } = setup();
    await conversations.updateSettings('t1', {
      conversationId: 'c1',
      options: { model: 'opus' },
      saveAsDefault: true,
    });
    expect(call).toHaveBeenLastCalledWith('conversations.providerSettings.patch', {
      host: 'local:local',
      providerId: 'claude',
      patch: { transport: 'acp', options: { model: 'opus' } },
    });
  });

  it('sends a message with the placement asked for, to the chosen or latest chat', async () => {
    const { conversations, call } = setup();
    await conversations.send('t1', { message: ' hi ', placement: 'steer' });
    expect(call).toHaveBeenCalledWith(
      'conversations.acp.sendPrompt',
      expect.objectContaining({
        conversationId: 'c2',
        prompt: { text: 'hi' },
        placement: 'steer',
        promptId: expect.any(String),
      })
    );
    await expect(conversations.send('t1', { message: '  ' })).rejects.toThrow('empty');
    await expect(
      conversations.send('t1', { message: 'x', conversationId: 'term' })
    ).rejects.toThrow("isn't an agent chat");
  });

  it('stops every agent chat of a workspace, or just the one named', async () => {
    const { conversations, call } = setup();
    expect(await conversations.stop('t1')).toEqual({ stopped: ['c1', 'c2'] });
    expect(await conversations.stop('t1', 'c1')).toEqual({ stopped: ['c1'] });
    expect(call).toHaveBeenCalledWith('conversations.acp.cancelTurn', { conversationId: 'c1' });
  });

  it('starts another agent chat from the agent’s saved settings plus overrides', async () => {
    const { conversations, call } = setup();
    const added = await conversations.addAgent('t1', {
      provider: 'claude',
      prompt: 'Review it.',
      options: { model: 'opus' },
    });
    expect(call).toHaveBeenNthCalledWith(
      1,
      'conversations.createConversation',
      expect.objectContaining({
        id: added.conversationId,
        projectId: 'p1',
        taskId: 't1',
        provider: 'claude',
        title: 'claude (4)',
        type: 'acp',
        options: { mode: 'bypass', model: 'opus' },
        initialQueue: [{ text: 'Review it.' }],
      })
    );
    expect(call).toHaveBeenNthCalledWith(2, 'conversations.acp.startSession', {
      conversationId: added.conversationId,
      mode: 'fresh',
    });
  });

  it('pins a workspace through its project’s task list', async () => {
    const { conversations, call } = setup();
    await conversations.setPinned('t1', true);
    expect(call).toHaveBeenCalledWith(
      'tasks.taskList.setPinned',
      { taskId: 't1', isPinned: true },
      { projectId: 'p1' }
    );
    await expect(conversations.setPinned('nope', true)).rejects.toThrow('Unknown workspace');
  });
});
