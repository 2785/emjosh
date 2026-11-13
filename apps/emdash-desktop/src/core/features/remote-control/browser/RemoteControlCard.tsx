import { SettingsCard } from '@emdash/ui/react/patterns';
import { Button, SeparatedList, Switch, toast } from '@emdash/ui/react/primitives';
import { useCallback, useEffect, useState } from 'react';
import type { RemoteControlStatus } from '@core/features/remote-control/api';
import { getRemoteControlClient } from '@core/features/remote-control/api/browser/client';
import { SettingRow } from '@core/features/settings/browser/components/SettingRow';
import { PRODUCT_NAME } from '@core/primitives/app-identity/api/app-identity';

/** Settings → General → Remote control: serve the app to paired devices over Tailscale. */
export function RemoteControlCard() {
  const [status, setStatus] = useState<RemoteControlStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [pairing, setPairing] = useState<{ code: string; expiresAt: number } | null>(null);

  const refresh = useCallback(async () => {
    setStatus(await (await getRemoteControlClient()).status());
  }, []);

  useEffect(() => {
    void refresh();
    // Devices pair from elsewhere; keep the list current while this page is open.
    const timer = setInterval(() => void refresh(), 5_000);
    return () => clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    if (!pairing) return;
    const timer = setTimeout(() => setPairing(null), Math.max(0, pairing.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [pairing]);

  const act = async (action: () => Promise<RemoteControlStatus | void>) => {
    setBusy(true);
    try {
      const next = await action();
      if (next) setStatus(next);
    } catch (error) {
      toast.error('Remote control', {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(false);
    }
  };

  const enabled = status?.enabled ?? false;
  const tailscale = status?.tailscale;

  return (
    <SettingsCard>
      <SeparatedList gap="1rem" direction="column">
        <SettingRow
          title="Remote control"
          description={`Use ${PRODUCT_NAME} from your phone or another computer: the whole app, plus notifications when workspaces finish or need you.`}
          control={
            <Switch
              checked={enabled}
              disabled={busy || status === null}
              onCheckedChange={(checked) =>
                void act(async () =>
                  (await getRemoteControlClient()).setEnabled({ enabled: checked })
                )
              }
              aria-label="Remote control"
            />
          }
        />
        {enabled && status && (
          <>
            {status.error && <p className="text-sm text-foreground-destructive">{status.error}</p>}
            <SettingRow
              title="Tailscale"
              description={
                !tailscale?.installed
                  ? 'Install Tailscale on this computer and on your devices: remote control is only reachable through your tailnet.'
                  : !tailscale.dnsName
                    ? 'Connect Tailscale on this computer to reach remote control from your devices.'
                    : tailscale.servedUrl
                      ? `Open ${tailscale.servedUrl} on a device in your tailnet. On iPhone, add it to the Home Screen to get notifications.`
                      : `Serve remote control on your tailnet at https://${tailscale.dnsName}:8443/.`
              }
              control={
                tailscale?.dnsName ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      void act(async () =>
                        (await getRemoteControlClient()).setTailscaleServe({
                          enabled: !tailscale.servedUrl,
                        })
                      )
                    }
                  >
                    {tailscale.servedUrl ? 'Stop serving' : 'Serve on tailnet'}
                  </Button>
                ) : null
              }
            />
            <SettingRow
              title="Pair a device"
              description={
                pairing
                  ? `Enter this code on the device. It works once, for five minutes.`
                  : 'Open remote control on the device, then create a code to enter there.'
              }
              control={
                pairing ? (
                  <span className="font-mono text-2xl tracking-[0.3em] text-foreground">
                    {pairing.code}
                  </span>
                ) : (
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      void act(async () => {
                        setPairing(await (await getRemoteControlClient()).createPairingCode());
                      })
                    }
                  >
                    Create code
                  </Button>
                )
              }
            />
            {status.devices.map((device) => (
              <SettingRow
                key={device.id}
                title={device.name}
                description={[
                  `Paired ${new Date(device.createdAt).toLocaleDateString()}`,
                  device.lastSeenAt
                    ? `last used ${new Date(device.lastSeenAt).toLocaleString()}`
                    : null,
                  device.push ? 'notifications on' : 'notifications off',
                ]
                  .filter(Boolean)
                  .join(' · ')}
                control={
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      void act(async () =>
                        (await getRemoteControlClient()).revokeDevice({ id: device.id })
                      )
                    }
                  >
                    Remove
                  </Button>
                }
              />
            ))}
          </>
        )}
      </SeparatedList>
    </SettingsCard>
  );
}
