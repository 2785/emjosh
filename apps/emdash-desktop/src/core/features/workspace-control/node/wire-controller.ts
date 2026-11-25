import { createController, type Controller } from '@emdash/wire/rpc';
import { type AgentConnection, workspaceControlContract } from '../api/contract';
import { getWorkspaceSearch } from './workspace-search-registry';
import type { WorkspaceSearchService } from './workspace-search-service';

export function createWorkspaceControlWireController(
  connection: () => AgentConnection,
  search: () => WorkspaceSearchService | null = getWorkspaceSearch
): Controller {
  const requireSearch = () => {
    const service = search();
    if (!service) throw new Error('Workspace search is not available.');
    return service;
  };
  return createController(workspaceControlContract, {
    connection: async () => connection(),
    searchWorkspaces: async ({ query }) => requireSearch().search(query),
    askAboutWorkspaces: async ({ query }) => requireSearch().ask(query),
  });
}
