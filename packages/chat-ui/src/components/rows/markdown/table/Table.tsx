/**
 * Table — Solid component rendering a TableLaidOut block.
 *
 * Uses BlockFrame (not MeasuredBlockFrame) because the height is fully
 * determined by the formula in layoutTable — no DOM write-back needed.
 *
 * Pretext-measured column widths are projected through <colgroup> and fixed
 * table layout. Wide tables scroll horizontally inside the wrapper without
 * making the DOM a second source of geometry, or, with Wrap on, wrap their cells
 * within columns fitted to the container (layoutTable measures the wrapped rows).
 *
 * Each cell receives a native `title` attribute so the full content is
 * accessible on hover via the browser tooltip.
 *
 * Geometry-coupled rules (cell padding, font-size, line-height) stay alongside
 * the layout constants so the virtualizer's reserved height matches the DOM.
 */

import { useViewState } from '@components/contexts/ViewStateContext';
import { BlockFrame } from '@components/engine/block-frame';
import { IconCheck, IconCopy, IconWrapText } from '@components/primitives/icons';
import { createClipboard } from '@components/primitives/use-clipboard';
import type { TableLaidOut } from '@core/layout/layout-types';
import { blocksToHtml, blocksToMarkdown } from '@core/markdown/serialize-blocks';
import { For, Show } from 'solid-js';
import { tableWrapKey } from './wrap-key';
import { tableScroll, tdCell, tdCellLastRow, thCell, wrappingCell } from './table-visual.css';
import { pchatTable } from './table.css';
import {
  codeGroup,
  overlayToolbar,
  overlayToolbarButton,
} from '@components/primitives/copy-button.css';

export type TableProps = {
  block: TableLaidOut;
};

export function Table(props: TableProps) {
  const viewState = useViewState();
  const { copied, copyRich } = createClipboard();
  const cellClass = (base: string) => (props.block.wrap ? `${base} ${wrappingCell}` : base);

  const copy = () => {
    const table = [
      {
        kind: 'table' as const,
        id: props.block.id,
        header: props.block.header,
        rows: props.block.rows,
      },
    ];
    copyRich(blocksToMarkdown(table), blocksToHtml(table));
  };

  return (
    <BlockFrame layout={props.block} class={codeGroup}>
      <div class={overlayToolbar}>
        <Show when={viewState && (props.block.overflows || props.block.wrap)}>
          <button
            type="button"
            class={overlayToolbarButton}
            aria-label={props.block.wrap ? 'Stop wrapping' : 'Wrap cells'}
            aria-pressed={props.block.wrap}
            title={props.block.wrap ? 'Stop wrapping' : 'Wrap cells'}
            onClick={() => viewState?.().toggleCollapsed(tableWrapKey(props.block.id))}
          >
            <IconWrapText />
          </button>
        </Show>
        <button
          type="button"
          class={overlayToolbarButton}
          aria-label={copied() ? 'Copy table — copied' : 'Copy table'}
          title="Copy table"
          onClick={copy}
        >
          <Show when={copied()} fallback={<IconCopy />}>
            <IconCheck />
          </Show>
        </button>
      </div>
      <div class={tableScroll}>
        <table
          class={pchatTable}
          style={{ width: `${props.block.tableWidth}px`, 'table-layout': 'fixed' }}
        >
          <colgroup>
            <For each={props.block.colWidths}>{(w) => <col style={{ width: `${w}px` }} />}</For>
          </colgroup>
          <thead>
            <tr>
              <For each={props.block.header}>
                {(cell) => (
                  <th class={cellClass(thCell)} title={cell}>
                    {cell}
                  </th>
                )}
              </For>
            </tr>
          </thead>
          <tbody>
            <For each={props.block.rows}>
              {(row, i) => (
                <tr>
                  <For each={row}>
                    {(cell) => (
                      <td
                        class={cellClass(
                          `${tdCell}${i() === props.block.rows.length - 1 ? ` ${tdCellLastRow}` : ''}`
                        )}
                        title={cell}
                      >
                        {cell}
                      </td>
                    )}
                  </For>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </div>
    </BlockFrame>
  );
}
