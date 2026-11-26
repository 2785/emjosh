import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { snapshotDatabase, snapshotFileName, STARTUP_SNAPSHOT_MIN_INTERVAL_MS } from './snapshots';

describe('snapshotDatabase', () => {
  const dbs: Database.Database[] = [];
  const dirs: string[] = [];

  afterEach(() => {
    for (const db of dbs.splice(0)) db.close();
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function setup() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-snapshot-'));
    dirs.push(dir);
    const sqlite = new Database(path.join(dir, 'live.db'));
    dbs.push(sqlite);
    sqlite.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY); INSERT INTO projects VALUES ('p1');`);
    return { sqlite, directory: path.join(dir, 'backups') };
  }

  it('saves a readable copy of the live database', async () => {
    const { sqlite, directory } = setup();

    const file = await snapshotDatabase(sqlite, {
      directory,
      reason: 'pre-legacy-port',
      now: () => new Date('2026-11-26T16:00:00.000Z'),
    });

    expect(file).toBe(path.join(directory, 'emdash4-pre-legacy-port-2026-11-26T16-00-00-000Z.db'));
    const copy = new Database(file!, { readonly: true });
    dbs.push(copy);
    expect(copy.prepare('SELECT id FROM projects').all()).toEqual([{ id: 'p1' }]);
  });

  it('skips a startup snapshot when a recent one exists, and takes one after the interval', async () => {
    const { sqlite, directory } = setup();
    const t0 = new Date('2026-11-26T00:00:00.000Z');

    expect(
      await snapshotDatabase(sqlite, { directory, reason: 'startup', now: () => t0 })
    ).not.toBeNull();
    expect(
      await snapshotDatabase(sqlite, {
        directory,
        reason: 'startup',
        now: () => new Date(t0.getTime() + 60_000),
      })
    ).toBeNull();
    expect(
      await snapshotDatabase(sqlite, {
        directory,
        reason: 'startup',
        now: () => new Date(t0.getTime() + STARTUP_SNAPSHOT_MIN_INTERVAL_MS + 1),
      })
    ).not.toBeNull();
    expect(fs.readdirSync(directory)).toHaveLength(2);
  });

  it('never throttles a pre-import snapshot', async () => {
    const { sqlite, directory } = setup();
    const at = new Date('2026-11-26T00:00:00.000Z');

    await snapshotDatabase(sqlite, { directory, reason: 'pre-legacy-port', now: () => at });
    const second = await snapshotDatabase(sqlite, {
      directory,
      reason: 'pre-legacy-port',
      now: () => new Date(at.getTime() + 1000),
    });

    expect(second).not.toBeNull();
  });

  it('keeps only the newest snapshots per reason', async () => {
    const { sqlite, directory } = setup();
    const base = new Date('2026-01-01T00:00:00.000Z').getTime();

    for (let i = 0; i < 13; i++) {
      await snapshotDatabase(sqlite, {
        directory,
        reason: 'pre-legacy-port',
        now: () => new Date(base + i * 1000),
      });
    }

    const names = fs.readdirSync(directory).sort();
    expect(names).toHaveLength(10);
    expect(names[0]).toBe(snapshotFileName('pre-legacy-port', new Date(base + 3 * 1000)));
  });

  it('ignores unrelated files in the backups directory when pruning', async () => {
    const { sqlite, directory } = setup();
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'notes.txt'), 'keep me');

    await snapshotDatabase(sqlite, { directory, reason: 'pre-legacy-port' });

    expect(fs.existsSync(path.join(directory, 'notes.txt'))).toBe(true);
  });
});
