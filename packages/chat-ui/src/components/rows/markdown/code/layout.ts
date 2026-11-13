/**
 * layoutCode — pure geometry for a CodeBlock.
 *
 * Moved here from core/layout/layout-code.ts so that layout constants,
 * CSS vars, and the renderer live in the same folder.
 *
 * Constants come from ./metrics (single source of truth).
 * Typography (line height) comes from the FontConfig passed in.
 */

import type { CodeLaidOut } from '@core/layout/layout-types';
import { reserveHeight } from '@core/layout/reserve-height';
import type { CodeBlock } from '@core/markdown/document';
import type { FontConfig } from '@core/measure/fonts';

const CODE_BLOCK_PAD_Y = 8;
const CODE_BLOCK_BORDER = 1;
/** Left padding inside the code card (codeWrapper) plus a little room on the right. */
const CODE_BLOCK_PAD_X = 8 + 8;
/** Columns per tab, matching the browser's default `tab-size`. */
const TAB_SIZE = 8;

export function layoutCode(
  block: CodeBlock,
  fonts: FontConfig,
  blockTop: number,
  effectiveWidth: number,
  wrap = false
): CodeLaidOut {
  const codeLineHeight = fonts.code.lineHeight;
  const rawLines = block.code.split('\n');
  // Monospace: rows per line follow from the column count. A narrow or unmeasured width
  // (0 during estimates) falls back to no wrapping.
  const columns = wrap
    ? Math.floor(
        (effectiveWidth - CODE_BLOCK_PAD_X - 2 * CODE_BLOCK_BORDER) /
          monospaceCharWidth(fonts.code.font)
      )
    : 0;

  let top = CODE_BLOCK_PAD_Y;
  const lines = rawLines.map((text) => {
    const rows = columns > 0 ? Math.max(1, Math.ceil(columnWidth(text) / columns)) : 1;
    const line = { top, text, rows };
    top += rows * codeLineHeight;
    return line;
  });

  const height = reserveHeight({
    content: top - CODE_BLOCK_PAD_Y,
    padY: CODE_BLOCK_PAD_Y,
    border: CODE_BLOCK_BORDER,
  });

  return {
    kind: 'code',
    id: block.id,
    top: blockTop,
    height,
    contentWidth: effectiveWidth,
    lines,
    lang: block.lang,
    wrap: columns > 0,
  };
}

/** Columns a line occupies, expanding tabs to the next tab stop. */
function columnWidth(text: string): number {
  let column = 0;
  for (const char of text)
    column = char === '\t' ? column + TAB_SIZE - (column % TAB_SIZE) : column + 1;
  return column;
}

const charWidths = new Map<string, number>();

/** Width of one character of a monospace font; estimated from its size without a canvas. */
export function monospaceCharWidth(font: string): number {
  const cached = charWidths.get(font);
  if (cached !== undefined) return cached;
  let width = 0;
  if (typeof document !== 'undefined') {
    const context = document.createElement('canvas').getContext('2d');
    if (context) {
      context.font = font;
      width = context.measureText('M'.repeat(100)).width / 100;
    }
  }
  if (!(width > 0)) width = (Number(/(\d+(?:\.\d+)?)px/.exec(font)?.[1]) || 13) * 0.6;
  charWidths.set(font, width);
  return width;
}
