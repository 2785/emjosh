import { describe, expect, it, vi } from 'vitest';
import { WorkspaceSearchService, type WorkspaceSearchDeps } from './workspace-search-service';

const MR = 'https://gitlab.com/g/r/-/merge_requests/5799';

function deps(overrides: Partial<WorkspaceSearchDeps> = {}): WorkspaceSearchDeps {
  const row = (id: string, name: string) => ({
    id,
    name,
    projectId: 'p',
    projectName: 'proj',
    branch: `branch-${id}`,
    archived: false,
    agentStatus: null,
    lastActivityAt: null,
    initiativeId: null,
  });
  return {
    listWorkspaces: async () => [row('w1', 'Owner'), row('w2', 'Lead')],
    pullRequestForBranch: async (_p, branch) =>
      branch === 'branch-w1' ? { url: MR, number: 5799, title: 'T', state: 'open' } : null,
    initiativeNames: async () => new Map(),
    initiativeMessages: async () => [{ fromTaskId: 'w2', body: `please review ${MR} soon` }],
    transcriptFiles: async () => [
      { workspaceId: 'w1', path: 'one' },
      { workspaceId: 'w2', path: 'two' },
    ],
    readTranscript: async (path) =>
      Buffer.from(path === 'two' ? `reviewed ${MR}/diffs` : 'nothing here'),
    ...overrides,
  };
}

describe('WorkspaceSearchService', () => {
  it('ranks the PR owner first and lists chats mentioning the PR', async () => {
    const result = await new WorkspaceSearchService(deps()).search(MR);
    expect(result.hits.map((hit) => hit.workspace.id)).toEqual(['w1', 'w2']);
    expect(result.hits[1]!.reasons).toEqual(['mentioned in its chat']);
  });

  it('does not match a PR number inside a longer number', async () => {
    const result = await new WorkspaceSearchService(
      deps({ readTranscript: async () => Buffer.from('see merge_requests/57991') })
    ).search('!5799');
    expect(result.hits.map((hit) => hit.workspace.id)).toEqual(['w1']);
  });

  it('asks the model with feed and chat passages and resolves its workspaces', async () => {
    const runModel = vi.fn(async () =>
      JSON.stringify({
        answer: 'w1 owns it',
        workspaces: [{ id: 'w1', why: 'owns MR' }, { id: 'zz' }],
      })
    );
    const service = new WorkspaceSearchService(deps({ runModel }));
    const answer = await service.ask(MR);
    expect(answer.answer).toBe('w1 owns it');
    expect(answer.workspaces.map((w) => [w.id, w.why, w.name])).toEqual([
      ['w1', 'owns MR', 'Owner'],
    ]);
    const [{ prompt, system }] = runModel.mock.calls[0] as unknown as [
      { prompt: string; system: string },
    ];
    expect(system).toContain('Reply with JSON only');
    expect(prompt).toContain('[feed of w2 "Lead"]');
    expect(prompt).toContain('[chat of w2 "Lead"]');
  });

  it('refuses to ask without a model', async () => {
    await expect(new WorkspaceSearchService(deps()).ask('x')).rejects.toThrow(/Claude Code/);
  });
});
