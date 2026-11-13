import { defineContract, procedure } from '@emdash/wire/rpc';
import { z } from 'zod';

export type RemoteControlDevice = {
  id: string;
  name: string;
  createdAt: number;
  lastSeenAt: number | null;
  /** Notifications are turned on on the device. */
  push: boolean;
};

export type RemoteControlStatus = {
  enabled: boolean;
  /** Serving on 127.0.0.1; false when enabled but it could not start (see `error`). */
  running: boolean;
  port: number;
  error: string | null;
  tailscale: {
    installed: boolean;
    /** This machine's tailnet name; null when Tailscale isn't connected. */
    dnsName: string | null;
    /** Where paired devices open remote control, once Tailscale Serve forwards to it. */
    servedUrl: string | null;
  };
  devices: RemoteControlDevice[];
};

export const remoteControlDomain = 'remoteControl' as const;

/** Remote control: the app served to paired devices over Tailscale. */
export const remoteControlContract = defineContract({
  status: procedure({ input: z.void(), output: z.custom<RemoteControlStatus>() }),
  setEnabled: procedure({
    input: z.object({ enabled: z.boolean() }),
    output: z.custom<RemoteControlStatus>(),
  }),
  /** A six-digit code a new device enters to pair; valid for five minutes, once. */
  createPairingCode: procedure({
    input: z.void(),
    output: z.object({ code: z.string(), expiresAt: z.number() }),
  }),
  revokeDevice: procedure({
    input: z.object({ id: z.string() }),
    output: z.custom<RemoteControlStatus>(),
  }),
  /** Starts a workspace in a project with a first prompt, as agents do over workspace control. */
  createWorkspace: procedure({
    input: z.object({ projectId: z.string(), prompt: z.string().min(1) }),
    output: z.object({ id: z.string(), name: z.string() }),
  }),
  setTailscaleServe: procedure({
    input: z.object({ enabled: z.boolean() }),
    output: z.custom<RemoteControlStatus>(),
  }),
});
