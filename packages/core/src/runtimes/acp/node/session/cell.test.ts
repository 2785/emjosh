import type { PermissionOptionKind } from '@agentclientprotocol/sdk';
import { isOk } from '@emdash/shared';
import { noopLogger } from '@emdash/shared/logger';
import { deferred } from '@emdash/shared/testing';
import { describe, expect, it, vi } from 'vitest';
import { FakeAcpAgent } from '#runtimes/acp/node/acp-test-support';
import { promptImageBlocks, SessionCell } from './cell';
import type { SessionCellDeps } from './cell-deps';
function makePendingCell(agent = new FakeAcpAgent(), deps: Partial<SessionCellDeps> = {}) {
  const cell = new SessionCell({
    conversationId: 'conv-1',
    providerId: 'claude',
    acpSessionId: 'session-1',
    agent,
    resolveAttachment: vi.fn().mockResolvedValue({ data: '', mimeType: 'image/png' }),
    logger: noopLogger,
    ...deps,
  });
  return { cell, agent };
}
function dispatchInitialPrompts(cell: SessionCell, prompts: readonly string[]) {
  const prepared = cell.prepareActivation(
    prompts.map((text) => ({ text })),
    false
  );
  if (!prepared.success) throw new Error('Expected the activation to prepare');
  prepared.data();
}
function backgroundAgentLaunch(agentId: string) {
  return {
    kind: 'subagent' as const,
    toolCallId: `tool-${agentId}`,
    agentId,
    title: 'Background agent',
    status: 'in_progress' as const,
    parentToolCallId: null,
    background: true,
  };
}
function makeCell(agent = new FakeAcpAgent()) {
  const result = makePendingCell(agent);
  const { cell } = result;
  cell.applySessionReady();
  return result;
}
describe('SessionCell prompts', () => {
  it('publishes idle notifications without generation, agent activity, or blocking prompts', async () => {
    const { cell, agent } = makeCell();
    agent.prompt = vi.fn().mockResolvedValue({ stopReason: 'end_turn' });
    try {
      cell.push({ kind: 'notification', title: 'Monitor expired', text: '12 events delivered' });
      expect(cell.history().active).toBeNull();
      expect(cell.history().committed[0].items[0].kind).toBe('notification');
      expect(cell.sessionState).toMatchObject({
        agentTurnActive: false,
        isGenerating: false,
        backgroundAgentCount: 0,
      });
      expect(cell.sessionState.transcript?.historyRevision).toBe(1);
      expect(await cell.prompt({ text: 'Next request' })).toEqual({
        success: true,
        data: { queued: false },
      });
      expect(agent.prompt).toHaveBeenCalledOnce();
    } finally {
      cell.dispose();
    }
  });

  it('keeps a pending prompt active when a monitor notification arrives', async () => {
    const { cell, agent } = makeCell();
    let finish!: (result: { stopReason: 'end_turn' }) => void;
    agent.prompt = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    try {
      const pending = cell.prompt({ text: 'Still working' });
      await vi.waitFor(() => expect(agent.prompt).toHaveBeenCalledOnce());
      const turnId = cell.history().active?.id;
      cell.push({ kind: 'notification', title: 'Monitor expired', text: '12 events delivered' });
      expect(cell.history().active?.id).toBe(turnId);
      expect(cell.history().committed).toEqual([]);
      expect(cell.sessionState.isGenerating).toBe(true);
      finish({ stopReason: 'end_turn' });
      await pending;
      expect(cell.history().committed[0].items.map((item) => item.kind)).toEqual([
        'message',
        'notification',
      ]);
      expect(cell.sessionState.isGenerating).toBe(false);
    } finally {
      cell.dispose();
    }
  });

  it('replays notifications without setting foreground activity', () => {
    const { cell } = makePendingCell();
    try {
      cell.beginReplay();
      cell.push({ kind: 'notification', title: 'Monitor event', text: 'Historical event' });
      cell.endReplay();
      cell.applySessionLoaded();
      expect(cell.history().active).toBeNull();
      expect(cell.history().committed[0].items[0].kind).toBe('notification');
      expect(cell.sessionState).toMatchObject({
        agentTurnActive: false,
        isGenerating: false,
        backgroundAgentCount: 0,
      });
    } finally {
      cell.dispose();
    }
  });

  it('settles background agents left running in replayed history', () => {
    const { cell } = makePendingCell();
    try {
      cell.beginReplay();
      cell.push({
        kind: 'subagent',
        toolCallId: 'tool-1',
        agentId: 'agent-1',
        title: 'Background agent from a previous process',
        status: 'in_progress',
        parentToolCallId: null,
        background: true,
      });
      cell.endReplay();
      cell.applySessionLoaded();

      expect(cell.transcript.agents).toMatchObject([{ agentId: 'agent-1', status: 'completed' }]);
      expect(cell.sessionState).toMatchObject({
        backgroundAgentCount: 0,
        isGenerating: false,
        lifecycle: 'ready',
      });
    } finally {
      cell.dispose();
    }
  });

  it('rejects notifications outside a usable session just like other transcript events', () => {
    const { cell } = makePendingCell();
    try {
      cell.push({ kind: 'notification', title: 'Stale event', text: 'Do not reopen' });
      expect(cell.history()).toEqual({ committed: [], active: null });
    } finally {
      cell.dispose();
    }
  });

  it.each([false, true])(
    'defers prepared prompt dispatch until commit (resumed=%s)',
    async (resumed) => {
      const { cell, agent } = makePendingCell();
      agent.prompt = vi.fn().mockResolvedValue({ stopReason: 'end_turn' });
      if (resumed) cell.beginReplay();
      try {
        const prepared = cell.prepareActivation([{ text: 'first' }, { text: 'second' }], resumed);
        expect(prepared.success).toBe(true);
        expect(agent.prompt).not.toHaveBeenCalled();
        expect(cell.prepareActivation([{ text: 'unexpected' }], resumed).success).toBe(false);
        if (!prepared.success) return;
        prepared.data();
        prepared.data();
        await vi.waitFor(() =>
          expect(agent.prompt).toHaveBeenCalledWith({
            sessionId: 'session-1',
            prompt: [{ type: 'text', text: 'first\n\nsecond' }],
          })
        );
        expect(agent.prompt).toHaveBeenCalledTimes(1);
      } finally {
        cell.dispose();
      }
    }
  );

  it('invalidates prepared dispatch when the activation is disposed', () => {
    const { cell, agent } = makePendingCell();
    agent.prompt = vi.fn();
    const prepared = cell.prepareActivation([{ text: 'never send' }], false);
    expect(prepared.success).toBe(true);
    cell.dispose();
    if (prepared.success) prepared.data();
    expect(agent.prompt).not.toHaveBeenCalled();
  });

  it('keeps MCP startup failures out of transcript and agent activity', () => {
    const { cell } = makeCell();
    cell.push({ kind: 'mcp_startup_failure', server: 'docs', error: 'Connection refused' });
    expect(cell.mcpStartupFailures.get('docs')).toBe('Connection refused');
    expect(cell.history()).toEqual({ committed: [], active: null });
    expect(cell.sessionState.agentTurnActive).toBe(false);
    expect(cell.sessionState.isGenerating).toBe(false);
    expect(makeCell().cell.mcpStartupFailures.size).toBe(0);
  });
  it('synthesizes a user message and settles the turn', async () => {
    const { cell, agent } = makeCell();
    agent.prompt = vi.fn().mockResolvedValue({ stopReason: 'end_turn' });
    const result = await cell.prompt({ text: 'hello' });
    expect(result).toEqual({ success: true, data: { queued: false } });
    expect(agent.prompt).toHaveBeenCalledWith({
      sessionId: 'session-1',
      prompt: [{ type: 'text', text: 'hello' }],
    });
    const history = cell.history();
    expect(history.active).toBeNull();
    expect(history.committed).toHaveLength(1);
    expect(history.committed[0].items[0]).toMatchObject({
      kind: 'message',
      role: 'user',
      text: 'hello',
    });
    expect(history.committed[0].outcome).toEqual({ kind: 'done', reason: 'end_turn' });
  });
  it('queues while working and drains after the active turn settles', async () => {
    const { cell, agent } = makeCell();
    let resolveFirst!: (value: { stopReason: 'end_turn' }) => void;
    agent.prompt = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<{
            stopReason: 'end_turn';
          }>((resolve) => {
            resolveFirst = resolve;
          })
      )
      .mockResolvedValueOnce({ stopReason: 'end_turn' });
    const first = cell.prompt({ text: 'first' });
    const second = await cell.prompt({ text: 'second' });
    expect(second).toEqual({ success: true, data: { queued: true } });
    expect(cell.sessionState.queuedPrompts).toHaveLength(1);
    resolveFirst({ stopReason: 'end_turn' });
    await first;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(agent.prompt).toHaveBeenCalledTimes(2);
    expect(cell.sessionState.queuedPrompts).toHaveLength(0);
  });
  it('sends a follow-up while background agents run without stopping them', async () => {
    const { cell, agent } = makeCell();
    agent.prompt = vi
      .fn()
      .mockImplementationOnce(async () => {
        cell.push(backgroundAgentLaunch('agent-1'));
        return { stopReason: 'end_turn' };
      })
      .mockResolvedValue({ stopReason: 'end_turn' });
    await cell.prompt({ text: 'launch an agent' });
    expect(cell.sessionState.backgroundAgentCount).toBe(1);

    expect(await cell.interrupt({ text: 'follow-up' })).toEqual({
      success: true,
      data: { queued: false },
    });

    expect(agent.prompt).toHaveBeenCalledTimes(2);
    expect(agent.cancel).not.toHaveBeenCalled();
  });
  it('fails background agents when cancelled', async () => {
    const { cell, agent } = makeCell();
    cell.push(backgroundAgentLaunch('agent-1'));
    await cell.cancel();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(agent.cancel).toHaveBeenCalledWith({ sessionId: 'session-1' });
    expect(cell.transcript.agents).toMatchObject([{ agentId: 'agent-1', status: 'failed' }]);
    expect(cell.sessionState.backgroundAgentCount).toBe(0);
  });
  it('keeps a background agent running when the turn that launched it ends', async () => {
    const { cell, agent } = makeCell();
    agent.prompt = vi.fn().mockImplementation(async () => {
      cell.push(backgroundAgentLaunch('agent-1'));
      return { stopReason: 'end_turn' };
    });
    await cell.prompt({ text: 'launch an agent' });
    expect(cell.transcript.agents).toMatchObject([{ agentId: 'agent-1', status: 'running' }]);
    expect(cell.sessionState.isGenerating).toBe(true);
  });
  it('completes background agents from earlier turns when a later turn ends', async () => {
    // Claude doesn't report an agent that finishes during a turn on the ACP stream.
    const { cell, agent } = makeCell();
    agent.prompt = vi
      .fn()
      .mockImplementationOnce(async () => {
        cell.push(backgroundAgentLaunch('agent-1'));
        return { stopReason: 'end_turn' };
      })
      .mockImplementationOnce(async () => {
        cell.push(backgroundAgentLaunch('agent-2'));
        return { stopReason: 'end_turn' };
      });
    await cell.prompt({ text: 'launch an agent' });
    await cell.prompt({ text: 'launch another' });
    expect(cell.transcript.agents).toMatchObject([
      { agentId: 'agent-1', status: 'completed' },
      { agentId: 'agent-2', status: 'running' },
    ]);
    expect(cell.sessionState.backgroundAgentCount).toBe(1);
  });
  it('completes background agents from earlier turns when an agent-initiated turn quiesces', async () => {
    vi.useFakeTimers();
    try {
      const { cell, agent } = makeCell();
      agent.prompt = vi.fn().mockImplementation(async () => {
        cell.push(backgroundAgentLaunch('agent-1'));
        return { stopReason: 'end_turn' };
      });
      await cell.prompt({ text: 'launch an agent' });
      cell.push({ kind: 'message', role: 'assistant', messageId: null, text: 'Tests passed.' });
      vi.advanceTimersByTime(300);
      await Promise.resolve();
      expect(cell.transcript.agents).toMatchObject([{ agentId: 'agent-1', status: 'completed' }]);
      expect(cell.sessionState.isGenerating).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
describe('SessionCell interrupt', () => {
  it('folds queued prompts into the interrupting prompt and runs it after cancelling', async () => {
    const { cell, agent } = makeCell();
    let resolveFirst!: (value: { stopReason: 'cancelled' }) => void;
    agent.prompt = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<{ stopReason: 'cancelled' }>((resolve) => {
            resolveFirst = resolve;
          })
      )
      .mockResolvedValueOnce({ stopReason: 'end_turn' });
    const first = cell.prompt({ text: 'first' });
    await cell.prompt({ text: 'second' });
    const onAccepted = vi.fn();

    const interrupted = await cell.interrupt(
      { text: 'third' },
      { id: 'interrupt-1', onAccepted, resolvedAttachments: [] }
    );

    expect(interrupted).toEqual({ success: true, data: { queued: true } });
    expect(onAccepted).toHaveBeenCalledWith({ queued: true });
    expect(agent.cancel).toHaveBeenCalledTimes(1);
    expect(cell.sessionState.lifecycle).toBe('cancelling');
    expect(cell.sessionState.queuedPrompts).toMatchObject([
      { id: 'interrupt-1', text: 'second\n\nthird' },
    ]);

    resolveFirst({ stopReason: 'cancelled' });
    await first;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(cell.sessionState.queuedPrompts).toHaveLength(0);
    expect(agent.prompt).toHaveBeenLastCalledWith({
      sessionId: 'session-1',
      prompt: [{ type: 'text', text: 'second\n\nthird' }],
    });
  });

  it('does not cancel again while a cancellation is already in flight', async () => {
    const { cell, agent } = makeCell();
    agent.prompt = vi.fn(() => new Promise(() => {}));
    void cell.prompt({ text: 'first' });
    await cell.interrupt({ text: 'second' });

    await cell.interrupt({ text: 'third' });

    expect(agent.cancel).toHaveBeenCalledTimes(1);
    expect(cell.sessionState.queuedPrompts).toMatchObject([{ text: 'second\n\nthird' }]);
  });

  it('sends immediately without cancelling when idle', async () => {
    const { cell, agent } = makeCell();
    agent.prompt = vi.fn().mockResolvedValue({ stopReason: 'end_turn' });

    const result = await cell.interrupt({ text: 'hello' });

    expect(result).toMatchObject({ success: true, data: { queued: false } });
    expect(agent.cancel).not.toHaveBeenCalled();
    expect(agent.prompt).toHaveBeenCalledWith({
      sessionId: 'session-1',
      prompt: [{ type: 'text', text: 'hello' }],
    });
  });
});

describe('SessionCell steering', () => {
  function makeSteeringCell(outcome: string) {
    const agent = new FakeAcpAgent();
    agent.prompt = vi.fn(() => new Promise(() => {}));
    const extMethod = vi.fn(async () => ({ outcome }));
    Object.assign(agent, { extMethod });
    const { cell } = makePendingCell(agent, { supportsSteering: true });
    cell.applySessionReady();
    return { cell, agent, extMethod };
  }

  it('hands the message and the queue to the running turn instead of cancelling it', async () => {
    const { cell, agent, extMethod } = makeSteeringCell('injected');
    void cell.prompt({ text: 'build the feature' });
    await cell.prompt({ text: 'also update docs' });

    const result = await cell.interrupt(
      { text: 'actually skip the tests' },
      { id: 'steer-1', onAccepted: vi.fn(), resolvedAttachments: [] }
    );

    expect(result).toEqual({ success: true, data: { queued: false } });
    expect(extMethod).toHaveBeenCalledWith('_session/steering', {
      sessionId: 'session-1',
      prompt: [{ type: 'text', text: 'also update docs\n\nactually skip the tests' }],
      _meta: { steering: { idleBehavior: 'promptRequired' } },
    });
    expect(agent.cancel).not.toHaveBeenCalled();
    expect(cell.sessionState).toMatchObject({ lifecycle: 'working', queuedPrompts: [] });
    expect(cell.history().active?.items).toContainEqual(
      expect.objectContaining({
        kind: 'message',
        text: 'also update docs\n\nactually skip the tests',
      })
    );
  });

  it('falls back to cancel-and-run-next when the agent has no running turn to steer', async () => {
    const { cell, agent, extMethod } = makeSteeringCell('promptRequired');
    void cell.prompt({ text: 'build the feature' });

    const result = await cell.interrupt({ text: 'stop and do this' });

    expect(extMethod).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ success: true, data: { queued: true } });
    expect(agent.cancel).toHaveBeenCalledTimes(1);
    expect(cell.sessionState.queuedPrompts).toMatchObject([{ text: 'stop and do this' }]);
  });
});

describe('SessionCell provider results after disposal', () => {
  it('ignores a detached prompt result after disposal without starting the queue', async () => {
    const turn = deferred<{ stopReason: 'cancelled' }>();
    const onTranscriptChanged = vi.fn();
    const { cell, agent } = makePendingCell(new FakeAcpAgent(), {
      callbacks: { onTranscriptChanged },
    });
    agent.prompt.mockReturnValueOnce(turn.promise);
    dispatchInitialPrompts(cell, ['first', 'second']);
    await vi.waitFor(() => expect(agent.prompt).toHaveBeenCalledOnce());
    cell.dispose();
    onTranscriptChanged.mockClear();

    turn.resolve({ stopReason: 'cancelled' });
    await new Promise((resolve) => setImmediate(resolve));

    expect(agent.prompt).toHaveBeenCalledOnce();
    expect(onTranscriptChanged).not.toHaveBeenCalled();
  });

  it('reports a failed detached settlement once', async () => {
    const turn = deferred<{ stopReason: 'end_turn' }>();
    const observerError = new Error('projection failed');
    const onTranscriptChanged = vi.fn();
    const logger = { ...noopLogger, error: vi.fn() };
    const { cell, agent } = makePendingCell(new FakeAcpAgent(), {
      logger,
      callbacks: { onTranscriptChanged },
    });
    agent.prompt.mockReturnValueOnce(turn.promise);
    dispatchInitialPrompts(cell, ['first']);
    await vi.waitFor(() => expect(agent.prompt).toHaveBeenCalledOnce());
    onTranscriptChanged.mockReset().mockImplementation(() => {
      throw observerError;
    });

    turn.resolve({ stopReason: 'end_turn' });
    await vi.waitFor(() => expect(logger.error).toHaveBeenCalledOnce());

    expect(logger.error).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ error: observerError })
    );
    expect(onTranscriptChanged).toHaveBeenCalledOnce();
    cell.dispose();
  });
});
describe('SessionCell permissions', () => {
  it('brokers permission requests through the per-cell broker', async () => {
    const { cell } = makeCell();
    const permission = cell.requestPermission({
      sessionId: 'session-1',
      toolCall: { toolCallId: 'tool-1', title: 'Read a file', kind: 'read' },
      options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' as PermissionOptionKind }],
    });
    expect(cell.sessionState.pendingPermissions).toHaveLength(1);
    expect(cell.sessionState.pendingPermissions[0].toolCall).toMatchObject({
      kind: 'read-tool-call',
      toolCallId: 'tool-1',
    });
    const result = cell.resolvePermission(
      cell.sessionState.pendingPermissions[0].requestId,
      'allow'
    );
    expect(isOk(result)).toBe(true);
    await expect(permission).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'allow' },
    });
    expect(cell.sessionState.pendingPermissions).toHaveLength(0);
  });
  it('drains pending permissions on dispose', async () => {
    const { cell } = makeCell();
    const permission = cell.requestPermission({
      sessionId: 'session-1',
      toolCall: { toolCallId: 'tool-2', title: 'Write a file', kind: 'edit' },
      options: [
        { optionId: 'reject', name: 'Reject', kind: 'reject_once' as PermissionOptionKind },
      ],
    });
    cell.dispose();
    await expect(permission).resolves.toEqual({ outcome: { outcome: 'cancelled' } });
  });
});
describe('SessionCell config options', () => {
  it.each([false, true])('sets an arbitrary native boolean option to %s', async (value) => {
    const { cell, agent } = makeCell();
    const option = {
      id: 'provider-speed',
      name: 'Speed',
      type: 'boolean' as const,
      currentValue: !value,
    };
    cell.applySessionMeta({ configOptions: [option] });
    agent.setSessionConfigOption.mockResolvedValue({
      configOptions: [{ ...option, currentValue: value }],
    });

    expect(await cell.setOption(option.id, value)).toMatchObject({ success: true });
    expect(agent.setSessionConfigOption).toHaveBeenCalledWith({
      sessionId: 'session-1',
      configId: option.id,
      type: 'boolean',
      value,
    });
    expect(cell.config.options).toEqual([{ ...option, currentValue: value }]);

    agent.setSessionConfigOption.mockClear();
    expect(await cell.setOption(option.id, 'on')).toMatchObject({
      success: false,
      error: { type: 'set_config_failed' },
    });
    expect(agent.setSessionConfigOption).not.toHaveBeenCalled();
  });

  it('distinguishes a pending config catalog from an authoritative empty catalog', () => {
    const { cell } = makePendingCell();
    expect(cell.configCatalog).toEqual({ kind: 'pending' });
    cell.applySessionReady();
    expect(cell.configCatalog).toEqual({
      kind: 'ready',
      config: {
        options: [],
      },
    });
  });
  it('sets mode through the provider config option and seeds the response', async () => {
    const { cell, agent } = makeCell();
    cell.applySessionMeta({
      configOptions: [
        {
          id: 'mode',
          name: 'Mode',
          category: 'mode',
          type: 'select',
          currentValue: 'agent',
          options: [
            { value: 'agent', name: 'Agent' },
            { value: 'agent-full-access', name: 'Agent (full access)' },
          ],
        },
      ],
    });
    agent.setSessionConfigOption = vi.fn().mockResolvedValue({
      configOptions: [
        {
          id: 'mode',
          name: 'Mode',
          category: 'mode',
          type: 'select',
          currentValue: 'agent-full-access',
          options: [
            { value: 'agent', name: 'Agent' },
            { value: 'agent-full-access', name: 'Agent (full access)' },
          ],
        },
      ],
    });
    const result = await cell.setOption('mode', 'agent-full-access');
    expect(isOk(result)).toBe(true);
    expect(agent.setSessionConfigOption).toHaveBeenCalledWith({
      sessionId: 'session-1',
      configId: 'mode',
      value: 'agent-full-access',
    });
    expect(agent.setSessionMode).not.toHaveBeenCalled();
    expect(cell.config.options?.find((option) => option.category === 'mode')?.currentValue).toBe(
      'agent-full-access'
    );
  });
  it('rejects changes when the agent lacks the config setter', async () => {
    const { cell, agent } = makeCell();
    cell.applySessionMeta({
      configOptions: [
        {
          id: 'mode',
          name: 'Mode',
          category: 'mode',
          type: 'select',
          currentValue: 'agent',
          options: [
            { value: 'agent', name: 'Agent' },
            { value: 'read-only', name: 'Read-only' },
          ],
        },
      ],
    });
    agent.setSessionConfigOption = undefined as unknown as typeof agent.setSessionConfigOption;
    const result = await cell.setOption('mode', 'read-only');
    expect(result).toMatchObject({ success: false, error: { type: 'set_config_failed' } });
    expect(agent.setSessionMode).not.toHaveBeenCalled();
  });
  it('sets effort using its native config option id', async () => {
    const { cell, agent } = makeCell();
    cell.applySessionMeta({
      configOptions: [
        {
          id: 'reasoning_effort',
          name: 'Reasoning effort',
          category: 'thought_level',
          type: 'select',
          currentValue: 'medium',
          options: [
            { value: 'medium', name: 'Medium' },
            { value: 'high', name: 'High' },
          ],
        },
      ],
    });
    agent.setSessionConfigOption = vi.fn().mockResolvedValue({
      configOptions: [
        {
          id: 'reasoning_effort',
          name: 'Reasoning effort',
          category: 'thought_level',
          type: 'select',
          currentValue: 'high',
          options: [
            { value: 'medium', name: 'Medium' },
            { value: 'high', name: 'High' },
          ],
        },
      ],
    });
    const result = await cell.setOption('reasoning_effort', 'high');
    expect(isOk(result)).toBe(true);
    expect(agent.setSessionConfigOption).toHaveBeenCalledWith({
      sessionId: 'session-1',
      configId: 'reasoning_effort',
      value: 'high',
    });
    expect(
      cell.config.options?.find((option) => option.category === 'thought_level')?.currentValue
    ).toBe('high');
  });
  it('sets collaboration mode independently from permission mode', async () => {
    const { cell, agent } = makeCell();
    cell.applySessionMeta({
      configOptions: [
        {
          id: 'mode',
          name: 'Permissions',
          category: 'mode',
          type: 'select',
          currentValue: 'agent',
          options: [{ value: 'agent', name: 'Agent' }],
        },
        {
          id: 'collaboration_mode',
          name: 'Collaboration mode',
          category: 'collaboration_mode',
          type: 'select',
          currentValue: 'default',
          options: [
            { value: 'default', name: 'Default' },
            { value: 'plan', name: 'Plan' },
          ],
        },
      ],
    });
    agent.setSessionConfigOption = vi.fn().mockResolvedValue({
      configOptions: [
        {
          id: 'mode',
          name: 'Permissions',
          category: 'mode',
          type: 'select',
          currentValue: 'agent',
          options: [{ value: 'agent', name: 'Agent' }],
        },
        {
          id: 'collaboration_mode',
          name: 'Collaboration mode',
          category: 'collaboration_mode',
          type: 'select',
          currentValue: 'plan',
          options: [
            { value: 'default', name: 'Default' },
            { value: 'plan', name: 'Plan' },
          ],
        },
      ],
    });
    const result = await cell.setOption('collaboration_mode', 'plan');
    expect(isOk(result)).toBe(true);
    expect(agent.setSessionConfigOption).toHaveBeenCalledWith({
      sessionId: 'session-1',
      configId: 'collaboration_mode',
      value: 'plan',
    });
    expect(
      cell.config.options?.find((option) => option.category === 'collaboration_mode')?.currentValue
    ).toBe('plan');
    expect(cell.config.options?.find((option) => option.category === 'mode')?.currentValue).toBe(
      'agent'
    );
  });
});
describe('SessionCell idle turns and queue commands', () => {
  it('amends a completed tool without starting agent activity or an idle timer', () => {
    vi.useFakeTimers();
    const { cell } = makeCell();
    try {
      cell.transcript.pushEvent(
        {
          kind: 'tool_call',
          toolCallId: 'old',
          title: 'Run',
          toolKind: 'execute',
          status: 'in_progress',
          parentToolCallId: null,
          diffs: [],
          locations: [],
        },
        0
      );
      cell.transcript.endTurn(10);
      cell.push({
        kind: 'tool_update',
        toolCallId: 'old',
        status: 'failed',
        parentToolCallId: null,
        outputText: 'late failure',
      });
      expect(cell.sessionState.agentTurnActive).toBe(false);
      expect(cell.sessionState.isGenerating).toBe(false);
      expect(cell.history().active).toBeNull();
      expect(cell.history().committed[0].items[0]).toMatchObject({
        toolCallId: 'old',
        status: 'error',
        outputText: 'late failure',
      });
      expect(cell.sessionState.transcript?.historyRevision).toBe(2);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      cell.dispose();
      vi.useRealTimers();
    }
  });
  it('does not mistake idle plan revisions or unmatched tool updates for agent activity', () => {
    const { cell } = makeCell();
    try {
      cell.push({ kind: 'plan', entries: [] });
      cell.push({
        kind: 'tool_update',
        toolCallId: 'unknown',
        parentToolCallId: null,
        status: 'completed',
      });
      expect(cell.sessionState.agentTurnActive).toBe(false);
      expect(cell.history()).toEqual({ committed: [], active: null });
    } finally {
      cell.dispose();
    }
  });
  it('settles idle agent turns after quiesce', async () => {
    vi.useFakeTimers();
    try {
      const { cell } = makeCell();
      cell.push({
        kind: 'message',
        role: 'assistant',
        messageId: null,
        text: 'An unsolicited response',
      });
      expect(cell.sessionState.agentTurnActive).toBe(true);
      expect(cell.history().active?.initiator).toBe('agent');
      vi.advanceTimersByTime(300);
      await Promise.resolve();
      expect(cell.sessionState.agentTurnActive).toBe(false);
      expect(cell.history().active).toBeNull();
      expect(cell.history().committed.at(-1)?.outcome).toEqual({
        kind: 'done',
        reason: 'quiesced',
      });
    } finally {
      vi.useRealTimers();
    }
  });
  it('queues, edits, removes, and reorders queued prompts', () => {
    const { cell, agent } = makeCell();
    // Keep the session busy so reordering an idle queue does not drain its head
    // (QueueReordered dispatches the new head when the session is idle).
    agent.prompt = vi.fn().mockReturnValue(new Promise(() => {}));
    void cell.prompt({ text: 'busy' });
    expect(isOk(cell.queuePrompt({ text: 'a' }))).toBe(true);
    expect(isOk(cell.queuePrompt({ text: 'b' }))).toBe(true);
    const [first, second] = cell.sessionState.queuedPrompts;
    expect(isOk(cell.editQueuedPrompt(first.id, { text: 'edited' }))).toBe(true);
    expect(isOk(cell.reorderQueue([second.id, first.id]))).toBe(true);
    expect(cell.sessionState.queuedPrompts.map((prompt) => prompt.id)).toEqual([
      second.id,
      first.id,
    ]);
    expect(cell.sessionState.queuedPrompts[1].text).toBe('edited');
    expect(isOk(cell.removeQueuedPrompt(first.id))).toBe(true);
    expect(cell.sessionState.queuedPrompts.map((prompt) => prompt.id)).toEqual([second.id]);
  });
});

describe('promptImageBlocks', () => {
  const image = (data: string) => ({ data, mimeType: 'image/png' });

  it('labels images the prompt text refers to, as hidden context before each image', () => {
    expect(
      promptImageBlocks(
        'compare [Image 2] with [Image 1]',
        [{ name: 'Image 1' }, { name: 'Image 2' }],
        [image('a'), image('b')]
      )
    ).toEqual([
      { type: 'text', text: '<emdash-hidden-context>\n[Image 1]\n</emdash-hidden-context>' },
      { type: 'image', data: 'a', mimeType: 'image/png' },
      { type: 'text', text: '<emdash-hidden-context>\n[Image 2]\n</emdash-hidden-context>' },
      { type: 'image', data: 'b', mimeType: 'image/png' },
    ]);
  });

  it('sends unreferenced or unnamed images without a label', () => {
    expect(
      promptImageBlocks('look at this', [{ name: 'Image 1' }, {}], [image('a'), image('b')])
    ).toEqual([
      { type: 'image', data: 'a', mimeType: 'image/png' },
      { type: 'image', data: 'b', mimeType: 'image/png' },
    ]);
  });
});
