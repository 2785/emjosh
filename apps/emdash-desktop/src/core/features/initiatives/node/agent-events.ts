import type { InitiativeEventKind } from '@core/features/initiatives/api/contract';

/**
 * The initiative event an agent status event becomes, if any. Finishing a turn and waiting for the
 * user's approval are status (they wake nobody: the app already notifies the user of an approval, so
 * telling the lead would only make it repeat that). Stopping with an error is an `attention` event
 * that wakes the lead.
 */
export function describeAgentEvent(event: {
  type: string;
  payload?: { notificationType?: string };
}): { kind: InitiativeEventKind; what: string } | null {
  if (event.type === 'stop') return { kind: 'event', what: 'finished its turn' };
  if (event.type === 'background') {
    return {
      kind: 'event',
      what: 'finished its turn; background work it started is still running',
    };
  }
  if (event.type === 'error') return { kind: 'attention', what: 'stopped with an error' };
  if (event.type === 'notification' && event.payload?.notificationType === 'permission_prompt') {
    return { kind: 'event', what: 'is waiting for the user to approve something' };
  }
  return null;
}
