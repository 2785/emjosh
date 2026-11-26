import { mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { log } from '@main/lib/logger';

/**
 * Point-in-time copies of the app database, kept beside it in `backups/`.
 * Taken at startup (before migrations) and before anything that deletes user data,
 * so a bad import or migration can be rolled back by copying a file.
 */
export type SnapshotReason = 'startup' | 'pre-legacy-port';

const KEEP_PER_REASON: Record<SnapshotReason, number> = {
  startup: 14,
  'pre-legacy-port': 10,
};

/** Startup snapshots are skipped when the newest one is younger than this. */
export const STARTUP_SNAPSHOT_MIN_INTERVAL_MS = 6 * 60 * 60 * 1000;

const SNAPSHOT_NAME = /^emdash4-(startup|pre-legacy-port)-(.+)\.db$/;

export function snapshotFileName(reason: SnapshotReason, at: Date): string {
  return `emdash4-${reason}-${at.toISOString().replace(/[:.]/g, '-')}.db`;
}

type SnapshotFile = { name: string; reason: SnapshotReason; takenAt: number };

async function listSnapshots(directory: string): Promise<SnapshotFile[]> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return [];
  }
  return names
    .map((name) => {
      const match = SNAPSHOT_NAME.exec(name);
      if (!match) return null;
      const iso = match[2].replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, 'T$1:$2:$3.$4Z');
      const takenAt = Date.parse(iso);
      return Number.isNaN(takenAt) ? null : { name, reason: match[1] as SnapshotReason, takenAt };
    })
    .filter((file): file is SnapshotFile => file !== null)
    .sort((a, b) => b.takenAt - a.takenAt);
}

async function pruneSnapshots(directory: string, reason: SnapshotReason): Promise<void> {
  const files = (await listSnapshots(directory)).filter((file) => file.reason === reason);
  for (const file of files.slice(KEEP_PER_REASON[reason])) {
    await rm(join(directory, file.name), { force: true });
  }
}

export type SnapshotOptions = {
  readonly directory: string;
  readonly reason: SnapshotReason;
  readonly now?: () => Date;
};

/**
 * Copy the live database with SQLite's online backup. Returns the file path, or null
 * when a recent startup snapshot already exists. Throws when the copy fails: callers
 * that are about to delete data must not continue without one.
 */
export async function snapshotDatabase(
  sqlite: Database.Database,
  options: SnapshotOptions
): Promise<string | null> {
  const now = options.now ?? (() => new Date());
  const at = now();

  if (options.reason === 'startup') {
    const [newest] = (await listSnapshots(options.directory)).filter(
      (file) => file.reason === 'startup'
    );
    if (newest && at.getTime() - newest.takenAt < STARTUP_SNAPSHOT_MIN_INTERVAL_MS) return null;
  }

  await mkdir(options.directory, { recursive: true });
  const destination = join(options.directory, snapshotFileName(options.reason, at));
  await sqlite.backup(destination);
  await pruneSnapshots(options.directory, options.reason).catch((error) =>
    log.warn('db-snapshot: failed to prune old snapshots', { error: String(error) })
  );
  log.info('db-snapshot: saved', { reason: options.reason, destination });
  return destination;
}
