import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { projects, tasks } from '@core/services/app-db/node/schema';
import { InitiativesService } from './initiatives-service';

describe('InitiativesService', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;
  let service: InitiativesService;

  beforeEach(async () => {
    fixture = await openFixture('empty');
    fixture.db.insert(projects).values({ id: 'p1', name: 'api' }).run();
    fixture.db.insert(projects).values({ id: 'p2', name: 'web' }).run();
    for (const [id, projectId] of [
      ['t1', 'p1'],
      ['t2', 'p2'],
      ['t3', 'p2'],
    ] as const) {
      fixture.db.insert(tasks).values({ id, projectId, name: id, status: 'in_progress' }).run();
    }
    service = new InitiativesService(fixture.db as never);
  });

  afterEach(() => fixture?.close());

  it('groups tasks across projects and lets them leave again', async () => {
    const initiative = await service.create('  Accounts v2 ');
    await service.setTaskInitiative(['t1', 't2'], initiative.id);

    expect(await service.list()).toEqual([
      expect.objectContaining({ name: 'Accounts v2', pushMessages: false, taskIds: ['t1', 't2'] }),
    ]);
    expect((await service.initiativeOfTask('t2'))?.id).toBe(initiative.id);

    await service.setTaskInitiative(['t2'], null);
    expect((await service.get(initiative.id))?.taskIds).toEqual(['t1']);
    expect(await service.initiativeOfTask('t2')).toBeNull();
  });

  it('archives and configures initiatives', async () => {
    const initiative = await service.create('Accounts v2');

    await service.update(initiative.id, { pushMessages: true, name: 'Accounts v3' });
    expect(await service.get(initiative.id)).toMatchObject({
      name: 'Accounts v3',
      pushMessages: true,
    });
    await service.update(initiative.id, { archived: true });
    expect(await service.list()).toEqual([]);
    expect(await service.list({ includeArchived: true })).toHaveLength(1);
  });

  it("shows a task only messages to it and the user's posts, plus what it subscribed to", async () => {
    const { id } = await service.create('Accounts v2');
    await service.setTaskInitiative(['t1', 't2', 't3'], id);
    await service.post({ initiativeId: id, fromTaskId: 't1', body: 'from t1 to all' });
    await service.post({ initiativeId: id, fromTaskId: 't1', toTaskId: 't2', body: 'to t2' });
    await service.post({ initiativeId: id, fromTaskId: 't2', toTaskId: 't3', body: 'to t3' });
    await service.post({ initiativeId: id, fromTaskId: null, body: 'user post' });
    await service.post({ initiativeId: id, fromTaskId: 't1', kind: 'event', body: 't1 finished' });
    await service.post({ initiativeId: id, fromTaskId: 't3', kind: 'event', body: 't3 failed' });
    const forT2 = async () =>
      (await service.messages({ initiativeId: id, forTaskId: 't2' })).map((m) => m.body);

    expect(await forT2()).toEqual(['to t2', 'user post']);

    await service.subscribe({
      initiativeId: id,
      taskId: 't2',
      topic: 'messages',
      sourceTaskIds: ['t1'],
    });
    await service.subscribe({ initiativeId: id, taskId: 't2', topic: 'events' });
    expect(await forT2()).toEqual([
      'from t1 to all',
      'to t2',
      'user post',
      't1 finished',
      't3 failed',
    ]);

    await service.unsubscribe({ initiativeId: id, taskId: 't2', topic: 'events' });
    await service.subscribe({
      initiativeId: id,
      taskId: 't2',
      topic: 'events',
      sourceTaskIds: ['t3'],
    });
    expect(await forT2()).toEqual(['from t1 to all', 'to t2', 'user post', 't3 failed']);
    expect(await service.subscriptions(id, 't2')).toEqual(
      expect.arrayContaining([
        { topic: 'messages', sourceTaskId: 't1' },
        { topic: 'events', sourceTaskId: 't3' },
      ])
    );

    // The user's view of the feed is unfiltered.
    expect(await service.messages({ initiativeId: id })).toHaveLength(6);
    const all = await service.messages({ initiativeId: id });
    expect(await service.recipients(all[0]!)).toEqual(['t2']);
    expect(await service.recipients(all[3]!)).toEqual(['t1', 't2', 't3']);
    expect(await service.recipients(all[4]!)).toEqual([]);
  });

  it('wakes a waiting task when a message for it arrives, and times out otherwise', async () => {
    const { id } = await service.create('Accounts v2');

    const waiting = service.waitForMessages({ initiativeId: id, forTaskId: 't2' }, 2_000);
    await service.post({ initiativeId: id, fromTaskId: 't2', body: 'own message' });
    await service.post({ initiativeId: id, fromTaskId: 't1', toTaskId: 't3', body: 'for t3' });
    await service.post({ initiativeId: id, fromTaskId: 't1', toTaskId: 't2', body: 'for t2' });

    expect((await waiting).map((m) => m.body)).toEqual(['for t2']);
    expect(
      await service.waitForMessages(
        { initiativeId: id, forTaskId: 't3', afterId: (await waiting)[0]!.id },
        50
      )
    ).toEqual([]);
  });

  it("delivers everything to the lead and the lead's broadcasts to every member", async () => {
    const { id } = await service.create('Accounts v2');
    await service.setTaskInitiative(['t2', 't3'], id);
    await service.setLead(id, 't1');
    expect(await service.get(id)).toMatchObject({ leadTaskId: 't1', taskIds: ['t1', 't2', 't3'] });

    const lead = await service.post({ initiativeId: id, fromTaskId: 't1', body: 'plan' });
    const between = await service.post({
      initiativeId: id,
      fromTaskId: 't2',
      toTaskId: 't3',
      body: 'contract',
    });
    const broadcast = await service.post({ initiativeId: id, fromTaskId: 't2', body: 'fyi' });
    const event = await service.post({
      initiativeId: id,
      fromTaskId: 't3',
      kind: 'event',
      body: 't3 finished',
    });

    const bodies = async (taskId: string) =>
      (await service.messages({ initiativeId: id, forTaskId: taskId })).map((m) => m.body);
    expect(await bodies('t1')).toEqual(['contract', 'fyi', 't3 finished']);
    expect(await bodies('t2')).toEqual(['plan']);
    expect(await bodies('t3')).toEqual(['plan', 'contract']);
    expect(await service.recipients(lead)).toEqual(['t2', 't3']);
    expect(await service.recipients(between)).toEqual(['t1', 't3']);
    expect(await service.recipients(broadcast)).toEqual(['t1']);
    expect(await service.recipients(event)).toEqual(['t1']);
  });

  it('wakes the lead only for what needs it, and keeps the rest as activity', async () => {
    const { id } = await service.create('Accounts v2');
    await service.setTaskInitiative(['t2', 't3'], id);
    await service.setLead(id, 't1');
    const post = (input: Omit<Parameters<typeof service.post>[0], 'initiativeId'>) =>
      service.post({ initiativeId: id, ...input });

    const done = await post({ fromTaskId: 't2', toTaskId: 't1', kind: 'done', body: 'done' });
    const fyi = await post({ fromTaskId: 't2', toTaskId: 't1', kind: 'fyi', body: 'still on it' });
    // From an agent whose tools predate kinds: it may be the report the lead waits for.
    const untyped = await post({ fromTaskId: 't3', toTaskId: 't1', body: 'finished, PR is up' });
    const finished = await post({ fromTaskId: 't3', kind: 'event', body: 't3 finished' });
    const approval = await post({ fromTaskId: 't3', kind: 'attention', body: 't3 waits' });
    const broadcast = await post({ fromTaskId: 't1', body: 'plan' });
    const actNow = await post({ fromTaskId: 't1', kind: 'decision', body: 'pick one' });
    const direct = await post({ fromTaskId: 't1', toTaskId: 't3', body: 'rebase' });

    expect(untyped.kind).toBe('message');
    expect(await service.deliveryTargets(done)).toEqual({ wake: ['t1'], quiet: [] });
    expect(await service.deliveryTargets(fyi)).toEqual({ wake: [], quiet: ['t1'] });
    expect(await service.deliveryTargets(untyped)).toEqual({ wake: ['t1'], quiet: [] });
    expect(await service.deliveryTargets(finished)).toEqual({ wake: [], quiet: ['t1'] });
    expect(await service.deliveryTargets(approval)).toEqual({ wake: ['t1'], quiet: [] });
    expect(await service.deliveryTargets(broadcast)).toEqual({ wake: [], quiet: ['t2', 't3'] });
    expect(await service.deliveryTargets(actNow)).toEqual({ wake: ['t2', 't3'], quiet: [] });
    expect(await service.deliveryTargets(direct)).toEqual({ wake: ['t3'], quiet: [] });

    const activity = await service.activity(id);
    expect(activity.get('t2')).toEqual({
      lastEvent: null,
      lastMessage: expect.objectContaining({ kind: 'fyi', toTaskId: 't1', body: 'still on it' }),
    });
    expect(activity.get('t3')).toEqual({
      lastEvent: expect.objectContaining({ kind: 'attention', body: 't3 waits' }),
      lastMessage: expect.objectContaining({ kind: 'message', body: 'finished, PR is up' }),
    });
  });

  it('drops the lead when it leaves the initiative', async () => {
    const { id } = await service.create('Accounts v2');
    await service.setLead(id, 't1');
    await service.setTaskInitiative(['t1'], id);
    expect((await service.get(id))?.leadTaskId).toBe('t1');

    await service.setTaskInitiative(['t1'], null);
    expect((await service.get(id))?.leadTaskId).toBeNull();
  });
  it('checks an initiative and label before a workspace joins', async () => {
    const initiative = await service.create('Accounts v2');
    await service.setTaskInitiative(['t1'], initiative.id, { label: 'API' });

    await expect(service.assertCanJoin(initiative.id)).resolves.toBeUndefined();
    await expect(service.assertCanJoin(initiative.id, 'WEB')).resolves.toBeUndefined();
    await expect(service.assertCanJoin('missing')).rejects.toThrow(
      "Initiative 'missing' was not found."
    );
    await expect(service.assertCanJoin(initiative.id, 'api')).rejects.toThrow(/is taken by/);
  });
});
