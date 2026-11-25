import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/** 0050 adds task dependencies. Additive: existing tasks depend on nothing. */
describe('0050 task dependencies', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;

  beforeEach(async () => {
    fixture = await openFixture('baseline');
  });

  afterEach(() => {
    fixture?.close();
  });

  it('starts empty and stores one dependency per pair', () => {
    expect(fixture.sqlite.prepare(`SELECT COUNT(*) AS n FROM task_dependencies`).get()).toEqual({
      n: 0,
    });

    const insert = fixture.sqlite.prepare(
      `INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES (?, ?)`
    );
    insert.run('t2', 't1');
    expect(() => insert.run('t2', 't1')).toThrow(/UNIQUE/);
    expect(
      fixture.sqlite
        .prepare(`SELECT task_id, depends_on_task_id, done_notice FROM task_dependencies`)
        .all()
    ).toEqual([{ task_id: 't2', depends_on_task_id: 't1', done_notice: null }]);
  });
});
