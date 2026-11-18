/**
 * Browser contracts for Markdown table overflow.
 *
 * These assertions need Chromium because they compare the table's rendered
 * cell widths with the horizontal scroll viewport.
 */

import { TABLE_BORDER, TABLE_SCROLLBAR_SIZE } from '@components/rows/markdown/table/geometry';
import { DEFAULT_THEME } from '@core/theme';
import { afterEach, describe, expect, it } from 'vitest';
import { createChatContext } from '@/chat-context';
import { createChatView } from '@/chat-view';
import { createChatState } from '@/state/chat-state';

const nextPaint = (): Promise<void> =>
  new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function mountTable(markdown: string): {
  host: HTMLElement;
  context: ReturnType<typeof createChatContext>;
} {
  const context = createChatContext({ theme: DEFAULT_THEME });
  const state = createChatState(context);
  state.transcript.history.seed([
    {
      id: 'turn-1',
      seq: 0,
      initiator: 'agent',
      items: [
        {
          kind: 'message',
          id: 'message-1',
          seq: 0,
          role: 'assistant',
          text: markdown,
        },
      ],
    },
  ]);

  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;top:0;left:0;width:800px;height:500px;';
  document.body.appendChild(host);
  const view = createChatView({ context, state, parent: host });

  cleanups.push(() => {
    view.dispose();
    state.dispose();
    context.dispose();
    host.remove();
  });
  return { host, context };
}

async function waitForFontMeasurement(
  context: ReturnType<typeof createChatContext>
): Promise<void> {
  for (let frame = 0; frame < 20; frame++) {
    if (context.measureEpoch() > 0) {
      await nextPaint();
      return;
    }
    await nextPaint();
  }
  throw new Error('Chat font measurement epoch did not settle');
}

describe('Markdown table overflow', () => {
  it('fills the message width without a scrollbar when the content fits', async () => {
    const { host, context } = mountTable(
      ['| Name | Type |', '| --- | --- |', '| fontSize | number |', '| theme | string |'].join('\n')
    );
    await waitForFontMeasurement(context);

    const table = host.querySelector('table');
    const scrollViewport = table?.parentElement;
    expect(table).not.toBeNull();
    expect(scrollViewport).not.toBeNull();
    expect(scrollViewport!.scrollWidth).toBe(scrollViewport!.clientWidth);
    expect(table!.offsetWidth).toBe(scrollViewport!.clientWidth);
    expect(scrollViewport!.offsetHeight).toBe(table!.offsetHeight + 2 * TABLE_BORDER);
  });

  it('uses horizontal scrolling instead of truncating wide cell content', async () => {
    const { host, context } = mountTable(
      [
        '| Bird | Typical habitat | Diet | Flight ability | Notable attributes |',
        '| --- | --- | --- | --- | --- |',
        '| Bald eagle | Lakes, rivers, and coastal regions | Fish and small mammals | Strong flier | Excellent long-distance vision |',
        '| Emperor penguin | Antarctic sea ice and surrounding waters | Fish, squid, and crustaceans | Flightless | Survives extreme Antarctic winters |',
        '| Hummingbird | Forests, gardens, and meadows | Nectar and insects | Can hover and fly backward | Exceptionally rapid wingbeats |',
        '| Ostrich | African savannas and open woodlands | Plants, seeds, and insects | Flightless | Largest and fastest-running bird |',
      ].join('\n')
    );
    await waitForFontMeasurement(context);

    const table = host.querySelector('table');
    const scrollViewport = table?.parentElement;
    expect(table).not.toBeNull();
    expect(scrollViewport).not.toBeNull();
    expect(scrollViewport!.scrollWidth).toBeGreaterThan(scrollViewport!.clientWidth);
    expect(scrollViewport!.offsetHeight).toBe(
      table!.offsetHeight + 2 * TABLE_BORDER + TABLE_SCROLLBAR_SIZE
    );
    expect(table!.style.tableLayout).toBe('fixed');

    const projectedWidth = Array.from(table!.querySelectorAll('col')).reduce(
      (sum, column) => sum + Number.parseFloat(column.style.width),
      0
    );
    expect(table!.offsetWidth).toBe(projectedWidth);

    for (const cell of table!.querySelectorAll<HTMLElement>('th, td')) {
      expect(cell.scrollWidth, cell.textContent ?? '').toBeLessThanOrEqual(cell.clientWidth);
    }

    scrollViewport!.scrollLeft = scrollViewport!.scrollWidth;
    expect(scrollViewport!.scrollLeft).toBeGreaterThan(0);
  });

  const BIRDS = [
    '| Bird | Typical habitat | Diet | Flight ability | Notable attributes |',
    '| --- | --- | --- | --- | --- |',
    '| Bald eagle | Lakes, rivers, and coastal regions | Fish and small mammals | Strong flier | Excellent long-distance vision |',
    '| Emperor penguin | Antarctic sea ice and surrounding waters | Fish, squid, and crustaceans | Flightless | Survives extreme Antarctic winters |',
    '| Hummingbird | Forests, gardens, and meadows | Nectar and insects | Can hover and fly backward | Exceptionally rapid wingbeats |',
  ].join('\n');

  it('wraps cells within the width when Wrap is on, reserving exactly the wrapped height', async () => {
    const { host, context } = mountTable(BIRDS);
    await waitForFontMeasurement(context);
    const wrap = host.querySelector<HTMLButtonElement>('button[aria-label="Wrap cells"]');
    expect(wrap).not.toBeNull();

    wrap!.click();
    await nextPaint();

    const table = host.querySelector('table')!;
    const scrollViewport = table.parentElement!;
    expect(scrollViewport.scrollWidth).toBe(scrollViewport.clientWidth);
    // The reserved frame matches the rendered table: no clipping, no gap.
    expect(scrollViewport.offsetHeight).toBe(table.offsetHeight + 2 * TABLE_BORDER);
    const firstRow = table.querySelector('tbody tr')!;
    const header = table.querySelector('thead tr')!;
    expect(firstRow.getBoundingClientRect().height).toBeGreaterThan(
      header.getBoundingClientRect().height
    );

    host.querySelector<HTMLButtonElement>('button[aria-label="Stop wrapping"]')!.click();
    await nextPaint();
    const unwrapped = host.querySelector('table')!.parentElement!;
    expect(unwrapped.scrollWidth).toBeGreaterThan(unwrapped.clientWidth);
  });

  it('offers no Wrap button for a table that already fits', async () => {
    const { host, context } = mountTable(
      ['| Name | Type |', '| --- | --- |', '| fontSize | number |'].join('\n')
    );
    await waitForFontMeasurement(context);
    expect(host.querySelector('button[aria-label="Wrap cells"]')).toBeNull();
    expect(host.querySelector('button[aria-label="Copy table"]')).not.toBeNull();
  });

  it('copies the table as markdown and HTML', async () => {
    const written: Record<string, string>[] = [];
    const original = navigator.clipboard.write;
    Object.defineProperty(navigator.clipboard, 'write', {
      configurable: true,
      value: async (items: ClipboardItem[]) => {
        for (const item of items) {
          written.push({
            text: await (await item.getType('text/plain')).text(),
            html: await (await item.getType('text/html')).text(),
          });
        }
      },
    });
    try {
      const { host, context } = mountTable(
        ['| Name | Type |', '| --- | --- |', '| fontSize | number |'].join('\n')
      );
      await waitForFontMeasurement(context);
      host.querySelector<HTMLButtonElement>('button[aria-label="Copy table"]')!.click();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(written).toEqual([
        {
          text: '| Name | Type |\n| --- | --- |\n| fontSize | number |',
          html: '<table><thead><tr><th>Name</th><th>Type</th></tr></thead><tbody><tr><td>fontSize</td><td>number</td></tr></tbody></table>',
        },
      ]);
    } finally {
      Object.defineProperty(navigator.clipboard, 'write', { configurable: true, value: original });
    }
  });
});
