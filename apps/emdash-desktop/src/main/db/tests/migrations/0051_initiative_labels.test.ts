import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/** 0051 adds initiative labels. Additive: existing initiative members have no label. */
describe('0051 initiative labels', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;

  beforeEach(async () => {
    fixture = await openFixture('pre-0051');
  });

  afterEach(() => {
    fixture?.close();
  });

  it('leaves existing tasks unlabelled', () => {
    const rows = fixture.sqlite.prepare(`SELECT initiative_label FROM tasks`).all() as {
      initiative_label: string | null;
    }[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.initiative_label === null)).toBe(true);
  });

  it('issues each label once per initiative and drops them with the initiative', () => {
    fixture.sqlite.prepare(`INSERT INTO initiatives (id, name) VALUES ('i1', 'One')`).run();
    const insert = fixture.sqlite.prepare(
      `INSERT INTO initiative_labels (initiative_id, label, task_id) VALUES (?, ?, ?)`
    );
    insert.run('i1', 'A', 't1');
    expect(() => insert.run('i1', 'A', 't2')).toThrow(/UNIQUE/);
    fixture.sqlite.pragma('foreign_keys = ON');
    fixture.sqlite.prepare(`DELETE FROM initiatives WHERE id = 'i1'`).run();
    expect(fixture.sqlite.prepare(`SELECT COUNT(*) AS n FROM initiative_labels`).get()).toEqual({
      n: 0,
    });
  });
});
