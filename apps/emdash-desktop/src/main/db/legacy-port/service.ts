import { join } from 'node:path';
import { hostRefFromParts, hostRefKey } from '@emdash/core/primitives/host/api';
import type Database from 'better-sqlite3';
import { eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { LegacyImportSource } from '@core/primitives/legacy-port/api/legacy-port';
import type { StartupDataGateStatus } from '@core/primitives/legacy-port/api/startup-data-gate';
import * as schema from '@core/services/app-db/node/schema';
import { runLocalCommand } from '@main/core/utils/exec';
import { getAppDb, getSqlite } from '@main/db/instance';
import { log } from '../../lib/logger';
import { snapshotDatabase } from '../snapshots';
import {
  copyAttachedBetaDatabaseIntoDestination,
  importBetaDatabaseIntoDestination,
  withBetaDatabaseAttached,
} from './beta-import';
import { deleteProjectsById } from './destination-cleanup';
import { portConversations, renameLegacyTmuxSessions } from './importers/relational/conversations';
import { portProjects } from './importers/relational/projects';
import { createRemapTables } from './importers/relational/remap';
import { portSshConnections } from './importers/relational/ssh-connections';
import { portTasks } from './importers/relational/tasks';
import type { PortSummary } from './importers/relational/types';
import { portLegacySettings } from './importers/settings/importer';
import { openLegacyReadOnly } from './legacy-source/open-readonly';
import {
  hasBetaDatabaseFile,
  hasLegacyDatabaseFile,
  resolveExistingBetaDatabasePath,
  resolveExistingLegacyDatabasePath,
  resolveExistingLegacyUserDataPath,
} from './legacy-source/path';
import { clearDestinationDataPreservingSignIn, destinationHasUserData } from './reset';
import { buildLegacyProjectSelection } from './source-analysis';
import { importAtomically } from './sqlite-utils';
import { createLegacyPortStateStore } from './state-store';
import { ensureImportedTaskWorkspaces } from './task-workspace-backfill';

type LegacyPortDb = ReturnType<typeof drizzle<typeof schema>>;

type AppTarget = {
  db: LegacyPortDb;
  sqlite: Database.Database;
};

export type LegacyPortStatus = StartupDataGateStatus;

export interface LegacyPortStateStore {
  getStatus(): Promise<LegacyPortStatus | null>;
  setStatus(status: LegacyPortStatus): Promise<void>;
}

export type RunLegacyPortOptions = {
  appDb?: Database.Database;
  stateStore?: LegacyPortStateStore;
  sources?: LegacyImportSource[];
  conflictChoices?: Record<string, LegacyImportSource>;
  /**
   * Allow the import to delete projects and tasks already in the app database. Off
   * unless the user explicitly confirmed replacing their data; otherwise the import is
   * skipped. A snapshot is saved first either way.
   */
  allowOverwriteExisting?: boolean;
  /** Where the pre-import snapshot goes. Defaults to `<userData>/backups`. */
  backupDirectory?: string;
};

async function resolveAppTarget(appSqlite?: Database.Database): Promise<AppTarget> {
  if (!appSqlite) {
    return { db: getAppDb(), sqlite: getSqlite() };
  }

  return {
    db: drizzle(appSqlite, { schema }),
    sqlite: appSqlite,
  };
}

function logSummary(summary: PortSummary): void {
  log.info(
    `legacy-port: ${summary.table}: considered=${summary.considered}, inserted=${summary.inserted}, skipped_dedup=${summary.skippedDedup}, skipped_invalid=${summary.skippedInvalid}, skipped_error=${summary.skippedError}`
  );
}

async function markStatus(
  stateStore: LegacyPortStateStore,
  status: LegacyPortStatus
): Promise<void> {
  try {
    await stateStore.setStatus(status);
  } catch (error) {
    log.warn('legacy-port: failed to persist status', {
      status,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function createDefaultLegacyPortStateStore(): Promise<LegacyPortStateStore> {
  return createLegacyPortStateStore();
}

let legacyPortRunning = false;

export async function runLegacyPort(
  userDataPath: string,
  options: RunLegacyPortOptions = {}
): Promise<void> {
  if (legacyPortRunning) throw new Error('A legacy import is already running');
  legacyPortRunning = true;
  try {
    await runLegacyPortExclusive(userDataPath, options);
  } finally {
    legacyPortRunning = false;
  }
}

async function runLegacyPortExclusive(
  userDataPath: string,
  options: RunLegacyPortOptions
): Promise<void> {
  const appTarget = await resolveAppTarget(options.appDb);
  const stateStore = options.stateStore ?? (await createDefaultLegacyPortStateStore());
  const selectedSources = new Set<LegacyImportSource>(options.sources ?? ['v0']);
  const allowNonEmpty = options.allowOverwriteExisting === true;

  /**
   * Every import path clears the destination first. Returns false when the destination
   * holds user data that must not be cleared; otherwise saves a snapshot (throws if that
   * fails, so nothing is deleted without a way back).
   */
  const prepareDestructiveReset = async (): Promise<boolean> => {
    if (!destinationHasUserData(appTarget.sqlite)) return true;
    if (!allowNonEmpty) {
      log.warn(
        'legacy-port: refusing to clear existing projects and tasks; the legacy import was skipped'
      );
      await markStatus(stateStore, 'skipped-legacy');
      return false;
    }
    await snapshotDatabase(appTarget.sqlite, {
      directory: options.backupDirectory ?? join(userDataPath, 'backups'),
      reason: 'pre-legacy-port',
    });
    return true;
  };

  try {
    const status = await stateStore.getStatus();
    if (status) {
      return;
    }
  } catch (error) {
    log.warn('legacy-port: failed to read status, continuing', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  if (selectedSources.size === 0) {
    if (!(await prepareDestructiveReset())) return;
    clearDestinationDataPreservingSignIn(appTarget.sqlite, { allowNonEmpty });
    await markStatus(stateStore, 'wiped-beta');
    return;
  }

  if (selectedSources.has('v1-beta') && !selectedSources.has('v0')) {
    const betaPath = resolveExistingBetaDatabasePath(userDataPath);
    if (hasBetaDatabaseFile(userDataPath)) {
      if (!(await prepareDestructiveReset())) return;
      importBetaDatabaseIntoDestination(appTarget.sqlite, betaPath, { allowNonEmpty });
    } else {
      log.warn('legacy-port: v1-beta source selected but emdash3.db was not found', { betaPath });
    }
  }

  if (!selectedSources.has('v0')) {
    await markStatus(stateStore, selectedSources.has('v1-beta') ? 'kept-beta' : 'skipped-legacy');
    return;
  }

  if (!hasLegacyDatabaseFile(userDataPath)) {
    log.info('legacy-port: no legacy emdash.db found, marking complete');
    await markStatus(stateStore, 'no-legacy-file');
    return;
  }

  const legacyUserDataPath = resolveExistingLegacyUserDataPath(userDataPath);
  const legacyPath = resolveExistingLegacyDatabasePath(userDataPath);
  let legacyDb: Database.Database;

  try {
    legacyDb = openLegacyReadOnly(legacyPath);
  } catch (error) {
    log.warn('legacy-port: failed to open legacy db, will retry next launch', {
      legacyPath,
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  const start = Date.now();

  const betaPath = resolveExistingBetaDatabasePath(userDataPath);
  const shouldCopyBeta = selectedSources.has('v1-beta') && hasBetaDatabaseFile(userDataPath);
  const runImport = () =>
    importAtomically(appTarget.sqlite, () => {
      const remap = createRemapTables();
      if (selectedSources.has('v1-beta')) {
        if (shouldCopyBeta) {
          copyAttachedBetaDatabaseIntoDestination(appTarget.sqlite, { allowNonEmpty });
        } else {
          log.warn('legacy-port: v1-beta source selected but emdash3.db was not found', {
            betaPath,
          });
        }
      } else {
        clearDestinationDataPreservingSignIn(appTarget.sqlite, { allowNonEmpty });
      }

      const selection = buildLegacyProjectSelection({
        appDb: appTarget.db,
        legacyDb,
        selectedSources,
        conflictChoices: options.conflictChoices ?? {},
      });

      if (selectedSources.has('v1-beta')) {
        deleteProjectsById(appTarget.sqlite, selection.replaceAppProjectIds);
      }

      const sshSummary = portSshConnections({
        appDb: appTarget.db,
        legacyDb,
        remap,
        allowedLegacyConnectionIds: selection.allowedLegacySshConnectionIds,
      });
      const projectsSummary = portProjects({
        appDb: appTarget.db,
        legacyDb,
        remap,
        skipLegacyProjectIds: selection.skipLegacyProjectIds,
      });
      const taskResult = portTasks({ appDb: appTarget.db, legacyDb, remap });
      ensureImportedTaskWorkspaces(appTarget.db, taskResult.workspacePaths);
      const conversationsResult = portConversations({
        appDb: appTarget.db,
        legacyDb,
        remap,
        mergedLegacyTaskIds: taskResult.mergedLegacyTaskIds,
        userDataPath: legacyUserDataPath,
      });

      const importedProjectIds = [...new Set(remap.projectId.values())];
      if (importedProjectIds.length > 0) {
        const hosts = appTarget.db
          .selectDistinct({
            location: schema.workspaces.location,
            sshConnectionId: schema.workspaces.sshConnectionId,
          })
          .from(schema.projects)
          .innerJoin(
            schema.workspaces,
            eq(schema.projects.repositoryWorkspaceId, schema.workspaces.id)
          )
          .where(inArray(schema.projects.id, importedProjectIds))
          .all();
        const markerKeys = hosts.flatMap(({ location, sshConnectionId }) => {
          const hostKey = hostRefKey(hostRefFromParts(location, sshConnectionId));
          return [`workspace-registry-backfill:${hostKey}`, `conversation-backfill:${hostKey}`];
        });
        if (markerKeys.length > 0) {
          appTarget.db.delete(schema.kv).where(inArray(schema.kv.key, markerKeys)).run();
        }
      }

      return { sshSummary, projectsSummary, taskResult, conversationsResult };
    });

  if (!(await prepareDestructiveReset())) {
    legacyDb.close();
    return;
  }

  try {
    const { sshSummary, projectsSummary, taskResult, conversationsResult } = shouldCopyBeta
      ? withBetaDatabaseAttached(appTarget.sqlite, betaPath, runImport)
      : runImport();

    logSummary(sshSummary);
    logSummary(projectsSummary);
    logSummary(taskResult.summary);
    logSummary(conversationsResult.summary);

    await renameLegacyTmuxSessions(conversationsResult.tmuxSessionRenames, runLocalCommand);

    try {
      const settingsSummary = await portLegacySettings(legacyUserDataPath, {
        appDb: appTarget.db,
        appSqlite: appTarget.sqlite,
      });
      log.info(
        `legacy-port: settings: imported=${settingsSummary.imported.length}, skipped=${settingsSummary.skipped.length}`
      );
    } catch (error) {
      log.warn('legacy-port: settings: failed to port legacy settings, continuing', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    await markStatus(stateStore, 'completed');

    log.info(`legacy-port: completed in ${Date.now() - start}ms`);
  } catch (error) {
    log.warn('legacy-port: aborted mid-run, will retry next launch', {
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    legacyDb.close();
  }
}
