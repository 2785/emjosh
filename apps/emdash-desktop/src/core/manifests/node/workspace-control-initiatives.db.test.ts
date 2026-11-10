import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InitiativesService } from '@core/features/initiatives/node/initiatives-service';
import { WorkspaceControlService } from '@core/features/workspace-control/node/workspace-control-service';
import { projects, tasks } from '@core/services/app-db/node/schema';

describe('workspace control initiatives and messages', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;
  let service: WorkspaceControlService;
  let initiatives: InitiativesService;
  const lead = { conversationId: 'conv-lead' };
  const peer = { conversationId: 'conv-peer' };

  beforeEach(async () => {
    fixture = await openFixture('empty');
    fixture.db.insert(projects).values({ id: 'api', name: 'api' }).run();
    fixture.db.insert(projects).values({ id: 'web', name: 'web' }).run();
    fixture.db
      .insert(tasks)
      .values({ id: 'lead', projectId: 'api', name: 'lead', status: 'x' })
      .run();
    fixture.db
      .insert(tasks)
      .values({ id: 'peer', projectId: 'web', name: 'peer', status: 'x' })
      .run();
    initiatives = new InitiativesService(fixture.db as never);
    service = new WorkspaceControlService({
      listProjects: async () => [],
      listWorkspaces: async () => [],
      pullRequestForBranch: async () => null,
      callerContext: async (conversationId) =>
        (({ 'conv-lead': 'lead', 'conv-peer': 'peer' }) as Record<string, string>)[conversationId]
          ? {
              taskId: ({ 'conv-lead': 'lead', 'conv-peer': 'peer' } as Record<string, string>)[
                conversationId
              ]!,
              provider: 'claude',
            }
          : null,
      archiveWorkspace: async () => {},
      renameWorkspace: async () => {},
      addProject: async () => ({ id: 'x', name: 'x', path: '/x' }),
      cloneProject: async () => ({ id: 'x', name: 'x', path: '/x' }),
      renameProject: async () => {},
      removeProject: async () => {},
      createWorkspace: vi.fn(async () => ({ id: 'peer', name: 'peer', branch: 'peer' })),
      initiatives,
    });
  });

  afterEach(() => fixture?.close());

  it('lets a lead group workspaces and exchange messages with them', async () => {
    const initiative = await service.createInitiative(lead, {
      name: 'Accounts v2',
      workspaceIds: ['peer'],
    });
    expect(initiative.taskIds.sort()).toEqual(['lead', 'peer']);

    const waiting = service.waitForMessages(peer, { timeoutSeconds: 5 });
    await service.postMessage(lead, { text: 'Use tenant_id on POST /v2/accounts' });
    const received = await waiting;
    expect(received.map((m) => [m.fromTaskId, m.body])).toEqual([
      ['lead', 'Use tenant_id on POST /v2/accounts'],
    ]);

    await service.postMessage(peer, { text: 'Done, PR is up', toWorkspaceId: 'lead' });
    expect((await service.readMessages(lead, {})).map((m) => m.body)).toEqual(['Done, PR is up']);
    expect(await service.readMessages(peer, { afterId: received[0]!.id })).toEqual([]);
  });

  it('delivers messages into chats for initiatives agents create, unless asked not to', async () => {
    expect((await service.createInitiative(lead, { name: 'Accounts v2' })).pushMessages).toBe(true);
    const quiet = await service.createInitiative(peer, { name: 'Quiet', pushMessages: false });
    expect(quiet.pushMessages).toBe(false);

    // The caller's initiative by default.
    expect((await service.setMessageDelivery(peer, { enabled: true })).pushMessages).toBe(true);
    expect((await initiatives.get(quiet.id))?.pushMessages).toBe(true);
  });

  it('records new workspaces in the initiative feed', async () => {
    const initiative = await service.createInitiative(lead, { name: 'Accounts v2' });

    await service.createWorkspace(lead, {
      projectId: 'web',
      initiativeId: initiative.id,
      prompt: 'Add the field',
    });

    expect((await initiatives.get(initiative.id))?.taskIds.sort()).toEqual(['lead', 'peer']);
    expect((await service.readMessages(peer, {})).map((m) => [m.kind, m.body])).toEqual([
      ['event', 'Workspace "peer" was created and given a first task.'],
    ]);
  });

  it('asks workspaces outside an initiative to join one before messaging', async () => {
    await expect(service.postMessage(peer, { text: 'hello' })).rejects.toThrow(
      /not in an initiative/
    );
    await expect(service.readMessages({ conversationId: null }, {})).rejects.toThrow(
      /initiativeId/
    );
  });
});
