import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  hasBetaDatabaseFile,
  hasLegacyDatabaseFile,
  isSqliteDatabaseFile,
  resolveLegacyUserDataPathCandidates,
} from './path';

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'legacy-path-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('legacy source detection', () => {
  it('ignores empty placeholder files that are not SQLite databases', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'emdash.db'), '');
    writeFileSync(join(dir, 'emdash3.db'), 'not a database');

    expect(isSqliteDatabaseFile(join(dir, 'emdash.db'))).toBe(false);
    expect(hasLegacyDatabaseFile(dir)).toBe(false);
    expect(hasBetaDatabaseFile(dir)).toBe(false);
  });

  it('accepts a file with the SQLite header', () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, 'emdash.db'),
      Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.alloc(84)])
    );

    expect(hasLegacyDatabaseFile(dir)).toBe(true);
  });

  it('treats a missing file as not a database', () => {
    expect(isSqliteDatabaseFile(join(tempDir(), 'missing.db'))).toBe(false);
  });
});

describe('resolveLegacyUserDataPathCandidates', () => {
  it('checks the capitalized legacy config directory after lowercase emdash on Linux', () => {
    expect(resolveLegacyUserDataPathCandidates('/home/user/.config/emdash', 'linux')).toEqual([
      '/home/user/.config/emdash',
      '/home/user/.config/Emdash',
    ]);
  });

  it('does not add a capitalized fallback outside Linux', () => {
    expect(
      resolveLegacyUserDataPathCandidates(
        '/Users/user/Library/Application Support/emdash',
        'darwin'
      )
    ).toEqual(['/Users/user/Library/Application Support/emdash']);
  });

  it('does not duplicate paths when the configured directory is already capitalized', () => {
    expect(resolveLegacyUserDataPathCandidates('/home/user/.config/Emdash', 'linux')).toEqual([
      '/home/user/.config/Emdash',
    ]);
  });
});
