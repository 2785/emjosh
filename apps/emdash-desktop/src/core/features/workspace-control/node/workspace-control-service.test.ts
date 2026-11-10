import { describe, expect, it, vi } from 'vitest';
import {
  humanizeSlug,
  repositoryName,
  type ControlWorkspace,
  type WorkspaceControlDeps,
  WorkspaceControlService,
} from './workspace-control-service';

function workspace(overrides: Partial<ControlWorkspace>): Omit<ControlWorkspace, 'pullRequest'> {
  return {
    id: 'w1',
    name: 'w1',
    projectId: 'p1',
    projectName: 'api',
    branch: 'w1',
    archived: false,
    agentStatus: null,
    lastActivityAt: null,
    initiativeId: null,
    ...overrides,
  };
}

function setup(rows: Omit<ControlWorkspace, 'pullRequest'>[]) {
  const deps = {
    listProjects: vi.fn(async () => [
      { id: 'p1', name: 'api', path: '/repos/api' },
      { id: 'p2', name: 'web', path: '/repos/web' },
    ]),
    listWorkspaces: vi.fn(async ({ includeArchived }: { includeArchived: boolean }) =>
      includeArchived ? rows : rows.filter((row) => !row.archived)
    ),
    pullRequestForBranch: vi.fn(async (_projectId: string, branch: string) =>
      branch === 'merged-branch'
        ? { url: 'https://example.com/pr/1', title: 'Done', state: 'merged' as const }
        : null
    ),
    callerContext: vi.fn(async (conversationId: string) =>
      conversationId === 'conv-self' ? { taskId: 'self', provider: 'claude' } : null
    ),
    archiveWorkspace: vi.fn(async () => {}),
    renameWorkspace: vi.fn(async () => {}),
    addProject: vi.fn(async (input: { path: string; name: string }) => ({ id: 'new', ...input })),
    cloneProject: vi.fn(async (input: { repositoryUrl: string; name: string }) => ({
      id: 'new',
      name: input.name,
      path: `/repos/${input.name}`,
    })),
    renameProject: vi.fn(async () => {}),
    removeProject: vi.fn(async () => {}),
    createWorkspace: vi.fn(async () => ({ id: 'new', name: 'new', branch: 'new' })),
    onArchived: vi.fn(),
  } satisfies WorkspaceControlDeps;
  return { service: new WorkspaceControlService(deps), deps };
}

describe('WorkspaceControlService', () => {
  it('lists workspaces with their pull request state', async () => {
    const { service } = setup([
      workspace({ id: 'a', branch: 'merged-branch' }),
      workspace({ id: 'b', branch: null }),
    ]);

    const result = await service.listWorkspaces({});

    expect(result.map((w) => [w.id, w.pullRequest?.state ?? null])).toEqual([
      ['a', 'merged'],
      ['b', null],
    ]);
  });

  it('archives requested workspaces but never the caller, missing, or already archived ones', async () => {
    const { service, deps } = setup([
      workspace({ id: 'self', name: 'me' }),
      workspace({ id: 'old', name: 'old', projectId: 'p2' }),
      workspace({ id: 'gone', archived: true }),
    ]);
    const caller = { conversationId: 'conv-self' };

    const result = await service.archiveWorkspaces(caller, ['old', 'self', 'gone', 'nope', 'old']);

    expect(result.archived).toEqual(['old']);
    expect(result.skipped).toEqual([
      { id: 'self', reason: 'is the calling workspace' },
      { id: 'gone', reason: 'already archived' },
      { id: 'nope', reason: 'not found' },
    ]);
    expect(deps.archiveWorkspace).toHaveBeenCalledTimes(1);
    expect(deps.archiveWorkspace).toHaveBeenCalledWith('p2', 'old');
    expect(deps.onArchived).toHaveBeenCalledWith(caller, [{ id: 'old', name: 'old' }]);
  });

  it("creates workspaces with the caller's agent unless one is given", async () => {
    const { service, deps } = setup([]);

    await service.createWorkspace({ conversationId: 'conv-self' }, { projectId: 'p1' });
    await service.createWorkspace(
      { conversationId: null },
      { projectId: 'p1', provider: 'codex', prompt: 'go' }
    );

    expect(deps.createWorkspace).toHaveBeenNthCalledWith(1, {
      projectId: 'p1',
      provider: 'claude',
    });
    expect(deps.createWorkspace).toHaveBeenNthCalledWith(2, {
      projectId: 'p1',
      provider: 'codex',
      prompt: 'go',
    });
  });

  it("names the caller's workspace while it has its placeholder name", async () => {
    const { service, deps } = setup([
      workspace({ id: 'self', name: 'dull-geese-try', projectId: 'p1' }),
      workspace({ id: 'other', name: 'remove-sandbox-expiry', projectId: 'p1' }),
      workspace({ id: 'elsewhere', name: 'fix-login', projectId: 'p2' }),
    ]);

    // Names are for display: written as given, suffixed when a sibling's name collides.
    await expect(
      service.renameWorkspace({ conversationId: 'conv-self' }, { name: 'Remove sandbox expiry' })
    ).resolves.toEqual({ renamed: true, name: 'Remove sandbox expiry 2' });
    expect(deps.renameWorkspace).toHaveBeenCalledWith('p1', 'self', 'Remove sandbox expiry 2');

    await service.renameWorkspace(
      { conversationId: 'conv-self' },
      { name: '  Fix  login: AR/AP 1_1 ' }
    );
    expect(deps.renameWorkspace).toHaveBeenLastCalledWith('p1', 'self', 'Fix login: AR/AP 1_1');
  });

  it('turns branch-style names into words', async () => {
    expect(humanizeSlug('investigate-jit-fund-reversal-subtype')).toBe(
      'Investigate jit fund reversal subtype'
    );
    expect(humanizeSlug('KRAK-1029 SFTP filtering')).toBe('KRAK-1029 SFTP filtering');
    expect(humanizeSlug('Fix login')).toBe('Fix login');

    const { service, deps } = setup([workspace({ id: 'self', name: 'dull-geese-try' })]);
    await service.renameWorkspace({ conversationId: 'conv-self' }, { name: 'fix-login-redirect' });
    expect(deps.renameWorkspace).toHaveBeenCalledWith('p1', 'self', 'Fix login redirect');
  });

  it('keeps a chosen name unless overridden', async () => {
    const { service, deps } = setup([workspace({ id: 'self', name: 'krak-1029-sftp' })]);
    const caller = { conversationId: 'conv-self' };

    await expect(
      service.renameWorkspace(caller, { name: 'something else' })
    ).resolves.toMatchObject({ renamed: false, name: 'krak-1029-sftp' });
    expect(deps.renameWorkspace).not.toHaveBeenCalled();

    await service.renameWorkspace(caller, { name: 'something else', override: true });
    expect(deps.renameWorkspace).toHaveBeenCalledWith('p1', 'self', 'something else');
  });

  it('only renames for callers running in a workspace', async () => {
    const { service } = setup([workspace({ id: 'self', name: 'dull-geese-try' })]);
    await expect(service.renameWorkspace({ conversationId: null }, { name: 'x' })).rejects.toThrow(
      'Only an agent running in an Emjosh workspace'
    );
  });

  it('adds and clones projects, naming them after their directory or repository', async () => {
    const { service, deps } = setup([]);

    await service.addProject({ path: '/repos/payments/' });
    expect(deps.addProject).toHaveBeenCalledWith({ path: '/repos/payments/', name: 'payments' });

    await service.cloneProject({ repositoryUrl: 'git@github.com:org/ledger.git' });
    expect(deps.cloneProject).toHaveBeenCalledWith({
      repositoryUrl: 'git@github.com:org/ledger.git',
      name: 'ledger',
      parentDirectory: undefined,
    });
    expect(repositoryName('https://github.com/org/ui/')).toBe('ui');
  });

  it('renames only projects that exist', async () => {
    const { service, deps } = setup([]);
    await service.renameProject({ projectId: 'p1', name: '  API  ' });
    expect(deps.renameProject).toHaveBeenCalledWith('p1', 'API');
    await expect(service.renameProject({ projectId: 'nope', name: 'x' })).rejects.toThrow(
      'was not found'
    );
  });

  it('removes a project only without open workspaces, unless told, and never its own', async () => {
    const { service, deps } = setup([
      workspace({ id: 'self', projectId: 'p1' }),
      workspace({ id: 'other', projectId: 'p2' }),
    ]);
    const caller = { conversationId: 'conv-self' };

    await expect(
      service.removeProject(caller, { projectId: 'p1', includeWorkspaces: true })
    ).resolves.toMatchObject({ removed: false });
    await expect(service.removeProject(caller, { projectId: 'p2' })).resolves.toMatchObject({
      removed: false,
      reason: expect.stringContaining('1 open workspace'),
    });
    expect(deps.removeProject).not.toHaveBeenCalled();

    await expect(
      service.removeProject(caller, { projectId: 'p2', includeWorkspaces: true })
    ).resolves.toEqual({ removed: true });
    expect(deps.removeProject).toHaveBeenCalledWith('p2');
  });

  it('describes the calling workspace', async () => {
    const { service } = setup([workspace({ id: 'self', name: 'me' })]);

    expect((await service.currentWorkspace({ conversationId: 'conv-self' }))?.name).toBe('me');
    expect(await service.currentWorkspace({ conversationId: null })).toBeNull();
  });
});
