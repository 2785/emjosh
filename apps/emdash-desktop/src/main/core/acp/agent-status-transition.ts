import type { SessionSummary } from '@emdash/core/runtimes/acp/api';
import type { AgentStatusSignal } from '@core/primitives/agents/api';

export type AcpAgentStatusAction =
  | { kind: 'event'; event: AgentStatusSignal }
  | { kind: 'reset'; conversationId: string };

/** Busy with a turn: working, cancelling, or an agent-initiated turn. */
function isBusy(summary: SessionSummary | undefined): boolean {
  if (!summary?.isGenerating) return false;
  return (
    summary.lifecycle === 'working' ||
    summary.lifecycle === 'cancelling' ||
    summary.agentTurnActive === true ||
    summary.backgroundAgentCount === 0
  );
}

/**
 * No turn running, but background agents or tasks the agent started still are. Shown apart from
 * working, so a completion that never arrives leaves a stale label rather than a stuck turn.
 */
function isWaitingOnBackground(summary: SessionSummary | undefined): boolean {
  if (!summary || isBusy(summary) || summary.lifecycle === 'closed') return false;
  return summary.backgroundAgentCount > 0 || (summary.backgroundTaskCount ?? 0) > 0;
}

function eventBase(summary: SessionSummary): Omit<AgentStatusSignal, 'type' | 'payload'> {
  return {
    source: 'input',
    providerId: summary.providerId,
    conversationId: summary.conversationId,
    timestamp: Date.now(),
  };
}

function eventAction(
  summary: SessionSummary,
  type: 'start' | 'stop' | 'error' | 'background'
): AcpAgentStatusAction {
  return { kind: 'event', event: { ...eventBase(summary), type, payload: {} } };
}

function permissionAction(summary: SessionSummary): AcpAgentStatusAction {
  return {
    kind: 'event',
    event: {
      ...eventBase(summary),
      type: 'notification',
      payload: { notificationType: 'permission_prompt' },
    },
  };
}

function resetAction(conversationId: string): AcpAgentStatusAction {
  return { kind: 'reset', conversationId };
}

function settledAction(summary: SessionSummary): AcpAgentStatusAction | null {
  if (summary.lastTurnErrored) return eventAction(summary, 'error');
  if (isWaitingOnBackground(summary)) return eventAction(summary, 'background');
  if (summary.lastStopReason === 'cancelled') return resetAction(summary.conversationId);
  if (summary.lastStopReason !== null) return eventAction(summary, 'stop');
  return null;
}

export function projectAcpStatusSnapshot(summary: SessionSummary): AcpAgentStatusAction | null {
  if (summary.pendingPermissionCount > 0) return permissionAction(summary);
  if (isBusy(summary)) return eventAction(summary, 'start');
  return settledAction(summary);
}

export function deriveAcpAgentStatusActions(
  previous: SessionSummary | undefined,
  next: SessionSummary | undefined
): AcpAgentStatusAction[] {
  if (!next) {
    if (!previous) return [];
    return [resetAction(previous.conversationId)];
  }

  if (!previous) {
    // A session first observed mid-turn (e.g. one resumed after the bootstrap snapshot) still
    // needs its working status; settled first observations are left to the persisted state.
    if (next.pendingPermissionCount > 0) return [permissionAction(next)];
    if (isWaitingOnBackground(next)) return [eventAction(next, 'background')];
    return isBusy(next) && next.lifecycle !== 'cancelling' ? [eventAction(next, 'start')] : [];
  }

  if (next.lifecycle === 'closed') {
    return [resetAction(next.conversationId)];
  }

  const actions: AcpAgentStatusAction[] = [];
  const wasBusy = isBusy(previous);
  const nowBusy = isBusy(next);
  const previousPendingPermissionCount = previous?.pendingPermissionCount ?? 0;
  const permissionAppeared =
    previousPendingPermissionCount === 0 && next.pendingPermissionCount > 0;

  if (
    nowBusy &&
    next.lifecycle !== 'cancelling' &&
    next.pendingPermissionCount === 0 &&
    (!wasBusy || previousPendingPermissionCount > 0)
  ) {
    actions.push(eventAction(next, 'start'));
  }

  if (permissionAppeared) {
    actions.push(permissionAction(next));
  }

  if (!nowBusy && next.pendingPermissionCount === 0) {
    const nowWaiting = isWaitingOnBackground(next);
    // An errored turn shows its error whether or not background work outlives it.
    const backgroundChanged =
      isWaitingOnBackground(previous) !== nowWaiting && !next.lastTurnErrored;
    const permissionResolved = nowWaiting && previousPendingPermissionCount > 0;
    if (wasBusy || backgroundChanged || permissionResolved) {
      actions.push(settledAction(next) ?? resetAction(next.conversationId));
    }
  }

  return actions;
}
