import { describe, expect, it } from 'vitest';
import { linesThrough } from './diff-lines';

describe('linesThrough', () => {
  it('keeps the lines up to the given one', () => {
    expect(linesThrough('a\nb\nc\nd', 1)).toBe('a\nb');
    expect(linesThrough('a\nb\nc\nd', 0)).toBe('a');
  });

  it('keeps everything when the text has no more lines, and nothing before line 0', () => {
    expect(linesThrough('a\nb', 5)).toBe('a\nb');
    expect(linesThrough('a\nb', 1)).toBe('a\nb');
    expect(linesThrough('a\nb', -1)).toBe('');
  });
});
