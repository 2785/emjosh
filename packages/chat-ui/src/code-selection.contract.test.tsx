/**
 * Browser contract for copying part of a code block: lines keep their newlines.
 */

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
  window.getSelection()?.removeAllRanges();
});

function mount(markdown: string): HTMLElement {
  const context = createChatContext({ theme: DEFAULT_THEME });
  const state = createChatState(context);
  state.transcript.history.seed([
    {
      id: 'turn-1',
      seq: 0,
      initiator: 'agent',
      items: [{ kind: 'message', id: 'message-1', seq: 0, role: 'assistant', text: markdown }],
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
  return host;
}

function copySelection(target: Element): string {
  const clipboardData = new DataTransfer();
  target.dispatchEvent(new ClipboardEvent('copy', { clipboardData, bubbles: true }));
  return clipboardData.getData('text/plain');
}

describe('copying from a code block', () => {
  it('keeps newlines between the selected lines, including blank ones', async () => {
    const host = mount('```sql\nBEGIN;\n\nUPDATE bank\nSET x = 1;\n```');
    await nextPaint();
    const lines = [...host.querySelectorAll('[data-code-line]')];
    expect(lines.map((line) => line.textContent)).toEqual([
      'BEGIN;',
      '',
      'UPDATE bank',
      'SET x = 1;',
    ]);

    const range = document.createRange();
    range.setStart(lines[0]!.firstChild!, 2);
    range.setEnd(lines[3]!.firstChild!, 3);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);

    expect(copySelection(lines[0]!)).toBe('GIN;\n\nUPDATE bank\nSET');
  });
});
