import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeliveryCoalescer } from './delivery-coalescer';

describe('DeliveryCoalescer', () => {
  let flushed: [string, string[]][];
  let busy: Set<string>;
  let coalescer: DeliveryCoalescer<string>;

  beforeEach(() => {
    vi.useFakeTimers();
    flushed = [];
    busy = new Set();
    coalescer = new DeliveryCoalescer<string>({
      debounceMs: 5_000,
      maxWaitMs: 30_000,
      maxHoldMs: 120_000,
      isBusy: async (key) => busy.has(key),
      flush: async (key, items) => {
        flushed.push([key, items]);
      },
    });
  });

  afterEach(() => {
    coalescer.dispose();
    vi.useRealTimers();
  });

  it('delivers a lone message after the short debounce', async () => {
    coalescer.add('lead', 'done');
    await vi.advanceTimersByTimeAsync(4_999);
    expect(flushed).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(flushed).toEqual([['lead', ['done']]]);
  });

  it('bundles a burst into one delivery per recipient', async () => {
    coalescer.add('lead', 'a');
    await vi.advanceTimersByTimeAsync(3_000);
    coalescer.add('lead', 'b');
    coalescer.add('member', 'x');
    await vi.advanceTimersByTimeAsync(3_000);
    coalescer.add('lead', 'c');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(flushed).toEqual([
      ['member', ['x']],
      ['lead', ['a', 'b', 'c']],
    ]);
  });

  it('does not hold a steady stream past the max wait', async () => {
    for (let second = 0; second < 40; second += 4) {
      coalescer.add('lead', `m${second}`);
      await vi.advanceTimersByTimeAsync(4_000);
    }
    expect(flushed[0]?.[1]).toEqual(['m0', 'm4', 'm8', 'm12', 'm16', 'm20', 'm24', 'm28']);
  });

  it('keeps collecting while the recipient is mid-turn, up to the hold limit', async () => {
    busy.add('lead');
    coalescer.add('lead', 'a');
    await vi.advanceTimersByTimeAsync(20_000);
    coalescer.add('lead', 'b');
    await vi.advanceTimersByTimeAsync(20_000);
    expect(flushed).toEqual([]);
    busy.delete('lead');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(flushed).toEqual([['lead', ['a', 'b']]]);

    busy.add('lead');
    coalescer.add('lead', 'c');
    await vi.advanceTimersByTimeAsync(125_000);
    expect(flushed[1]).toEqual(['lead', ['c']]);
  });
});
