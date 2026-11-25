import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { projects, tasks } from '@core/services/app-db/node/schema';
import { InitiativesService } from './initiatives-service';

describe('initiative labels', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;
  let service: InitiativesService;

  beforeEach(async () => {
    fixture = await openFixture('empty');
    fixture.db.insert(projects).values({ id: 'p1', name: 'api' }).run();
    for (const id of ['lead', 't1', 't2', 't3', 't4']) {
      fixture.db
        .insert(tasks)
        .values({ id, projectId: 'p1', name: `task ${id}`, status: 'in_progress' })
        .run();
    }
    service = new InitiativesService(fixture.db as never);
  });

  afterEach(() => fixture?.close());

  const labels = async (id: string) => (await service.get(id))?.labels;

  it('gives joining workspaces the next letter, and the lead none', async () => {
    const { id } = await service.create('Accounts');
    await service.setTaskInitiative(['t1', 't2'], id);
    await service.setLead(id, 'lead');
    await service.setTaskInitiative(['t3'], id);

    expect(await labels(id)).toEqual({ t1: 'A', t2: 'B', t3: 'C' });
  });

  it('keeps labels of workspaces already in the initiative', async () => {
    const { id } = await service.create('Accounts');
    await service.setTaskInitiative(['t1'], id);
    await service.setTaskInitiative(['t1', 't2'], id);

    expect(await labels(id)).toEqual({ t1: 'A', t2: 'B' });
  });

  it('never reuses a label, but gives a returning workspace its own back', async () => {
    const { id } = await service.create('Accounts');
    await service.setTaskInitiative(['t1', 't2'], id);
    await service.setTaskInitiative(['t1'], null);
    expect(await labels(id)).toEqual({ t2: 'B' });

    await service.setTaskInitiative(['t3'], id);
    expect(await labels(id)).toEqual({ t2: 'B', t3: 'C' });

    await service.setTaskInitiative(['t1'], id);
    expect(await labels(id)).toEqual({ t1: 'A', t2: 'B', t3: 'C' });
  });

  it('drops the label when a workspace moves to another initiative', async () => {
    const first = await service.create('First');
    const second = await service.create('Second');
    await service.setTaskInitiative(['t1', 't2'], first.id);
    await service.setTaskInitiative(['t2'], second.id);

    expect(await labels(first.id)).toEqual({ t1: 'A' });
    expect(await labels(second.id)).toEqual({ t2: 'A' });
  });

  it('sets, changes and clears labels, rejecting taken and retired ones', async () => {
    const { id } = await service.create('Accounts');
    await service.setTaskInitiative(['t1', 't2'], id);

    await service.setLabel('t1', ' api ');
    expect(await labels(id)).toEqual({ t1: 'API', t2: 'B' });
    await expect(service.setLabel('t2', 'api')).rejects.toThrow(
      'Label "API" is taken by workspace "task t1".'
    );
    // "A" was t1's before it became "API"; it stays t1's.
    await expect(service.setLabel('t2', 'A')).rejects.toThrow(/given to workspace "task t1"/);
    await service.setLabel('t1', 'A');
    expect(await labels(id)).toEqual({ t1: 'A', t2: 'B' });

    await service.setLabel('t2', null);
    expect(await labels(id)).toEqual({ t1: 'A' });
    // A cleared label isn't handed out again.
    await service.setTaskInitiative(['t3'], id);
    expect(await labels(id)).toEqual({ t1: 'A', t3: 'C' });

    await expect(service.setLabel('t3', 'way too long')).rejects.toThrow(/1 to 6 letters/);
    await expect(service.setLabel('t4', 'X')).rejects.toThrow('not in an initiative');
  });

  it('takes a chosen label on joining, or none', async () => {
    const { id } = await service.create('Accounts');
    await service.setTaskInitiative(['t1'], id, { label: 'ui' });
    await service.setTaskInitiative(['t2'], id, { label: null });
    await service.setTaskInitiative(['t3'], id);
    await expect(service.setTaskInitiative(['t4'], id, { label: 'UI' })).rejects.toThrow(/taken/);
    await expect(service.setTaskInitiative(['t2', 't4'], id, { label: 'X' })).rejects.toThrow(
      /one workspace/
    );

    expect(await labels(id)).toEqual({ t1: 'UI', t3: 'A' });
    expect((await service.get(id))?.taskIds).not.toContain('t4');
  });

  it("keeps a member's label when it becomes the lead", async () => {
    const { id } = await service.create('Accounts');
    await service.setTaskInitiative(['t1'], id);
    await service.setLead(id, 't1');

    expect(await labels(id)).toEqual({ t1: 'A' });
  });
});
