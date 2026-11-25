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

  it('reports real steps while a run goes and returns several ranked workspaces', async () => {
    let release: (reply: string) => void = () => {};
    const runModel = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
        })
    );
    const service = new WorkspaceSearchService(deps({ runModel }));
    const runId = service.startAsk(MR);
    await vi.waitFor(() => expect(service.askStatus(runId).step).toBe('Asking the model…'));
    const running = service.askStatus(runId);
    expect(running.state).toBe('running');
    expect(running.completed).toEqual([
      'Collecting candidate workspaces…',
      expect.stringContaining('Searching initiative feeds'),
      expect.stringContaining('Searching chat transcripts'),
    ]);
    release(
      JSON.stringify({
        answer: 'Two candidates',
        workspaces: [
          { id: 'w1', why: 'owns the MR' },
          { id: 'w2', why: 'reviewed it' },
        ],
      })
    );
    await vi.waitFor(() => expect(service.askStatus(runId).state).toBe('done'));
    expect(service.askStatus(runId).result?.workspaces.map((w) => w.id)).toEqual(['w1', 'w2']);
  });

  it('cancels a run and aborts the model call', async () => {
    let signal: AbortSignal | undefined;
    const runModel = vi.fn(
      (input: { signal?: AbortSignal }) =>
        new Promise<string>((_resolve, reject) => {
          signal = input.signal;
          input.signal?.addEventListener('abort', () => reject(new Error('Cancelled.')));
        })
    );
    const service = new WorkspaceSearchService(deps({ runModel }));
    const runId = service.startAsk(MR);
    await vi.waitFor(() => expect(runModel).toHaveBeenCalled());
    service.cancelAsk(runId);
    expect(signal?.aborted).toBe(true);
    expect(service.askStatus(runId).state).toBe('cancelled');
  });

  it('feeds active workspaces to the model before archived ones', async () => {
    const row = (id: string, archived: boolean, lastActivityAt: string) => ({
      id,
      name: `Name ${id}`,
      projectId: 'p',
      projectName: 'proj',
      branch: null,
      archived,
      agentStatus: null,
      lastActivityAt,
      initiativeId: null,
    });
    const runModel = vi.fn(async () => '{"answer":"x","workspaces":[]}');
    await new WorkspaceSearchService(
      deps({
        runModel,
        pullRequestForBranch: async () => null,
        listWorkspaces: async () => [
          row('arch', true, '2026-11-24'),
          row('old', false, '2026-01-01'),
          row('new', false, '2026-11-01'),
        ],
      })
    ).ask('something unrelated here');
    const [{ prompt }] = runModel.mock.calls[0] as unknown as [{ prompt: string }];
    expect(prompt.indexOf('new |')).toBeGreaterThan(-1);
    expect(prompt.indexOf('Name new')).toBeLessThan(prompt.indexOf('Name old'));
    expect(prompt.indexOf('Name old')).toBeLessThan(prompt.indexOf('Name arch'));
  });
});
