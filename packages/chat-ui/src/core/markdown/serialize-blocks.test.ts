/** @vitest-environment jsdom */
import { describe, expect, it } from 'vitest';
import { parseMarkdownToBlocks } from './parse';
import { blocksToHtml, blocksToMarkdown } from './serialize-blocks';

const source = [
  '## Plan',
  '',
  'Ship **bold** and *soft* with `code` and a [link](https://example.com).',
  '',
  '- one',
  '- two',
  '  - nested',
  '',
  '1. first',
  '2. second',
  '',
  '```ts',
  'const x = 1;',
  '```',
  '',
  '| a | b |',
  '| --- | --- |',
  '| 1 | 2 |',
].join('\n');

describe('serialize blocks', () => {
  const blocks = parseMarkdownToBlocks('m1', source);

  it('writes markdown that keeps the structure', () => {
    expect(blocksToMarkdown(blocks)).toBe(
      [
        '## Plan',
        '',
        'Ship **bold** and *soft* with `code` and a [link](https://example.com).',
        '',
        '- one',
        '- two',
        '  - nested',
        '',
        '1. first',
        '2. second',
        '',
        '```ts',
        'const x = 1;',
        '```',
        '',
        '| a | b |',
        '| --- | --- |',
        '| 1 | 2 |',
      ].join('\n')
    );
  });

  it('writes semantic HTML', () => {
    expect(blocksToHtml(blocks)).toBe(
      '<h2>Plan</h2>' +
        '<p>Ship <strong>bold</strong> and <em>soft</em> with <code>code</code> and a <a href="https://example.com">link</a>.</p>' +
        '<ul><li>one</li><li>two</li><ul><li>nested</li></ul></ul>' +
        '<ol><li>first</li><li>second</li></ol>' +
        '<pre><code>const x = 1;</code></pre>' +
        '<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>'
    );
  });
});
