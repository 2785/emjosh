/**
 * @vitest-environment jsdom
 */
import type { MeasureCtx } from '@core/define';
import { describe, expect, it } from 'vitest';
import type { ChatThinking } from '@/model';
import { THINKING_VARS, thinkingUnitDef } from './thinking.def';

const ctx = {
  theme: { fonts: { body: { lineHeight: 20 } } },
  expanded: () => false,
} as unknown as MeasureCtx;

function thinking(text: string, status: ChatThinking['status']): ChatThinking {
  return { kind: 'thinking', id: 't1', seq: 0, text, status, startedAt: 0 } as ChatThinking;
}

function estimate(item: ChatThinking): number {
  return thinkingUnitDef.estimate?.(item, ctx, THINKING_VARS) ?? Number.NaN;
}

describe('thinking preview height', () => {
  const header = estimate(thinking('', 'done'));

  it('lets a long live thought use up to the window height instead of three lines', () => {
    const extra = estimate(thinking('x'.repeat(4000), 'thinking')) - header;

    expect(extra).toBe(THINKING_VARS.windowH);
    expect(THINKING_VARS.windowH).toBeGreaterThan(150);
  });

  it('shrinks the window to fit a short live thought', () => {
    const extra = estimate(thinking('x'.repeat(30), 'thinking')) - header;

    expect(extra).toBe(2 * THINKING_VARS.padY + 20);
  });
});
