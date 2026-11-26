import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import {
  clearDestinationDataPreservingSignIn,
  DestructiveResetRefusedError,
  destinationHasUserData,
  listUserTables,
} from './reset';

describe('listUserTables', () => {
  it('excludes SQLite shadow tables for virtual tables', () => {
    const db = new Database(':memory:');
    try {
      db.exec(`
        CREATE TABLE app_data (id TEXT PRIMARY KEY);
        CREATE VIRTUAL TABLE search_index USING fts5(title);
        CREATE VIRTUAL TABLE legacy_index USING fts4(title);
      `);

      expect(listUserTables(db).sort()).toEqual(['app_data', 'legacy_index', 'search_index']);
    } finally {
      db.close();
    }
  });
});

describe('clearDestinationDataPreservingSignIn', () => {
  function populatedDb(): Database.Database {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE tasks (id TEXT PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO projects VALUES ('p1', 'one');
      INSERT INTO kv VALUES ('account:profile', '{}'), ('other', '1');
    `);
    return db;
  }

  it('refuses to clear projects or tasks unless the caller allows it', () => {
    const db = populatedDb();
    try {
      expect(destinationHasUserData(db)).toBe(true);
      expect(() => clearDestinationDataPreservingSignIn(db)).toThrow(DestructiveResetRefusedError);
      expect(db.prepare('SELECT COUNT(*) AS n FROM projects').get()).toEqual({ n: 1 });
    } finally {
      db.close();
    }
  });

  it('clears everything except sign-in state when allowed', () => {
    const db = populatedDb();
    try {
      clearDestinationDataPreservingSignIn(db, { allowNonEmpty: true });
      expect(db.prepare('SELECT COUNT(*) AS n FROM projects').get()).toEqual({ n: 0 });
      expect(db.prepare('SELECT key FROM kv').all()).toEqual([{ key: 'account:profile' }]);
    } finally {
      db.close();
    }
  });

  it('clears an empty database without options', () => {
    const db = new Database(':memory:');
    try {
      db.exec(
        'CREATE TABLE projects (id TEXT PRIMARY KEY); CREATE TABLE tasks (id TEXT PRIMARY KEY);'
      );
      expect(destinationHasUserData(db)).toBe(false);
      expect(() => clearDestinationDataPreservingSignIn(db)).not.toThrow();
    } finally {
      db.close();
    }
  });
});
