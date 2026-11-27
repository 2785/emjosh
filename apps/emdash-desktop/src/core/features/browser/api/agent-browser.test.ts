import { describe, expect, it } from 'vitest';
import {
  agentFocusScript,
  agentKeyEvent,
  agentLocateScript,
  assertAgentRef,
  formatAgentSnapshot,
  normalizeAgentUrl,
  truncateAgentText,
} from './agent-browser';

describe('normalizeAgentUrl', () => {
  it('accepts http(s) pages and adds a scheme to bare hosts', () => {
    expect(normalizeAgentUrl('https://example.com/a?b=1')).toBe('https://example.com/a?b=1');
    expect(normalizeAgentUrl('example.com')).toMatch(/^https?:\/\/example\.com\/?$/);
  });

  it('rejects local files and custom schemes', () => {
    expect(() => normalizeAgentUrl('file:///etc/passwd')).toThrow();
    expect(() => normalizeAgentUrl('chrome://settings')).toThrow();
    expect(() => normalizeAgentUrl('javascript:alert(1)')).toThrow();
    expect(() => normalizeAgentUrl('')).toThrow();
  });
});

describe('element refs', () => {
  it('only accepts refs the snapshot hands out, so they cannot inject into page scripts', () => {
    expect(assertAgentRef('e12')).toBe('e12');
    for (const bad of ['', 'e', '12', 'e1"]);alert(1);//', 'e1 e2', 'E1', 'e1234567']) {
      expect(() => assertAgentRef(bad)).toThrow(/isn't an element ref/);
    }
    expect(() => agentLocateScript('x"]')).toThrow();
    expect(() => agentFocusScript('x"]', false)).toThrow();
    expect(agentLocateScript('e3')).toContain('[data-emjosh-ref="e3"]');
  });
});

describe('agentKeyEvent', () => {
  it('maps named keys and single characters', () => {
    expect(agentKeyEvent('Enter')).toMatchObject({
      key: 'Enter',
      windowsVirtualKeyCode: 13,
      text: '\r',
    });
    expect(agentKeyEvent('ArrowDown').windowsVirtualKeyCode).toBe(40);
    expect(agentKeyEvent('a')).toMatchObject({
      key: 'a',
      code: 'KeyA',
      windowsVirtualKeyCode: 65,
      text: 'a',
    });
    expect(agentKeyEvent('7')).toMatchObject({ code: 'Digit7', windowsVirtualKeyCode: 55 });
  });

  it('rejects unknown key names with the valid ones', () => {
    expect(() => agentKeyEvent('Hyper')).toThrow(/Unknown key "Hyper".*Enter/);
  });
});

describe('text limits', () => {
  it('truncates long text and says how much was cut', () => {
    expect(truncateAgentText('abc', 10)).toBe('abc');
    expect(truncateAgentText('abcdefghij', 4)).toBe('abcd\n… [truncated 6 characters]');
  });

  it('formats a snapshot under a page header', () => {
    expect(
      formatAgentSnapshot({
        url: 'https://x.test/',
        title: 'X',
        lines: ['heading(1) "Hi"', '[e1] link "Go"'],
      })
    ).toBe('Page: "X" https://x.test/\nheading(1) "Hi"\n[e1] link "Go"');
    expect(formatAgentSnapshot({ url: 'u', title: '', lines: [] })).toContain(
      '(no visible content)'
    );
  });
});
