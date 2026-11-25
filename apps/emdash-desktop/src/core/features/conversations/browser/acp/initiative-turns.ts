import type { CollapsedTurn, TranscriptTurn } from '@emdash/chat-ui';
import { parseInitiativeDelivery } from '@core/features/initiatives/api/delivery';

/** How an agent says a reply to initiative activity has nothing for the user. */
const QUIET_REPLY = '[quiet]';

/**
 * Collapses a turn that an initiative delivery started (recognized by its prompt's header, which
 * survives session reloads because it is part of the prompt text) into "Initiative activity (N)".
 * The turn's closing reply stays visible, since that is what the agent tells the user; replies
 * that are empty or start with `[quiet]` fold away with the rest, as does any text followed by
 * more tool calls.
 */
export function collapseInitiativeTurn(turn: TranscriptTurn): CollapsedTurn | null {
  const prompt = turn.items.find((item) => item.kind === 'message' && item.role === 'user');
  if (prompt?.kind !== 'message') return null;
  const delivery = parseInitiativeDelivery(prompt.text);
  if (!delivery) return null;
  const last = [...turn.items]
    .reverse()
    .find((item) => item.kind !== 'thinking' && item.kind !== 'notification');
  const reply =
    last?.kind === 'message' &&
    last.role === 'assistant' &&
    last.text.trim() !== '' &&
    !last.text.trimStart().startsWith(QUIET_REPLY)
      ? last
      : null;
  return { label: `Initiative activity (${delivery.count})`, visibleItemId: reply?.id ?? null };
}
