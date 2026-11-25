import { describe, expect, it } from 'vitest';
import {
  ASK_SYSTEM_PROMPT,
  buildAskPrompt,
  findSnippets,
  parseAskResponse,
  snippetTerms,
} from './workspace-search-agent';

const known = new Set(['w1', 'w2']);

describe('parseAskResponse', () => {
  it('parses plain JSON and keeps known ids only', () => {
    const parsed = parseAskResponse(
      JSON.stringify({
        answer: 'It is w1.',
        workspaces: [{ id: 'w1', why: 'owns the MR' }, { id: 'nope' }, 'w2', { id: 'w1' }],
      }),
      known
    );
    expect(parsed).toEqual({
      answer: 'It is w1.',
      workspaces: [
        { id: 'w1', why: 'owns the MR' },
        { id: 'w2', why: null },
      ],
    });
  });

  it('tolerates code fences and surrounding text', () => {
    const parsed = parseAskResponse(
      'Sure:\n```json\n{"answer":"A","workspaces":[{"id":"w2","why":"x"}]}\n```',
      known
    );
    expect(parsed.workspaces).toEqual([{ id: 'w2', why: 'x' }]);
  });

  it('falls back to the raw text when the reply is not JSON', () => {
    expect(parseAskResponse('I could not tell.', known)).toEqual({
      answer: 'I could not tell.',
      workspaces: [],
    });
  });

  it('caps the list at five workspaces', () => {
    const many = new Set(['a', 'b', 'c', 'd', 'e', 'f']);
    const reply = JSON.stringify({ answer: 'x', workspaces: [...many].map((id) => ({ id })) });
    expect(parseAskResponse(reply, many).workspaces).toHaveLength(5);
  });
});

describe('snippets', () => {
  it('uses the MR path for URLs and the number otherwise', () => {
    expect(snippetTerms('https://gitlab.com/g/r/-/merge_requests/5799/diffs')).toEqual([
      'g/r/-/merge_requests/5799',
    ]);
    expect(snippetTerms('!12')).toEqual(['merge_requests/12', 'pull/12']);
  });

  it('finds passages around terms and merges nearby ones', () => {
    const text = `${'x'.repeat(500)} see merge_requests/5799 and also merge_requests/5799 again ${'y'.repeat(500)}`;
    const snippets = findSnippets(text, ['merge_requests/5799']);
    expect(snippets).toHaveLength(1);
    expect(snippets[0]).toContain('see merge_requests/5799 and also');
    expect(snippets[0]!.length).toBeLessThan(500);
  });

  it('builds a prompt naming workspaces and passages', () => {
    const prompt = buildAskPrompt({
      query: 'recon',
      workspaces: [
        {
          id: 'w1',
          name: 'Recon fix',
          projectId: 'p',
          projectName: 'pre',
          initiativeId: null,
          initiativeName: null,
          branch: 'b',
          archived: true,
          agentStatus: null,
          markedDone: false,
          lastActivityAt: null,
          pullRequest: null,
        },
      ],
      snippets: [{ workspaceId: 'w1', source: 'chat', text: 'talked about recon' }],
    });
    expect(prompt).toContain('w1 | "Recon fix" | project pre | branch b | archived');
    expect(prompt).toContain('[chat of w1 "Recon fix"] talked about recon');
  });

  it('asks for several ranked matches, biased to active workspaces', () => {
    expect(ASK_SYSTEM_PROMPT).toContain('at most 5');
    expect(ASK_SYSTEM_PROMPT).toContain('Prefer recent and active');
  });
});
