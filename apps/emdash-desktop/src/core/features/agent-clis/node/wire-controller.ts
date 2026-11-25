import { createController, type Controller } from '@emdash/wire/rpc';
import { agentClisContract } from '../api/contract';
import type { AgentCliService } from './service';

export function createAgentClisWireController(service: AgentCliService): Controller {
  return createController(agentClisContract, {
    list: () => service.list(),
    refreshLatest: () => service.refreshLatest(),
    update: ({ id }) => service.update(id),
    setAutoUpdate: ({ id, enabled }) => service.setAutoUpdate(id, enabled),
  });
}
