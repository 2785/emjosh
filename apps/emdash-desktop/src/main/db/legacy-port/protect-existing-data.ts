import type Database from 'better-sqlite3';
import { log } from '../../lib/logger';
import { destinationHasUserData } from './reset';
import type { LegacyPortStateStore } from './service';

/**
 * A database that already holds projects or tasks never needs the legacy import, and the
 * import clears the database before it copies anything. Recording a status here keeps
 * onboarding from offering it. Returns true when a status was recorded.
 */
export async function protectExistingDataFromLegacyImport(
  sqlite: Database.Database,
  stateStore: LegacyPortStateStore
): Promise<boolean> {
  if (!destinationHasUserData(sqlite)) return false;
  if (await stateStore.getStatus()) return false;
  await stateStore.setStatus('skipped-legacy');
  log.info('legacy-port: database already has data, legacy import marked as skipped');
  return true;
}
