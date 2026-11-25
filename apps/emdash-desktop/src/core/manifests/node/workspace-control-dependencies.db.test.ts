import { openFixture } from '@tooling/utils/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InitiativesService } from '@core/features/initiatives/node/initiatives-service';
import { WorkspaceControlService } from '@core/features/workspace-control/node/workspace-control-service';
import { projects, taskDependencies, tasks } from '@core/services/app-db/node/schema';

const IDS = ['lead', 'api', 'web', 'docs'];

describe('workspace dependencies', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;
  let service: WorkspaceControlService;
  let initiatives: InitiativesService;
  let initiativeId: string;
  const merged = new Set<string>();
  const mergedIntoBase = new Set<string>();
  const lead = { conversationId: 'conv-lead' };
  const api = { conversationId: 'conv-api' };

  beforeEach(async () => {
    merged.clear();
    mergedIntoBase.clear();
    fixture = await openFixture('empty');
    fixture.db.insert(projects).values({ id: 'p', name: 'p' }).run();
    for (const id of IDS) {
      fixture.db
        .insert(tasks)
        .values({ id, projectId: 'p', name: id, status: 'in_progress' })
        .run();
    }
    initiatives = new InitiativesService(fixture.db as never);
    service = new WorkspaceControlService({
      listProjects: async () => [],
      listWorkspaces: async ({ includeArchived }) =>
        fixture.db
          .select()
          .from(tasks)
          .all()
          .filter((task) => includeArchived || task.archivedAt === null)
          .map((task) => ({
            id: task.id,
            name: task.name,
            projectId: task.projectId,
            projectName: 'p',
            branch: task.id,
            archived: task.archivedAt !== null,
            agentStatus: null,
            lastActivityAt: null,
            initiativeId: task.initiativeId,
            markedDone: task.status === 'done',
          })),
      pullRequestForBranch: async (_projectId, branch) =>
        merged.has(branch)
          ? { url: `https://example.com/${branch}`, number: 7, title: branch, state: 'merged' }
          : null,
      branchMergedInto: async (taskId) => (mergedIntoBase.has(taskId) ? 'main' : null),
      setWorkspaceDone: async (taskId, done) => {
        fixture.db
          .update(tasks)
          .set({ status: done ? 'done' : 'in_progress' })
          .where(eq(tasks.id, taskId))
          .run();
      },
      callerContext: async (conversationId) => ({
        taskId: conversationId.replace(/^conv-/, ''),
        provider: 'claude',
      }),
      archiveWorkspace: async () => {},
      restoreWorkspace: async () => {},
      renameWorkspace: async () => {},
      addProject: async () => ({ id: 'x', name: 'x', path: '/x' }),
      cloneProject: async () => ({ id: 'x', name: 'x', path: '/x' }),
      renameProject: async () => {},
      removeProject: async () => {},
      createWorkspace: async () => ({ id: 'x', name: 'x', branch: 'x' }),
      initiatives,
    });
    const created = await service.createInitiative(lead, {
      name: 'Accounts v2',
      leadWorkspaceId: 'lead',
      workspaceIds: ['api', 'web', 'docs'],
    });
    initiativeId = created.initiative.id;
  });

  afterEach(() => fixture?.close());

  const orders = async () =>
    Object.fromEntries(
      (await service.listWorkspaces({})).map((w) => [
        w.id,
        w.dependencyOrder && {
          rank: w.dependencyOrder.rank,
          waitingOn: w.dependencyOrder.waitingOn,
          ...(w.dependencyOrder.inCycle ? { inCycle: true } : {}),
        },
      ])
    );

  const leadEvents = async () =>
    (await service.readMessages(lead, {})).filter((m) => m.kind === 'event').map((m) => m.body);

  it('shows nothing until a dependency is declared, then ranks the initiative', async () => {
    expect(await orders()).toEqual({
      lead: undefined,
      api: undefined,
      web: undefined,
      docs: undefined,
    });

    await service.setWorkspaceDependencies(lead, { workspaceId: 'web', dependsOn: ['api'] });
    const docs = await service.setWorkspaceDependencies(lead, {
      workspaceId: 'docs',
      dependsOn: ['api', 'web'],
    });

    expect(docs.dependencyOrder).toMatchObject({
      rank: 3,
      dependsOn: [
        { workspaceId: 'api', name: 'api', looksDone: null },
        { workspaceId: 'web', name: 'web', looksDone: null },
      ],
    });
    expect(await orders()).toEqual({
      lead: { rank: 1, waitingOn: [] },
      api: { rank: 1, waitingOn: [] },
      web: { rank: 2, waitingOn: ['api'] },
      docs: { rank: 3, waitingOn: ['api', 'web'] },
    });
    expect((await initiatives.get(initiativeId))?.dependencies).toHaveLength(3);

    await service.setWorkspaceDependencies(lead, { workspaceId: 'docs', dependsOn: [] });
    await service.setWorkspaceDependencies(lead, { workspaceId: 'web', dependsOn: [] });
    expect((await orders()).web).toBeUndefined();
  });

  it('rejects cycles, outsiders, and callers other than the lead', async () => {
    await service.setWorkspaceDependencies(lead, { workspaceId: 'web', dependsOn: ['api'] });
    await service.setWorkspaceDependencies(lead, { workspaceId: 'docs', dependsOn: ['web'] });

    await expect(
      service.setWorkspaceDependencies(lead, { workspaceId: 'api', dependsOn: ['docs'] })
    ).rejects.toThrow('dependency cycle: api → docs → web → api');
    await expect(
      service.setWorkspaceDependencies(lead, { workspaceId: 'api', dependsOn: ['api'] })
    ).rejects.toThrow('dependency cycle');
    await expect(
      service.setWorkspaceDependencies(api, { workspaceId: 'api', dependsOn: ['lead'] })
    ).rejects.toThrow('Only the lead');

    await initiatives.setTaskInitiative(['docs'], null);
    await expect(
      service.setWorkspaceDependencies(lead, { workspaceId: 'api', dependsOn: ['docs'] })
    ).rejects.toThrow('Not active workspaces');
  });

  it('shows cycles that exist anyway', async () => {
    fixture.db
      .insert(taskDependencies)
      .values([
        { taskId: 'api', dependsOnTaskId: 'web' },
        { taskId: 'web', dependsOnTaskId: 'api' },
        { taskId: 'docs', dependsOnTaskId: 'web' },
      ])
      .run();

    expect(await orders()).toEqual({
      lead: { rank: 1, waitingOn: [] },
      api: { rank: null, inCycle: true, waitingOn: ['web'] },
      web: { rank: null, inCycle: true, waitingOn: ['api'] },
      docs: { rank: null, waitingOn: ['web'] },
    });
  });

  it('drops dependencies on archived workspaces, on archive and when reading stale data', async () => {
    await service.setWorkspaceDependencies(lead, { workspaceId: 'web', dependsOn: ['api'] });
    await service.setWorkspaceDependencies(lead, { workspaceId: 'docs', dependsOn: ['lead'] });

    await initiatives.removeDependencies(['api']);
    expect(fixture.db.select().from(taskDependencies).all()).toEqual([
      expect.objectContaining({ taskId: 'docs', dependsOnTaskId: 'lead' }),
    ]);

    // Archived without the hook running: the next read drops it.
    fixture.db.update(tasks).set({ archivedAt: '2026-11-25' }).where(eq(tasks.id, 'lead')).run();
    expect((await orders()).docs).toBeUndefined();
    expect(fixture.db.select().from(taskDependencies).all()).toEqual([]);
  });

  it('flags dependencies that look done and tells the lead once, without dropping them', async () => {
    await service.setWorkspaceDependencies(lead, { workspaceId: 'web', dependsOn: ['api'] });
    await service.setWorkspaceDependencies(lead, { workspaceId: 'docs', dependsOn: ['web'] });

    merged.add('api');
    mergedIntoBase.add('web');
    const listed = await service.listWorkspaces({});
    expect(listed.find((w) => w.id === 'web')?.dependencyOrder).toMatchObject({
      dependsOn: [{ workspaceId: 'api', looksDone: 'PR #7 merged' }],
      waitingOn: [],
    });
    expect(listed.find((w) => w.id === 'docs')?.dependencyOrder?.dependsOn).toEqual([
      { workspaceId: 'web', name: 'web', looksDone: 'branch merged into main' },
    ]);
    await service.listWorkspaces({});
    expect(await leadEvents()).toEqual([
      'Workspace "web" depends on "api", which looks done (PR #7 merged). If so, drop the ' +
        'dependency with set_workspace_dependencies.',
      'Workspace "docs" depends on "web", which looks done (branch merged into main). If so, ' +
        'drop the dependency with set_workspace_dependencies.',
    ]);
    expect(fixture.db.select().from(taskDependencies).all()).toHaveLength(2);
  });

  it('lets the lead or the workspace itself mark it done', async () => {
    await service.setWorkspaceDependencies(lead, { workspaceId: 'web', dependsOn: ['api'] });

    await expect(
      service.markWorkspaceDone({ conversationId: 'conv-web' }, { workspaceId: 'api', done: true })
    ).rejects.toThrow('Only the workspace itself');
    await service.markWorkspaceDone(api, { workspaceId: 'api', done: true });

    expect((await orders()).web).toEqual({ rank: 2, waitingOn: [] });
    expect(await leadEvents()).toEqual([
      expect.stringContaining('"web" depends on "api", which looks done (marked done)'),
    ]);

    // Unmarking re-arms the notice.
    await service.markWorkspaceDone(lead, { workspaceId: 'api', done: false });
    expect((await orders()).web).toEqual({ rank: 2, waitingOn: ['api'] });
    await service.markWorkspaceDone(lead, { workspaceId: 'api', done: true });
    expect(await leadEvents()).toHaveLength(2);
  });
});
