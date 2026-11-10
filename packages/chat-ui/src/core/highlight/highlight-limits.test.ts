import { describe, expect, it } from 'vitest';
import { computeHighlightRaw, MAX_HIGHLIGHT_CHARS } from './highlighter';

describe('highlight limits', () => {
  it('leaves an over-long line plain instead of tokenizing it', () => {
    const line = `const data = ${JSON.stringify(Array.from({ length: 2_000 }, (_, i) => ({ i })))};`;
    const result = computeHighlightRaw(`${line}\nconst x = 1;`, 'typescript');

    expect(result.lines[0]!.map((token) => token.content).join('')).toBe(line);
    expect(result.lines[1]!.length).toBeGreaterThan(1);
  });

  it('does not highlight inputs over the size cap', () => {
    const code = 'x\n'.repeat(MAX_HIGHLIGHT_CHARS / 2 + 1);
    const result = computeHighlightRaw(code, 'typescript');

    expect(result.lines.every((line) => line.length === 1 && !line[0]!.htmlStyle)).toBe(true);
  });
});
