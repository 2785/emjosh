/**
 * layoutTable — pure geometry for a TableBlock.
 *
 * Each column is wide enough for its longest cell. If those intrinsic widths
 * fit, remaining space is distributed across the columns so the table fills
 * its container. Otherwise tableWidth exceeds contentWidth and the wrapper
 * scrolls horizontally without truncating cell content.
 *
 * Height is fully deterministic: cells stay on one line, or, when wrapping, the columns are fitted
 * to the container and each row is as tall as its tallest wrapped cell.
 */

import type { FontConfig } from '@core/config';
import type { TableLaidOut } from '@core/layout/layout-types';
import { reserveHeight } from '@core/layout/reserve-height';
import type { TableBlock } from '@core/markdown/document';
import { layoutProse, measureProseNaturalWidth } from '../prose/layout';
import {
  TABLE_BORDER,
  TABLE_CELL_PAD_X,
  TABLE_CELL_PAD_Y,
  TABLE_MIN_COL_W,
  TABLE_SCROLLBAR_SIZE,
} from './geometry';

function measureCellText(text: string, fonts: FontConfig, header: boolean): number {
  return measureProseNaturalWidth(
    {
      kind: 'prose',
      id: 'table-cell-width',
      variant: 'body',
      runs: text ? [{ kind: 'text', text }] : [],
    },
    header ? { ...fonts, body: fonts.bold } : fonts
  );
}

function measureColumnWidths(block: TableBlock, fonts: FontConfig): number[] {
  const columnCount = Math.max(1, block.header.length);
  return Array.from({ length: columnCount }, (_, columnIndex) => {
    const header = block.header[columnIndex] ?? '';
    let contentWidth = measureCellText(header, fonts, true);
    for (const row of block.rows) {
      contentWidth = Math.max(contentWidth, measureCellText(row[columnIndex] ?? '', fonts, false));
    }
    return Math.max(TABLE_MIN_COL_W, Math.ceil(contentWidth) + 2 * TABLE_CELL_PAD_X + TABLE_BORDER);
  });
}

function fillAvailableWidth(widths: number[], available: number): number[] {
  const naturalWidth = widths.reduce((sum, width) => sum + width, 0);
  const extra = Math.max(0, Math.floor(available - naturalWidth));
  const extraPerColumn = Math.floor(extra / widths.length);
  const remainder = extra % widths.length;
  return widths.map((width, index) => width + extraPerColumn + (index < remainder ? 1 : 0));
}

export function layoutTable(
  block: TableBlock,
  blockTop: number,
  contentWidth: number,
  fonts: FontConfig,
  wrap = false
): TableLaidOut {
  // The table sits inside a bordered wrapper, so column width excludes the two
  // outer borders. Including them would trigger a spurious horizontal scrollbar.
  const available = Math.max(1, contentWidth - 2 * TABLE_BORDER);
  const natural = measureColumnWidths(block, fonts);
  const naturalWidth = natural.reduce((sum, width) => sum + width, 0);
  // Wrapping only changes anything when the table doesn't fit as it is.
  const wrapping = wrap && naturalWidth > available;
  const colWidths = wrapping
    ? fitColumns(natural, available)
    : fillAvailableWidth(natural, available);
  const tableWidth = colWidths.reduce((sum, width) => sum + width, 0);
  // Outer top/bottom borders plus one separator after every row except the last.
  const rowCount = block.rows.length + 1;
  const singleRowHeight = fonts.body.lineHeight + 2 * TABLE_CELL_PAD_Y;
  const content = wrapping
    ? [block.header, ...block.rows].reduce(
        (sum, row, index) => sum + wrappedRowHeight(row, colWidths, fonts, index === 0),
        0
      )
    : rowCount * singleRowHeight;
  const height =
    reserveHeight({
      content,
      border: TABLE_BORDER,
      borderLines: rowCount + 1,
    }) + (tableWidth > available ? TABLE_SCROLLBAR_SIZE : 0);

  return {
    kind: 'table',
    id: block.id,
    top: blockTop,
    height,
    contentWidth: tableWidth,
    colWidths,
    tableWidth,
    header: block.header,
    rows: block.rows,
    wrap: wrapping,
    overflows: naturalWidth > available,
  };
}

/**
 * Column widths that fit `available`: narrow columns keep their natural width and the rest
 * share what's left evenly, never below the minimum (then the table still scrolls).
 */
export function fitColumns(natural: readonly number[], available: number): number[] {
  const widths = natural.map(() => 0);
  let remaining = available;
  let open = natural.map((_, index) => index);
  while (open.length > 0) {
    const share = Math.floor(remaining / open.length);
    const fits = open.filter((index) => natural[index]! <= share);
    if (fits.length === 0) {
      for (const index of open) widths[index] = Math.max(TABLE_MIN_COL_W, share);
      break;
    }
    for (const index of fits) {
      widths[index] = natural[index]!;
      remaining -= natural[index]!;
    }
    open = open.filter((index) => !fits.includes(index));
  }
  return widths;
}

/** A row's height when its cells wrap: its tallest cell plus padding. */
function wrappedRowHeight(
  row: readonly string[],
  colWidths: readonly number[],
  fonts: FontConfig,
  header: boolean
): number {
  const cellFonts = header ? { ...fonts, body: fonts.bold } : fonts;
  let lines = 1;
  colWidths.forEach((width, column) => {
    const text = row[column] ?? '';
    if (!text) return;
    const laid = layoutProse(
      { kind: 'prose', id: 'table-cell', variant: 'body', runs: [{ kind: 'text', text }] },
      Math.max(1, width - 2 * TABLE_CELL_PAD_X - TABLE_BORDER),
      cellFonts,
      0
    );
    lines = Math.max(lines, laid.lines.length);
  });
  return lines * fonts.body.lineHeight + 2 * TABLE_CELL_PAD_Y;
}
