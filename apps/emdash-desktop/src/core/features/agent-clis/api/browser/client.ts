import type { ContractClient } from '@emdash/wire/rpc';
import { domainClient } from '@core/primitives/wire/browser/connection';
import { agentClisContract, agentClisDomain } from '../contract';

export function getAgentClisClient(): Promise<ContractClient<typeof agentClisContract>> {
  return domainClient(agentClisDomain, agentClisContract);
}
