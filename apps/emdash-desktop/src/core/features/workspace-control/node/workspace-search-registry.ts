import type { WorkspaceSearchService } from './workspace-search-service';

/**
 * The workspace search, once workspace control has started (after the wire controllers are
 * created). Null in builds or boots without workspace control.
 */
let current: WorkspaceSearchService | null = null;

export function setWorkspaceSearch(service: WorkspaceSearchService | null): void {
  current = service;
}

export function getWorkspaceSearch(): WorkspaceSearchService | null {
  return current;
}
