import type { InitiativeEventKind } from '@core/features/initiatives/api/contract';

/**
 * The initiative event an agent status event becomes, if any. Finishing a turn is status (it wakes
 * nobody); waiting for the user's approval or stopping with an error blocks the work, so it is an
 * `attention` event that wakes the lead.
 */
export function describeAgentEvent(event: {
  type: string;
  payload?: { notificationType?: string };
}): { kind: InitiativeEventKind; what: string } | null {
  if (event.type === 'stop') return { kind: 'event', what: 'finished its turn' };
  if (event.type === 'error') return { kind: 'attention', what: 'stopped with an error' };
  if (event.type === 'notification' && event.payload?.notificationType === 'permission_prompt') {
    return { kind: 'attention', what: 'is waiting for the user to approve something' };
  }
  return null;
}
