import { taskAgentStatus } from '@core/features/conversations/api/browser/conversation-selectors';
import {
  getProjectManagerStore,
  getProjectStore,
  projectDisplayName,
} from '@core/features/projects/api/browser/stores/project-selectors';
import {
  getRegisteredTaskData,
  getTaskManagerStore,
  getTaskStore,
} from '@core/features/tasks/api/browser/task-state/task-selectors';
import { taskViewDef } from '@core/features/tasks/contributions/views';
import { getNavigation } from '@core/primitives/navigation/browser/navigation-selectors';
import type { ViewRef } from '@core/primitives/views/api';
import { getWorkspaceControlClient } from './client';

/** What opening a workspace needs to know about it. */
export type WorkspaceTarget = { id: string; projectId: string; name: string; archived: boolean };

export type OpenWorkspaceDeps = {
  navigate(ref: ViewRef): void;
  restore(projectId: string, taskId: string): Promise<void>;
  /** Whether the task is archived right now, if its project is loaded. */
  isArchived(projectId: string, taskId: string): boolean | undefined;
};

const appDeps: OpenWorkspaceDeps = {
  navigate: (ref) => getNavigation().navigate(ref),
  async restore(projectId, taskId) {
    const manager = getTaskManagerStore(projectId);
    if (!manager) throw new Error('The workspace’s project is not open.');
    await manager.restoreTask(taskId);
  },
  isArchived(projectId, taskId) {
    const data = getRegisteredTaskData(projectId, taskId);
    return data ? !!data.archivedAt : undefined;
  },
};

/**
 * Opens a workspace in the app, unarchiving it first. Callers confirm the unarchive with the
 * user before calling (see needsUnarchive).
 */
export async function openWorkspace(
  target: WorkspaceTarget,
  deps: OpenWorkspaceDeps = appDeps
): Promise<void> {
  if (needsUnarchive(target, deps)) await deps.restore(target.projectId, target.id);
  deps.navigate(taskViewDef({ projectId: target.projectId, taskId: target.id }));
}

export function needsUnarchive(target: WorkspaceTarget, deps: OpenWorkspaceDeps = appDeps) {
  return deps.isArchived(target.projectId, target.id) ?? target.archived;
}

/** A workspace by id: from the loaded projects, else from the workspace search. */
export async function resolveWorkspace(workspaceId: string): Promise<WorkspaceTarget | null> {
  for (const projectId of getProjectManagerStore().projects.keys()) {
    const data = getRegisteredTaskData(projectId, workspaceId);
    if (data) return { id: workspaceId, projectId, name: data.name, archived: !!data.archivedAt };
  }
  const client = await getWorkspaceControlClient();
  const result = await client.searchWorkspaces({ query: workspaceId });
  const hit = result.hits.find((candidate) => candidate.workspace.id === workspaceId);
  return hit
    ? {
        id: hit.workspace.id,
        projectId: hit.workspace.projectId,
        name: hit.workspace.name,
        archived: hit.workspace.archived,
      }
    : null;
}

/**
 * Opens the workspace a chat link (`emjosh://workspace/<id>`) points at; an archived one is
 * unarchived after the user confirms.
 */
export async function openWorkspaceLink(
  workspaceId: string,
  confirmUnarchive: (name: string) => Promise<boolean>
): Promise<'opened' | 'cancelled' | 'not-found'> {
  const target = await resolveWorkspace(workspaceId);
  if (!target) return 'not-found';
  if (needsUnarchive(target) && !(await confirmUnarchive(target.name))) return 'cancelled';
  await openWorkspace(target);
  return 'opened';
}

/**
 * Tooltip text for a workspace chip (name, project, status), from the loaded stores; null when
 * no loaded project has the workspace (unknown or deleted), which renders the link as plain text.
 */
export function workspaceLinkTooltip(workspaceId: string): string | null {
  for (const projectId of getProjectManagerStore().projects.keys()) {
    const data = getRegisteredTaskData(projectId, workspaceId);
    if (!data) continue;
    const store = getTaskStore(projectId, workspaceId);
    const status = data.archivedAt ? 'archived' : store ? taskAgentStatus(store) : null;
    const project = projectDisplayName(getProjectStore(projectId));
    return [data.name, project, status].filter(Boolean).join(' · ');
  }
  return null;
}
