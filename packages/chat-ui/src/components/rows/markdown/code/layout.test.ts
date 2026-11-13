import { DEFAULT_FONT_CONFIG } from '@core/measure/fonts';
import { describe, expect, it } from 'vitest';
import { layoutCode, monospaceCharWidth } from './layout';

describe('layoutCode', () => {
  const block = (code: string) => ({ kind: 'code' as const, id: 'm#0', code });
  const lineHeight = DEFAULT_FONT_CONFIG.code.lineHeight;
  const charWidth = monospaceCharWidth(DEFAULT_FONT_CONFIG.code.font);
  // Room for exactly 40 columns inside the card's padding and border.
  const width = 40 * charWidth + 16 + 2;

  it('keeps one row per line without wrapping', () => {
    const laid = layoutCode(block(`${'x'.repeat(100)}\nshort`), DEFAULT_FONT_CONFIG, 0, width);
    expect(laid.wrap).toBe(false);
    expect(laid.lines.map((line) => line.rows)).toEqual([1, 1]);
  });

  it('reserves a row for each wrapped segment when wrapping', () => {
    const unwrapped = layoutCode(block(`${'x'.repeat(100)}\nshort`), DEFAULT_FONT_CONFIG, 0, width);
    const laid = layoutCode(
      block(`${'x'.repeat(100)}\nshort\n\tx`),
      DEFAULT_FONT_CONFIG,
      0,
      width,
      true
    );
    expect(laid.wrap).toBe(true);
    expect(laid.lines.map((line) => line.rows)).toEqual([3, 1, 1]);
    expect(laid.lines.map((line) => line.top)).toEqual([8, 8 + 3 * lineHeight, 8 + 4 * lineHeight]);
    expect(laid.height - unwrapped.height).toBe(3 * lineHeight);
  });
});
