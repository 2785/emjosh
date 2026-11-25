import { describe, expect, it } from 'vitest';
import type { InitiativeMessage } from '@core/features/initiatives/api/contract';
import { describeAgentEvent } from './agent-events';
import { messageWakesTask } from './initiatives-service';

type Message = Pick<InitiativeMessage, 'kind' | 'fromTaskId' | 'toTaskId'>;
const LEAD = 'lead';
const wakes = (message: Message, taskId: string) => messageWakesTask(message, taskId, LEAD);

describe('messageWakesTask', () => {
  it('wakes the lead for done, blocked and decision addressed to it', () => {
    for (const kind of ['done', 'blocked', 'decision'] as const) {
      expect(wakes({ kind, fromTaskId: 'a', toTaskId: LEAD }, LEAD)).toBe(true);
      expect(wakes({ kind, fromTaskId: 'a', toTaskId: null }, LEAD)).toBe(true);
      // The lead sees messages between members, but they aren't for it.
      expect(wakes({ kind, fromTaskId: 'a', toTaskId: 'b' }, LEAD)).toBe(false);
    }
  });

  it('keeps fyi and status events quiet for the lead', () => {
    expect(wakes({ kind: 'fyi', fromTaskId: 'a', toTaskId: LEAD }, LEAD)).toBe(false);
    expect(wakes({ kind: 'event', fromTaskId: 'a', toTaskId: null }, LEAD)).toBe(false);
    expect(wakes({ kind: 'event', fromTaskId: null, toTaskId: LEAD }, LEAD)).toBe(false);
  });

  it('wakes on attention events, such as an agent waiting for approval', () => {
    expect(wakes({ kind: 'attention', fromTaskId: 'a', toTaskId: null }, LEAD)).toBe(true);
    expect(wakes({ kind: 'attention', fromTaskId: 'a', toTaskId: null }, 'b')).toBe(true);
  });

  it("always wakes for the user's posts", () => {
    expect(wakes({ kind: 'fyi', fromTaskId: null, toTaskId: null }, LEAD)).toBe(true);
    expect(wakes({ kind: 'fyi', fromTaskId: null, toTaskId: null }, 'a')).toBe(true);
  });

  it('wakes members for direct messages and for broadcasts marked as needing action', () => {
    expect(wakes({ kind: 'fyi', fromTaskId: LEAD, toTaskId: 'a' }, 'a')).toBe(true);
    expect(wakes({ kind: 'fyi', fromTaskId: LEAD, toTaskId: null }, 'a')).toBe(false);
    expect(wakes({ kind: 'decision', fromTaskId: LEAD, toTaskId: null }, 'a')).toBe(true);
    expect(wakes({ kind: 'event', fromTaskId: 'b', toTaskId: null }, 'a')).toBe(false);
  });
});

describe('describeAgentEvent', () => {
  it('makes a finished turn a status event and a pending approval or error an attention one', () => {
    expect(describeAgentEvent({ type: 'stop' })).toEqual({
      kind: 'event',
      what: 'finished its turn',
    });
    expect(
      describeAgentEvent({
        type: 'notification',
        payload: { notificationType: 'permission_prompt' },
      })
    ).toEqual({ kind: 'attention', what: 'is waiting for the user to approve something' });
    expect(describeAgentEvent({ type: 'error' })?.kind).toBe('attention');
    expect(describeAgentEvent({ type: 'notification', payload: {} })).toBeNull();
  });
});
