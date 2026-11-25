import { describe, expect, it } from 'vitest';
import { isFreeTextQuery, parseWorkspaceLink, workspaceLink } from './workspace-search';

describe('workspace links', () => {
  it('round-trips ids', () => {
    expect(parseWorkspaceLink(workspaceLink('3f2c-aa'))).toBe('3f2c-aa');
    expect(parseWorkspaceLink('emjosh://workspace/3f2c-aa')).toBe('3f2c-aa');
  });

  it('ignores trailing path, query and fragment, and scheme case', () => {
    expect(parseWorkspaceLink('EMJOSH://workspace/abc/extra?x=1#y')).toBe('abc');
  });

  it('rejects other hrefs and empty ids', () => {
    expect(parseWorkspaceLink('https://example.com/workspace/abc')).toBeNull();
    expect(parseWorkspaceLink('emjosh://workspace/')).toBeNull();
    expect(parseWorkspaceLink('emjosh://workspace/%E0%A4%A')).toBeNull();
    expect(parseWorkspaceLink('src/app.ts')).toBeNull();
  });
});

describe('isFreeTextQuery', () => {
  it('treats URLs, PR refs, tickets and longer descriptions as free text', () => {
    for (const text of [
      'https://gitlab.com/g/r/-/merge_requests/1',
      '!5799',
      'PR #12',
      'KRAK-123',
      'the one fixing recon',
    ]) {
      expect(isFreeTextQuery(text)).toBe(true);
    }
  });

  it('leaves short names and commands alone', () => {
    for (const text of ['settings', 'new task', 'recon', '5799']) {
      expect(isFreeTextQuery(text)).toBe(false);
    }
  });
});
