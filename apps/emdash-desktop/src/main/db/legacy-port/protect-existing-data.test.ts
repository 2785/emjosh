import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { protectExistingDataFromLegacyImport } from './protect-existing-data';
import type { LegacyPortStateStore, LegacyPortStatus } from './service';

class MemoryStateStore implements LegacyPortStateStore {
  constructor(public status: LegacyPortStatus | null = null) {}
  async getStatus() {
    return this.status;
  }
  async setStatus(status: LegacyPortStatus) {
    this.status = status;
  }
}

describe('protectExistingDataFromLegacyImport', () => {
  const dbs: Database.Database[] = [];
  afterEach(() => {
    for (const db of dbs.splice(0)) db.close();
  });

  function db(withProject: boolean): Database.Database {
    const sqlite = new Database(':memory:');
    dbs.push(sqlite);
    sqlite.exec(
      'CREATE TABLE projects (id TEXT PRIMARY KEY); CREATE TABLE tasks (id TEXT PRIMARY KEY);'
    );
    if (withProject) sqlite.exec(`INSERT INTO projects VALUES ('p1')`);
    return sqlite;
  }

  it('records a skipped status when the database already has projects', async () => {
    const store = new MemoryStateStore();

    expect(await protectExistingDataFromLegacyImport(db(true), store)).toBe(true);
    expect(store.status).toBe('skipped-legacy');
  });

  it('leaves an empty database alone so a first-run import still works', async () => {
    const store = new MemoryStateStore();

    expect(await protectExistingDataFromLegacyImport(db(false), store)).toBe(false);
    expect(store.status).toBeNull();
  });

  it('keeps a status that was already recorded', async () => {
    const store = new MemoryStateStore('completed');

    expect(await protectExistingDataFromLegacyImport(db(true), store)).toBe(false);
    expect(store.status).toBe('completed');
  });
});
