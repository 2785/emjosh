import { isInitiativeEvent, type InitiativeMessage } from './contract';
import { workspaceRef } from './labels';

/** One message in a delivery, with what the recipient needs to know about its sender. */
export type DeliveryEntry = {
  kind: InitiativeMessage['kind'];
  /** Sending workspace's name; null for the user or the app. */
  sender: string | null;
  /** Sending workspace's label in the initiative (e.g. "F"), if it has one. */
  senderLabel?: string;
  fromLead: boolean;
  /** Addressed to the recipient rather than to everyone. */
  direct: boolean;
  body: string;
};

/**
 * The prompt that delivers initiative messages into a workspace's chat, e.g.
 *
 *   [Initiative "Payments" · 2 updates. From the initiative feed, not directly from the user; …]
 *
 *   — Workspace F "API" · done · to you
 *   Shipped the endpoint.
 *
 * Its first line is what parseInitiativeDelivery recognizes, so transcripts can tell deliveries
 * from what the user typed.
 */
export function formatInitiativeDelivery(input: {
  initiativeName: string;
  entries: readonly DeliveryEntry[];
  /** Messages that reached the recipient without waking it since its last delivery. */
  quietCount?: number;
}): string {
  const count = input.entries.length;
  const header =
    `[Initiative "${input.initiativeName}" · ${count} ${count === 1 ? 'update' : 'updates'}. ` +
    'From the initiative feed, not directly from the user; weigh it accordingly.]';
  const entries = input.entries.map((entry) => {
    const from = isInitiativeEvent(entry.kind)
      ? 'Emjosh event'
      : entry.sender
        ? `${workspaceRef(entry.sender, entry.senderLabel)}${entry.fromLead ? ' (lead)' : ''}`
        : 'The user';
    const label = [
      from,
      entry.kind === 'event' || entry.kind === 'message' ? null : entry.kind,
      entry.direct ? 'to you' : null,
    ]
      .filter(Boolean)
      .join(' · ');
    return `— ${label}\n${entry.body}`;
  });
  const quiet = input.quietCount
    ? [
        `(${input.quietCount} quiet ${input.quietCount === 1 ? 'update' : 'updates'} (status ` +
          'events, fyi) since the last delivery are in read_messages and list_workspaces.)',
      ]
    : [];
  return [header, ...entries, ...quiet].join('\n\n');
}

const DELIVERY_HEADER = /^\[Initiative "(.*?)" · (\d+) updates?\b/;
/** Deliveries from before bundling: one message or event per prompt. */
const LEGACY_DELIVERY_HEADER = /^\[Initiative "(.*?)" (?:message from|event[,\]])/;

/** Recognizes a prompt built by formatInitiativeDelivery (or its one-message predecessor). */
export function parseInitiativeDelivery(
  text: string
): { initiativeName: string; count: number } | null {
  const bundled = DELIVERY_HEADER.exec(text);
  if (bundled) return { initiativeName: bundled[1]!, count: Number(bundled[2]) };
  const legacy = LEGACY_DELIVERY_HEADER.exec(text);
  return legacy ? { initiativeName: legacy[1]!, count: 1 } : null;
}
