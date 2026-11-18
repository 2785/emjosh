import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runTailscaleServe, servesPort, tailscaleSetupUrl } from './remote-control-service';
import { PAIRING_CODE_TTL_MS, RemoteControlStore } from './remote-control-store';

describe('remote control store', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const makeStore = (now: () => number = Date.now) => {
    dir = mkdtempSync(join(tmpdir(), 'remote-store-'));
    return new RemoteControlStore(join(dir, 'state.json'), now);
  };

  it('pairs once per code, authenticates the token, and forgets revoked devices', async () => {
    const store = makeStore();
    const { code } = store.createPairingCode();
    const paired = await store.pair(code, ' Phone ');
    expect(paired?.device.name).toBe('Phone');
    expect(await store.pair(code, 'Again')).toBeNull();
    expect((await store.authenticate(paired!.token))?.id).toBe(paired!.device.id);
    expect(await store.authenticate('not-a-token')).toBeNull();
    expect(statSync(join(dir, 'state.json')).mode & 0o777).toBe(0o600);

    await store.revoke(paired!.device.id);
    expect(await store.authenticate(paired!.token)).toBeNull();
  });

  it('ends a code after five wrong guesses or once it expires', async () => {
    let now = 1_000;
    const store = makeStore(() => now);
    const { code } = store.createPairingCode();
    for (let i = 0; i < 5; i++) expect(await store.pair('999999x', 'x')).toBeNull();
    expect(await store.pair(code, 'x')).toBeNull();

    const fresh = store.createPairingCode();
    now += PAIRING_CODE_TTL_MS + 1;
    expect(await store.pair(fresh.code, 'x')).toBeNull();
  });

  it('keeps its keys and devices across restarts', async () => {
    const store = makeStore();
    const { code } = store.createPairingCode();
    const paired = await store.pair(code, 'Phone');
    const key = (await store.load()).vapid.publicKey;
    const reopened = new RemoteControlStore(join(dir, 'state.json'));
    expect((await reopened.load()).vapid.publicKey).toBe(key);
    expect((await reopened.authenticate(paired!.token))?.name).toBe('Phone');
  });
});

describe('servesPort', () => {
  it('recognizes the Tailscale Serve config that proxies our port', () => {
    const config = {
      TCP: { '8443': { HTTPS: true } },
      Web: { 'mac.tail.ts.net:8443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:7425' } } } },
    };
    expect(servesPort(config, 7425)).toBe(true);
    expect(servesPort(config, 7426)).toBe(false);
    expect(servesPort({}, 7425)).toBe(false);
  });
});

describe('tailscaleSetupUrl', () => {
  it('finds the link Tailscale prints when Serve is off for the tailnet', () => {
    const output =
      '\nServe is not enabled on your tailnet.\nTo enable, visit:\n\n         https://login.tailscale.com/f/serve?node=abc123\n';
    expect(tailscaleSetupUrl(output)).toBe('https://login.tailscale.com/f/serve?node=abc123');
    expect(tailscaleSetupUrl('Available within your tailnet')).toBeNull();
  });
});

describe('runTailscaleServe', () => {
  it('returns the setup link instead of waiting on the CLI', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'fake-tailscale-'));
    const binary = join(scratch, 'tailscale');
    writeFileSync(
      binary,
      '#!/bin/sh\necho "Serve is not enabled on your tailnet."\necho "    https://login.tailscale.com/f/serve?node=xyz"\nsleep 30\n',
      { mode: 0o755 }
    );
    try {
      const started = Date.now();
      const result = await runTailscaleServe(binary, ['serve']);
      expect(result.setupUrl).toBe('https://login.tailscale.com/f/serve?node=xyz');
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
