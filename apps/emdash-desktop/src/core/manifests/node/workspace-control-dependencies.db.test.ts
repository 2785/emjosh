import { openFixture } from '@tooling/utils/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isInitiativeEvent } from '@core/features/initiatives/api/contract';
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
  /** "web>api": web's branch contains api's work. */
  const contains = new Set<string>();
  /** Workspaces with uncommitted changes, and what each agent chat was sent. */
  const dirty = new Set<string>();
  const chats = new Map<string, string[]>();
  /** Workspaces whose agent answers a handoff request (by calling handoff_summary). */
  const answering = new Set<string>();
  /** Workspaces whose worktree is mid-rebase. */
  const rebasing = new Set<string>();
  const lead = { conversationId: 'conv-lead' };
  const api = { conversationId: 'conv-api' };

  beforeEach(async () => {
    merged.clear();
    mergedIntoBase.clear();
    contains.clear();
    dirty.clear();
    chats.clear();
    answering.clear();
    rebasing.clear();
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
      workspaceTip: async (taskId) => ({
        projectId: 'p',
        path: '/repo',
        sha: taskId,
        workedOn: taskId !== 'lead',
        unsettled: rebasing.has(taskId) ? 'mid-rebase' : null,
      }),
      isAncestor: async (_cwd, ancestor, descendant) =>
        ancestor === descendant || contains.has(`${descendant}>${ancestor}`),
      uncommittedChanges: async (taskId) => (dirty.has(taskId) ? [' M src/app.ts'] : []),
      commitLog: async (taskId) => [`abc1234 Add ${taskId} endpoint`],
      sendToWorkspaceChat: async (taskId, text) => {
        chats.set(taskId, [...(chats.get(taskId) ?? []), text]);
        if (answering.has(taskId) && text.includes('handoff_summary')) {
          setTimeout(() => {
            void service.submitHandoff(
              { conversationId: `conv-${taskId}` },
              { text: `${taskId}: added the endpoint; open: docs.` }
            );
          }, 0);
        }
        return taskId !== 'docs';
      },
      handoffTimeoutMs: 50,
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
      archiveWorkspace: async (_projectId, taskId) => {
        fixture.db
          .update(tasks)
          .set({ archivedAt: '2026-11-25' })
          .where(eq(tasks.id, taskId))
          .run();
      },
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
    (await service.readMessages(lead, {}))
      .filter((m) => isInitiativeEvent(m.kind))
      .map((m) => m.body);

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
    // Only workspaces that are part of a dependency get an order.
    expect(await orders()).toEqual({
      lead: undefined,
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
      lead: undefined,
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

  it("drops a dependency once the workspace's branch contains the dependency's work", async () => {
    await service.setWorkspaceDependencies(lead, { workspaceId: 'web', dependsOn: ['api'] });
    await service.setWorkspaceDependencies(lead, { workspaceId: 'docs', dependsOn: ['api'] });
    merged.add('api');

    contains.add('web>api');
    expect(await orders()).toEqual({
      lead: undefined,
      web: undefined,
      api: { rank: 1, waitingOn: [] },
      docs: { rank: 2, waitingOn: [] },
    });
    expect(fixture.db.select().from(taskDependencies).all()).toEqual([
      expect.objectContaining({ taskId: 'docs', dependsOnTaskId: 'api' }),
    ]);
    // Dropped and announced; the remaining one is only flagged as looking done.
    expect(await leadEvents()).toEqual([
      expect.stringContaining('"api"\'s branch is contained in "web"\'s'),
      'Dropped the dependency of "web" on "api": its branch already contains "api"\'s work.',
      expect.stringContaining('"docs" depends on "api", which looks done (PR #7 merged)'),
    ]);
    // What the lead has to act on wakes it; the automatic drop is only recorded.
    expect(
      (await service.readMessages(lead, {}))
        .filter((m) => isInitiativeEvent(m.kind))
        .map((m) => m.kind)
    ).toEqual(['attention', 'event', 'attention']);
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

  describe('folding workspaces', () => {
    it('tells the lead once when one branch is contained in another, in either order', async () => {
      contains.add('web>api');
      // Same commit both ways: reported once.
      contains.add('docs>web').add('web>docs');
      await service.checkDependencies();
      await service.checkDependencies();

      expect(await leadEvents()).toEqual([
        '"api"\'s branch is contained in "web"\'s; fold "api" into "web"? (merge_workspaces from ' +
          'api into web)',
        '"docs"\'s branch is contained in "web"\'s; fold "docs" into "web"? (merge_workspaces ' +
          'from docs into web)',
      ]);
    });

    it('ignores and refuses to fold a workspace that is mid-rebase', async () => {
      // Mid-rebase onto web, api's HEAD sits on web's commits: it looks contained but isn't.
      contains.add('web>api').add('api>web');
      rebasing.add('api');
      await service.setWorkspaceDependencies(lead, { workspaceId: 'api', dependsOn: ['web'] });
      await service.checkDependencies();

      expect(await leadEvents()).toEqual([]);
      expect(fixture.db.select().from(taskDependencies).all()).toHaveLength(1);
      await expect(service.mergeWorkspaces(lead, { from: 'api', into: 'web' })).rejects.toThrow(
        '"api" is mid-rebase'
      );
      await expect(service.mergeWorkspaces(lead, { from: 'web', into: 'api' })).rejects.toThrow(
        '"api" is mid-rebase'
      );
    });

    it('refuses uncommitted changes, work missing from the target, and non-leads', async () => {
      contains.add('web>api');
      await expect(service.mergeWorkspaces(api, { from: 'api', into: 'web' })).rejects.toThrow(
        'Only the lead'
      );
      await expect(service.mergeWorkspaces(lead, { from: 'web', into: 'api' })).rejects.toThrow(
        'has commits that "api"\'s branch doesn\'t contain'
      );
      dirty.add('api');
      await expect(service.mergeWorkspaces(lead, { from: 'api', into: 'web' })).rejects.toThrow(
        '"api" has 1 uncommitted change(s)'
      );
      await expect(service.mergeWorkspaces(lead, { from: 'lead', into: 'web' })).rejects.toThrow(
        "The lead can't be folded away"
      );
      expect(chats.size).toBe(0);
    });

    it("hands the agent's summary over, moves dependencies, and archives the folded one", async () => {
      contains.add('web>api');
      answering.add('api');
      await service.setWorkspaceDependencies(lead, { workspaceId: 'api', dependsOn: ['lead'] });
      await service.setWorkspaceDependencies(lead, { workspaceId: 'docs', dependsOn: ['api'] });

      const started = await service.mergeWorkspaces(lead, { from: 'api', into: 'web' });
      expect(started).toMatchObject({ started: true, from: 'api', into: 'web' });
      await service.waitForFold('api');

      expect(chats.get('api')).toEqual([expect.stringContaining('call the handoff_summary tool')]);
      expect(chats.get('web')).toEqual([
        expect.stringMatching(
          /^\[Handoff from workspace "api".*written by its agent.*\n\napi: added the endpoint; open: docs\.$/s
        ),
      ]);
      expect(
        fixture.db
          .select()
          .from(taskDependencies)
          .all()
          .map((row) => `${row.taskId}>${row.dependsOnTaskId}`)
          .sort()
      ).toEqual(['docs>web', 'web>lead']);
      expect(fixture.db.select().from(tasks).where(eq(tasks.id, 'api')).get()?.archivedAt).not.toBe(
        null
      );
      expect((await leadEvents()).at(-1)).toMatch(
        /^Folded "api" into "web" and archived "api"\. Handoff summary \(written by its agent\) delivered to "web"\./
      );
    });

    it("falls back to its commits and feed messages when the agent doesn't answer", async () => {
      contains.add('web>api');
      await service.postMessage(api, { text: 'API part done, PR #3 up.', toWorkspaceId: 'lead' });

      await service.mergeWorkspaces(lead, { from: 'api', into: 'web' });
      await service.waitForFold('api');

      expect(chats.get('web')?.[0]).toContain("its agent didn't answer in time");
      expect(chats.get('web')?.[0]).toContain('- abc1234 Add api endpoint');
      expect(chats.get('web')?.[0]).toContain('- API part done, PR #3 up.');
      await expect(service.submitHandoff(api, { text: 'late' })).rejects.toThrow('No fold');
    });

    it('stops without archiving when the folded workspace changes while handing off', async () => {
      contains.add('web>api');
      answering.add('api');
      const { sendToWorkspaceChat } = service['deps'];
      service['deps'].sendToWorkspaceChat = async (taskId, text) => {
        if (taskId === 'api') dirty.add('api');
        return sendToWorkspaceChat!(taskId, text);
      };

      await service.mergeWorkspaces(lead, { from: 'api', into: 'web' });
      await service.waitForFold('api');

      expect(fixture.db.select().from(tasks).where(eq(tasks.id, 'api')).get()?.archivedAt).toBe(
        null
      );
      expect((await leadEvents()).at(-1)).toContain('Folding "api" into "web" stopped');
    });
  });
});
