import type { SessionSummary } from '@emdash/core/runtimes/acp/api';
import { describe, expect, it } from 'vitest';
import { deriveAcpAgentStatusActions, projectAcpStatusSnapshot } from './agent-status-transition';

function summary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    conversationId: 'conv-1',
    providerId: 'claude',
    lifecycle: 'ready',
    isGenerating: false,
    lastStopReason: null,
    lastTurnErrored: false,
    pendingPermissionCount: 0,
    backgroundAgentCount: 0,
    queuedPromptCount: 0,
    title: null,
    updatedAt: 1,
    ...overrides,
  };
}

describe('projectAcpStatusSnapshot', () => {
  it('projects busy work and pending permissions', () => {
    expect(projectAcpStatusSnapshot(summary({ queuedPromptCount: 1 }))).toBeNull();
    expect(
      projectAcpStatusSnapshot(summary({ isGenerating: true, pendingPermissionCount: 1 }))
    ).toMatchObject({
      kind: 'event',
      event: { type: 'notification', payload: { notificationType: 'permission_prompt' } },
    });
  });

  it('reconstructs completed and errored terminal statuses', () => {
    expect(projectAcpStatusSnapshot(summary({ lastStopReason: 'end_turn' }))).toMatchObject({
      kind: 'event',
      event: { type: 'stop' },
    });
    expect(projectAcpStatusSnapshot(summary({ lastTurnErrored: true }))).toMatchObject({
      kind: 'event',
      event: { type: 'error' },
    });
  });

  it('resets cancelled snapshots without overwriting fresh persisted state', () => {
    expect(projectAcpStatusSnapshot(summary({ lastStopReason: 'cancelled' }))).toEqual({
      kind: 'reset',
      conversationId: 'conv-1',
    });
    expect(projectAcpStatusSnapshot(summary())).toBeNull();
  });
});

describe('deriveAcpAgentStatusActions', () => {
  it('does not project a newly observed summary on the live path', () => {
    expect(deriveAcpAgentStatusActions(undefined, summary({ lifecycle: 'starting' }))).toEqual([]);
    expect(
      deriveAcpAgentStatusActions(
        undefined,
        summary({ lifecycle: 'starting', queuedPromptCount: 1 })
      )
    ).toEqual([]);
  });

  it('emits start when a newly observed summary is already generating', () => {
    expect(deriveAcpAgentStatusActions(undefined, summary({ isGenerating: true }))).toEqual([
      { kind: 'event', event: expect.objectContaining({ type: 'start' }) },
    ]);
    expect(
      deriveAcpAgentStatusActions(
        undefined,
        summary({ isGenerating: true, lifecycle: 'cancelling' })
      )
    ).toEqual([]);
  });

  it('emits start when generation begins', () => {
    const actions = deriveAcpAgentStatusActions(
      summary(),
      summary({ lifecycle: 'working', isGenerating: true })
    );

    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ kind: 'event', event: { type: 'start' } });
  });

  it('does not report an idle queue as active work', () => {
    expect(deriveAcpAgentStatusActions(summary(), summary({ queuedPromptCount: 1 }))).toEqual([]);
  });

  it('emits an attention notification when a permission prompt appears', () => {
    const actions = deriveAcpAgentStatusActions(
      summary({ lifecycle: 'working', isGenerating: true }),
      summary({ lifecycle: 'working', isGenerating: true, pendingPermissionCount: 1 })
    );

    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      kind: 'event',
      event: {
        type: 'notification',
        payload: { notificationType: 'permission_prompt' },
      },
    });
  });

  it('does not also emit start when a permission prompt is the first busy state', () => {
    const actions = deriveAcpAgentStatusActions(
      summary(),
      summary({ lifecycle: 'working', isGenerating: true, pendingPermissionCount: 1 })
    );

    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ kind: 'event', event: { type: 'notification' } });
  });

  it('restores working when the last permission request clears during generation', () => {
    const actions = deriveAcpAgentStatusActions(
      summary({ lifecycle: 'working', isGenerating: true, pendingPermissionCount: 1 }),
      summary({ lifecycle: 'working', isGenerating: true })
    );

    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ kind: 'event', event: { type: 'start' } });
  });

  it('keeps attention status while another permission request is pending', () => {
    expect(
      deriveAcpAgentStatusActions(
        summary({ lifecycle: 'working', isGenerating: true, pendingPermissionCount: 2 }),
        summary({ lifecycle: 'working', isGenerating: true, pendingPermissionCount: 1 })
      )
    ).toEqual([]);
  });

  it('emits attention when a permission request is already present on first observation', () => {
    const actions = deriveAcpAgentStatusActions(undefined, summary({ pendingPermissionCount: 1 }));

    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      kind: 'event',
      event: { type: 'notification', payload: { notificationType: 'permission_prompt' } },
    });
  });

  it('does not repeat attention when generation begins with an existing permission request', () => {
    expect(
      deriveAcpAgentStatusActions(
        summary({ pendingPermissionCount: 1 }),
        summary({ lifecycle: 'working', isGenerating: true, pendingPermissionCount: 1 })
      )
    ).toEqual([]);
  });

  it('does not restore working when cancellation clears a pending permission request', () => {
    expect(
      deriveAcpAgentStatusActions(
        summary({ lifecycle: 'working', isGenerating: true, pendingPermissionCount: 1 }),
        summary({ lifecycle: 'cancelling', isGenerating: true })
      )
    ).toEqual([]);
  });

  it('emits completion when permission clearance coincides with generation ending', () => {
    const actions = deriveAcpAgentStatusActions(
      summary({ lifecycle: 'working', isGenerating: true, pendingPermissionCount: 1 }),
      summary({ lastStopReason: 'end_turn' })
    );

    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ kind: 'event', event: { type: 'stop' } });
  });

  it('emits stop when busy work ends normally', () => {
    const actions = deriveAcpAgentStatusActions(
      summary({ lifecycle: 'working', isGenerating: true }),
      summary({ lifecycle: 'ready', lastStopReason: 'end_turn' })
    );

    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ kind: 'event', event: { type: 'stop' } });
  });

  it('emits error when busy work ends with an error', () => {
    const actions = deriveAcpAgentStatusActions(
      summary({ lifecycle: 'working', isGenerating: true }),
      summary({ lifecycle: 'ready', lastTurnErrored: true })
    );

    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ kind: 'event', event: { type: 'error' } });
  });

  it('resets to idle when busy work is cancelled', () => {
    const actions = deriveAcpAgentStatusActions(
      summary({ lifecycle: 'cancelling', isGenerating: true }),
      summary({
        lifecycle: 'ready',
        lastStopReason: 'cancelled',
      })
    );

    expect(actions).toEqual([
      {
        kind: 'reset',
        conversationId: 'conv-1',
      },
    ]);
  });

  it('resets to idle when a session is removed or closed', () => {
    expect(deriveAcpAgentStatusActions(summary(), undefined)).toEqual([
      {
        kind: 'reset',
        conversationId: 'conv-1',
      },
    ]);
    expect(deriveAcpAgentStatusActions(summary(), summary({ lifecycle: 'closed' }))).toEqual([
      {
        kind: 'reset',
        conversationId: 'conv-1',
      },
    ]);
  });
});

describe('background work status', () => {
  const working = summary({ lifecycle: 'working', isGenerating: true, agentTurnActive: false });
  const waiting = summary({ lastStopReason: 'end_turn', backgroundTaskCount: 1 });
  const types = (actions: ReturnType<typeof deriveAcpAgentStatusActions>) =>
    actions.map((action) => (action.kind === 'event' ? action.event.type : action.kind));

  it('waits on background work when a turn ends with tasks still running', () => {
    expect(types(deriveAcpAgentStatusActions(working, waiting))).toEqual(['background']);
  });

  it('completes once the last background task ends', () => {
    expect(
      types(deriveAcpAgentStatusActions(waiting, { ...waiting, backgroundTaskCount: 0 }))
    ).toEqual(['stop']);
    expect(
      types(deriveAcpAgentStatusActions(waiting, { ...waiting, backgroundTaskCount: 2 }))
    ).toEqual([]);
  });

  it('treats background agents outside a turn as background work, not working', () => {
    const agents = summary({
      isGenerating: true,
      agentTurnActive: false,
      backgroundAgentCount: 1,
      lastStopReason: 'cancelled',
    });
    expect(types(deriveAcpAgentStatusActions(working, agents))).toEqual(['background']);
    expect(
      types(
        deriveAcpAgentStatusActions(agents, {
          ...agents,
          isGenerating: false,
          backgroundAgentCount: 0,
        })
      )
    ).toEqual(['reset']);
  });

  it('shows working again when a turn starts during background work', () => {
    expect(
      types(deriveAcpAgentStatusActions(waiting, { ...working, backgroundTaskCount: 1 }))
    ).toEqual(['start']);
    expect(
      types(
        deriveAcpAgentStatusActions(waiting, {
          ...waiting,
          isGenerating: true,
          agentTurnActive: true,
        })
      )
    ).toEqual(['start']);
  });

  it('keeps an errored turn’s error while its background work runs and ends', () => {
    const errored = summary({ lastTurnErrored: true, backgroundTaskCount: 1 });
    expect(types(deriveAcpAgentStatusActions(working, errored))).toEqual(['error']);
    expect(
      types(deriveAcpAgentStatusActions(errored, { ...errored, backgroundTaskCount: 0 }))
    ).toEqual([]);
  });

  it('projects background work on first observation and in snapshots', () => {
    expect(types(deriveAcpAgentStatusActions(undefined, waiting))).toEqual(['background']);
    expect(projectAcpStatusSnapshot(waiting)).toMatchObject({ event: { type: 'background' } });
  });

  it('clears background work when the session closes', () => {
    expect(
      types(deriveAcpAgentStatusActions(waiting, { ...waiting, lifecycle: 'closed' }))
    ).toEqual(['reset']);
  });

  it('reads summaries from workspace servers that report neither new field', () => {
    expect(projectAcpStatusSnapshot(summary({ isGenerating: true }))).toMatchObject({
      event: { type: 'start' },
    });
    expect(
      projectAcpStatusSnapshot(summary({ isGenerating: true, backgroundAgentCount: 1 }))
    ).toMatchObject({ event: { type: 'background' } });
  });
});
