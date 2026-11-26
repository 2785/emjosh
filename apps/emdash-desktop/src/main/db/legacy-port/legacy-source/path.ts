import { closeSync, existsSync, openSync, readSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { PREVIOUS_DB_FILENAME } from '@main/db/default-path';

type Platform = NodeJS.Platform;

export function resolveLegacyUserDataPathCandidates(
  userDataPath: string,
  platform: Platform = process.platform
): string[] {
  const candidates = [userDataPath];

  if (platform === 'linux' && basename(userDataPath) === 'emdash') {
    candidates.push(join(dirname(userDataPath), 'Emdash'));
  }

  return candidates;
}

const SQLITE_HEADER = 'SQLite format 3\0';

/**
 * True for a file that starts with the SQLite header. An empty file (created when
 * something opens a database path that does not exist yet) is not an import source.
 */
export function isSqliteDatabaseFile(path: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const buffer = Buffer.alloc(SQLITE_HEADER.length);
    const bytesRead = readSync(fd, buffer, 0, buffer.length, 0);
    return bytesRead === buffer.length && buffer.toString('latin1') === SQLITE_HEADER;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function resolveLegacyDatabasePath(userDataPath: string): string {
  return join(userDataPath, 'emdash.db');
}

export function resolveExistingLegacyUserDataPath(userDataPath: string): string {
  return (
    resolveLegacyUserDataPathCandidates(userDataPath).find((candidate) =>
      existsSync(resolveLegacyDatabasePath(candidate))
    ) ?? userDataPath
  );
}

export function resolveExistingLegacyDatabasePath(userDataPath: string): string {
  return resolveLegacyDatabasePath(resolveExistingLegacyUserDataPath(userDataPath));
}

export function hasLegacyDatabaseFile(userDataPath: string): boolean {
  return resolveLegacyUserDataPathCandidates(userDataPath).some((candidate) =>
    isSqliteDatabaseFile(resolveLegacyDatabasePath(candidate))
  );
}

export function resolveBetaDatabasePath(userDataPath: string) {
  return join(userDataPath, PREVIOUS_DB_FILENAME);
}

export function resolveExistingBetaDatabasePath(userDataPath: string): string {
  return (
    resolveLegacyUserDataPathCandidates(userDataPath)
      .map(resolveBetaDatabasePath)
      .find((candidate) => existsSync(candidate)) ?? resolveBetaDatabasePath(userDataPath)
  );
}

export function hasBetaDatabaseFile(userDataPath: string): boolean {
  return resolveLegacyUserDataPathCandidates(userDataPath).some((candidate) =>
    isSqliteDatabaseFile(resolveBetaDatabasePath(candidate))
  );
}
