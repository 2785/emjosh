import { describe, expect, it } from 'vitest';
import { isRestorable } from './window-state';

const laptop = { x: 0, y: 25, width: 1512, height: 920 };
const external = { x: 1512, y: -400, width: 2560, height: 1415 };
const state = (x: number, y: number) => ({
  bounds: { x, y, width: 1200, height: 800 },
  maximized: false,
  fullScreen: false,
});

describe('isRestorable', () => {
  it('accepts bounds on a connected display', () => {
    expect(isRestorable(state(100, 100), [laptop])).toBe(true);
    expect(isRestorable(state(2000, -300), [laptop, external])).toBe(true);
  });

  it('rejects bounds on a display that is gone', () => {
    expect(isRestorable(state(2000, -300), [laptop])).toBe(false);
  });

  it('rejects a title bar above or barely on every display', () => {
    expect(isRestorable(state(100, 0), [laptop])).toBe(false);
    expect(isRestorable(state(1450, 100), [laptop])).toBe(false);
  });

  it('rejects malformed state', () => {
    expect(isRestorable(null, [laptop])).toBe(false);
    expect(isRestorable({ bounds: { x: 0, y: 30 } }, [laptop])).toBe(false);
  });
});
