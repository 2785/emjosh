import { describe, expect, it } from 'vitest';
import { formatInitiativeDelivery, parseInitiativeDelivery } from './delivery';

describe('initiative deliveries', () => {
  it('bundles messages under one recognizable header', () => {
    const text = formatInitiativeDelivery({
      initiativeName: 'Accounts v2',
      entries: [
        { kind: 'done', sender: 'API', fromLead: false, direct: true, body: 'Endpoint shipped.' },
        {
          kind: 'attention',
          sender: 'UI',
          fromLead: false,
          direct: false,
          body: 'Workspace "UI" is waiting for the user to approve something.',
        },
      ],
      quietCount: 3,
    });
    expect(text).toBe(
      '[Initiative "Accounts v2" · 2 updates. From the initiative feed, not directly from the ' +
        'user; weigh it accordingly.]\n\n' +
        '— Workspace "API" · done · to you\nEndpoint shipped.\n\n' +
        '— Emjosh event · attention\nWorkspace "UI" is waiting for the user to approve something.' +
        '\n\n(3 quiet updates (status events, fyi) since the last delivery are in read_messages ' +
        'and list_workspaces.)'
    );
    expect(parseInitiativeDelivery(text)).toEqual({ initiativeName: 'Accounts v2', count: 2 });
  });

  it('recognizes one-message deliveries from before bundling', () => {
    expect(
      parseInitiativeDelivery('[Initiative "X" message from workspace "A". It comes from…]\n\nhi')
    ).toEqual({ initiativeName: 'X', count: 1 });
    expect(
      parseInitiativeDelivery('[Initiative "X" event, delivered to you as its lead.]\n\nA done')
    ).toEqual({ initiativeName: 'X', count: 1 });
  });

  it('ignores what the user typed', () => {
    expect(parseInitiativeDelivery('Initiative "X" · 2 updates')).toBeNull();
    expect(parseInitiativeDelivery('please check [Initiative "X" · 2 updates]')).toBeNull();
  });
});
