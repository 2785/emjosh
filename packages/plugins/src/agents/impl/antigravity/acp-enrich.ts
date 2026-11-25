import type { EnrichHook } from '@emdash/core/runtimes/acp/api';
import { TURN_END_META_KEY } from './acp';

/** Promotes the turn-end mark added by `withTurnEndMarkers` to `endsAgentTurn`. */
export const enrichAntigravityUpdate: EnrichHook = (event, raw) => {
  if (event.kind !== 'usage') return event;
  const meta = raw._meta as Record<string, unknown> | null | undefined;
  return meta?.[TURN_END_META_KEY] === true ? { ...event, endsAgentTurn: true } : event;
};
