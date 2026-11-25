import type { TranscriptTurn } from '@emdash/chat-ui';
import { describe, expect, it } from 'vitest';
import { formatInitiativeDelivery } from '@core/features/initiatives/api/delivery';
import { collapseInitiativeTurn } from './initiative-turns';

type Item = TranscriptTurn['items'][number];

const message = (id: string, role: 'user' | 'assistant', text: string) =>
  ({ kind: 'message', id, seq: 0, role, text }) as Item;
const toolCall = (id: string) =>
  ({ kind: 'mcp-tool-call', id, toolCallId: id, seq: 0, status: 'done' }) as unknown as Item;
const turn = (...items: Item[]): TranscriptTurn => ({ id: 't', seq: 0, initiator: 'user', items });

const delivery = formatInitiativeDelivery({
  initiativeName: 'Accounts v2',
  entries: [
    { kind: 'done', sender: 'API', fromLead: false, direct: true, body: 'Shipped.' },
    { kind: 'blocked', sender: 'UI', fromLead: false, direct: true, body: 'Need the schema.' },
  ],
});

describe('collapseInitiativeTurn', () => {
  it('groups a delivery turn and keeps the closing reply to the user visible', () => {
    expect(
      collapseInitiativeTurn(
        turn(
          message('p', 'user', delivery),
          toolCall('c1'),
          message('r', 'assistant', 'API shipped; UI waits on the schema. Approve it?')
        )
      )
    ).toEqual({ label: 'Initiative activity (2)', visibleItemId: 'r' });
  });

  it('folds quiet replies, and text that more tool calls followed', () => {
    expect(
      collapseInitiativeTurn(
        turn(message('p', 'user', delivery), toolCall('c1'), message('r', 'assistant', '[quiet]'))
      )?.visibleItemId
    ).toBeNull();
    expect(
      collapseInitiativeTurn(
        turn(message('p', 'user', delivery), message('m', 'assistant', 'Checking.'), toolCall('c1'))
      )?.visibleItemId
    ).toBeNull();
  });

  it("leaves the user's own turns alone", () => {
    expect(
      collapseInitiativeTurn(turn(message('p', 'user', 'How is it going?'), toolCall('c1')))
    ).toBeNull();
  });
});
