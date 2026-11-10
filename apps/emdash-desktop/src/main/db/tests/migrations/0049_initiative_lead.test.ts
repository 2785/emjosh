import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/** 0049 adds an initiative's lead task. Additive: existing initiatives have no lead. */
describe('0049 initiative lead', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;

  beforeEach(async () => {
    fixture = await openFixture('baseline');
  });

  afterEach(() => {
    fixture?.close();
  });

  it('defaults to no lead and stores one', () => {
    fixture.sqlite.prepare(`INSERT INTO initiatives (id, name) VALUES ('i1', 'Accounts v2')`).run();
    expect(
      fixture.sqlite.prepare(`SELECT lead_task_id FROM initiatives WHERE id = 'i1'`).get()
    ).toEqual({ lead_task_id: null });

    fixture.sqlite.prepare(`UPDATE initiatives SET lead_task_id = 't1' WHERE id = 'i1'`).run();
    expect(
      fixture.sqlite.prepare(`SELECT lead_task_id FROM initiatives WHERE id = 'i1'`).get()
    ).toEqual({ lead_task_id: 't1' });
  });
});
