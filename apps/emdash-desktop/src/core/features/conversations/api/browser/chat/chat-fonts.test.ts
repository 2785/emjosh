/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CHAT_SANS_FONTS } from './chat-fonts';

describe('chat fonts', () => {
  it('measures text in the fonts the chat is drawn in', () => {
    const css = readFileSync(
      new URL('../../../../../../renderer/index.css', import.meta.url),
      'utf8'
    );
    const declarations = [...css.matchAll(/--chat-font-sans:([^;]+);/g)].map((match) =>
      match[1]!
        .split(',')
        .map((family: string) => family.trim().replace(/^'|'$/g, ''))
        .filter(Boolean)
    );
    expect(declarations.length).toBeGreaterThan(0);
    for (const families of declarations) expect(families).toEqual([...CHAT_SANS_FONTS]);
  });
});
