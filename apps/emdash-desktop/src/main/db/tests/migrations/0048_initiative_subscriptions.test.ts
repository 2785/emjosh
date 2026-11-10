import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * 0048 adds initiative subscriptions: what a task listens to beyond messages addressed to it.
 * Additive: existing initiatives start with none, so their tasks get only direct messages.
 */
describe('0048 initiative subscriptions', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;

  beforeEach(async () => {
    fixture = await openFixture('baseline');
  });

  afterEach(() => {
    fixture?.close();
  });

  it('stores subscriptions and drops them with their initiative', () => {
    fixture.sqlite.prepare(`INSERT INTO initiatives (id, name) VALUES ('i1', 'Accounts v2')`).run();
    fixture.sqlite
      .prepare(
        `INSERT INTO initiative_subscriptions (id, initiative_id, task_id, topic, source_task_id)
         VALUES ('s1', 'i1', 't1', 'events', NULL), ('s2', 'i1', 't1', 'messages', 't2')`
      )
      .run();

    const rows = fixture.sqlite
      .prepare(`SELECT topic, source_task_id, created_at FROM initiative_subscriptions ORDER BY id`)
      .all() as { topic: string; source_task_id: string | null; created_at: string }[];
    expect(rows.map((row) => [row.topic, row.source_task_id])).toEqual([
      ['events', null],
      ['messages', 't2'],
    ]);
    expect(rows[0]!.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

    fixture.sqlite.pragma('foreign_keys = ON');
    fixture.sqlite.prepare(`DELETE FROM initiatives WHERE id = 'i1'`).run();
    expect(
      fixture.sqlite.prepare(`SELECT COUNT(*) AS n FROM initiative_subscriptions`).get()
    ).toEqual({ n: 0 });
  });
});
