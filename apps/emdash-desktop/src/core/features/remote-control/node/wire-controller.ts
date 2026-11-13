import { createController, type Controller } from '@emdash/wire/rpc';
import { remoteControlContract, type RemoteControlStatus } from '../api/contract';

/** What the controller needs from the host's remote control service. */
export type RemoteControlOperations = {
  status(): Promise<RemoteControlStatus>;
  setEnabled(enabled: boolean): Promise<RemoteControlStatus>;
  createPairingCode(): { code: string; expiresAt: number };
  revokeDevice(id: string): Promise<RemoteControlStatus>;
  enableTailscale(): Promise<RemoteControlStatus>;
  disableTailscale(): Promise<RemoteControlStatus>;
};

export function createRemoteControlWireController(operations: RemoteControlOperations): Controller {
  return createController(remoteControlContract, {
    status: () => operations.status(),
    setEnabled: ({ enabled }) => operations.setEnabled(enabled),
    createPairingCode: () => operations.createPairingCode(),
    revokeDevice: ({ id }) => operations.revokeDevice(id),
    setTailscaleServe: ({ enabled }) =>
      enabled ? operations.enableTailscale() : operations.disableTailscale(),
  });
}
