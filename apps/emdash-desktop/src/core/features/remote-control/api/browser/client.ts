import type { ContractClient } from '@emdash/wire/rpc';
import { domainClient } from '@core/primitives/wire/browser/connection';
import { remoteControlContract, remoteControlDomain } from '../contract';

export type RemoteControlClient = ContractClient<typeof remoteControlContract>;

export function getRemoteControlClient(): Promise<RemoteControlClient> {
  return domainClient<RemoteControlClient>(remoteControlDomain, remoteControlContract);
}
