import { describe, expect, it } from 'vitest';
import { parseWorkspaceLink, workspaceLink } from './workspace-search';

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
