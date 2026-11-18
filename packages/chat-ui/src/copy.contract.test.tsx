import { afterEach, describe, expect, it } from 'vitest';
import { createChatContext } from '@/chat-context';
import { createChatView } from '@/chat-view';
import type { TranscriptTurn } from '@/model';
import { createChatState } from '@/state/chat-state';

const paint = () =>
  new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  );
const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function mount(text: string) {
  const context = createChatContext();
  const state = createChatState(context, { uri: 'copy' });
  const turn: TranscriptTurn = {
    id: 'turn',
    seq: 0,
    initiator: 'agent',
    items: [{ kind: 'message', id: 'message', seq: 0, role: 'assistant', text }],
  };
  state.transcript.history.seed([turn]);
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;top:0;left:0;width:800px;height:600px;';
  document.body.append(host);
  const view = createChatView({ context, state, parent: host });
  cleanups.push(() => {
    view.dispose();
    state.dispose();
    context.dispose();
    host.remove();
  });
  return host;
}

function copySelection(host: HTMLElement): DataTransfer {
  const data = new DataTransfer();
  host
    .querySelector('[data-chat-scroll]')!
    .dispatchEvent(new ClipboardEvent('copy', { clipboardData: data, bubbles: true }));
  return data;
}

describe('copying from the chat', () => {
  it('copies a selection across blocks as markdown and HTML', async () => {
    const host = mount('Intro with **bold**.\n\n- first\n- second\n\n```sh\nls -la\n```');
    await paint();
    const blocks = host.querySelectorAll<HTMLElement>('[data-block-id^="message#"]');
    expect(blocks.length).toBeGreaterThanOrEqual(3);
    const range = document.createRange();
    range.setStart(blocks[0]!, 0);
    range.setEnd(blocks[blocks.length - 1]!, blocks[blocks.length - 1]!.childNodes.length);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(range);

    const data = copySelection(host);

    expect(data.getData('text/plain')).toBe(
      'Intro with **bold**.\n\n- first\n- second\n\n```sh\nls -la\n```'
    );
    expect(data.getData('text/html')).toBe(
      '<p>Intro with <strong>bold</strong>.</p><ul><li>first</li><li>second</li></ul>' +
        '<pre><code>ls -la</code></pre>'
    );
  });

  it('leaves a selection within one block to the browser', async () => {
    const host = mount('Just one paragraph here.\n\nAnd another.');
    await paint();
    const first = host.querySelector<HTMLElement>('[data-block-id="message#0"]')!;
    const range = document.createRange();
    range.selectNodeContents(first);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(range);

    expect(copySelection(host).getData('text/plain')).toBe('');
  });
});
