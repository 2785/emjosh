import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentCliUpdateSettings } from '../api/schemas';
import { createAgentCliService, type CommandOutcome, type RunCommand } from './service';

const EMPTY: AgentCliUpdateSettings = { autoUpdate: {}, lastResults: {}, lastCheckedAt: {} };
const ok = (stdout = ''): CommandOutcome => ({ exitCode: 0, stdout, stderr: '', timedOut: false });

let home: string;
beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-cli-service-'));
});
afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

async function installFake(relative: string) {
  const file = path.join(home, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, '#!/bin/sh\n', { mode: 0o755 });
  return file;
}

function setup(options: {
  versions: Record<string, string[]>;
  latest?: Record<string, string | null>;
  settings?: AgentCliUpdateSettings;
  activeTurns?: boolean;
  runUpdate?: (command: string, args: string[]) => CommandOutcome;
  now?: () => number;
}) {
  let settings = options.settings ?? EMPTY;
  const calls: { command: string; args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const queues = new Map(Object.entries(options.versions).map(([k, v]) => [k, [...v]]));
  const run: RunCommand = async (command, args, { env }) => {
    calls.push({ command, args, env });
    if (args[0] === '--version') {
      const queue = queues.get(path.basename(command));
      const version = queue && queue.length > 1 ? queue.shift() : queue?.[0];
      return ok(`tool ${version}`);
    }
    return options.runUpdate?.(command, args) ?? ok('updated');
  };
  const env = { PATH: '/nonexistent' } as NodeJS.ProcessEnv;
  const service = createAgentCliService({
    buildEnv: () => env,
    run,
    fetchLatestVersion: vi.fn(async (pkg: string) => options.latest?.[pkg] ?? null),
    settings: { get: async () => settings, set: async (value) => void (settings = value) },
    hasActiveTurns: async () => options.activeTurns ?? false,
    homeDir: home,
    now: options.now,
  });
  return { service, calls, env, getSettings: () => settings };
}

describe('list', () => {
  it('shows installed CLIs with version, install method and update availability', async () => {
    await installFake('.volta/bin/codex');
    await installFake('.volta/bin/volta');
    const { service } = setup({
      versions: { codex: ['0.171.0'] },
      latest: { '@openai/codex': '0.172.0' },
    });
    await service.refreshLatest();
    const clis = await service.list();
    const codex = clis.find((c) => c.id === 'codex');
    expect(codex).toMatchObject({
      installed: true,
      version: '0.171.0',
      latestVersion: '0.172.0',
      updateAvailable: true,
      installMethod: 'Volta',
      autoUpdate: { owner: 'emjosh', enabled: false },
    });
    expect(codex?.updateCommand?.slice(1)).toEqual(['install', '@openai/codex@latest']);
    expect(clis.find((c) => c.id === 'claude')).toMatchObject({ installed: false });
  });

  it('survives a failing latest-version lookup', async () => {
    await installFake('.volta/bin/codex');
    const { service } = setup({ versions: { codex: ['0.171.0'] } });
    const codex = (await service.refreshLatest()).find((c) => c.id === 'codex');
    expect(codex).toMatchObject({
      version: '0.171.0',
      latestVersion: null,
      updateAvailable: false,
    });
  });

  it('reads Claude and OpenCode auto-update from their own config files', async () => {
    await installFake('.local/bin/claude');
    await installFake('.opencode/bin/opencode');
    await fs.writeFile(path.join(home, '.claude.json'), '{"autoUpdates":false}');
    await fs.mkdir(path.join(home, '.config/opencode'), { recursive: true });
    await fs.writeFile(path.join(home, '.config/opencode/opencode.json'), '{"update":"notify"}');
    const { service } = setup({ versions: { claude: ['2.1.0'], opencode: ['2.0.0'] } });
    const clis = await service.list();
    expect(clis.find((c) => c.id === 'claude')?.autoUpdate).toEqual({
      owner: 'cli',
      enabled: false,
      detail: null,
    });
    expect(clis.find((c) => c.id === 'opencode')?.autoUpdate).toMatchObject({
      owner: 'cli',
      enabled: false,
    });
  });
});

describe('update', () => {
  it('runs volta with an argument array and the launched-tool env, then re-checks the version', async () => {
    await installFake('.volta/bin/codex');
    const volta = await installFake('.volta/bin/volta');
    const { service, calls, env, getSettings } = setup({
      versions: { codex: ['0.171.0', '0.171.0', '0.172.0'] },
      latest: { '@openai/codex': '0.172.0' },
    });
    await service.refreshLatest();
    const result = await service.update('codex');
    expect(result).toMatchObject({
      ok: true,
      before: '0.171.0',
      after: '0.172.0',
      output: 'updated',
    });
    const run = calls.find((c) => c.args[0] === 'install');
    expect(run).toMatchObject({ command: volta, args: ['install', '@openai/codex@latest'] });
    expect(run?.env).toBe(env);
    expect(getSettings().lastResults.codex).toEqual(result);
  });

  it('reports success that did not change the version', async () => {
    await installFake('.volta/bin/codex');
    await installFake('.volta/bin/volta');
    const { service } = setup({
      versions: { codex: ['0.171.0'] },
      latest: { '@openai/codex': '0.172.0' },
    });
    await service.refreshLatest();
    const result = await service.update('codex');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/still 0\.171\.0.*0\.172\.0/);
  });

  it('is not an error when already on the newest version', async () => {
    await installFake('.local/bin/agy');
    const { service } = setup({ versions: { agy: ['1.5.17'] } });
    expect(await service.update('antigravity')).toMatchObject({ ok: true, before: '1.5.17' });
  });

  it('shows command output verbatim on failure', async () => {
    await installFake('.local/bin/claude');
    const { service } = setup({
      versions: { claude: ['2.1.0'] },
      runUpdate: () => ({ exitCode: 3, stdout: 'out', stderr: 'EACCES: nope', timedOut: false }),
    });
    const result = await service.update('claude');
    expect(result).toMatchObject({ ok: false, output: 'out\nEACCES: nope' });
    expect(result.error).toMatch(/code 3/);
  });

  it('reports a missing or blocked install without running anything', async () => {
    const { service, calls } = setup({ versions: {} });
    expect((await service.update('claude')).error).toMatch(/not installed/);
    await installFake('.volta/bin/codex');
    expect((await service.update('codex')).error).toMatch(/volta binary was not found/);
    expect(calls).toHaveLength(0);
  });
});

describe('setAutoUpdate', () => {
  it('writes Claude autoUpdates to ~/.claude.json, keeping other keys', async () => {
    await fs.writeFile(path.join(home, '.claude.json'), '{"userID":"u","autoUpdates":true}');
    const { service } = setup({ versions: {} });
    expect(await service.setAutoUpdate('claude', false)).toEqual({ ok: true, error: null });
    expect(JSON.parse(await fs.readFile(path.join(home, '.claude.json'), 'utf8'))).toEqual({
      userID: 'u',
      autoUpdates: false,
    });
  });

  it('writes OpenCode update to auto/disable', async () => {
    const { service } = setup({ versions: {} });
    await service.setAutoUpdate('opencode', false);
    const file = path.join(home, '.config/opencode/opencode.json');
    expect(JSON.parse(await fs.readFile(file, 'utf8')).update).toBe('disable');
    await service.setAutoUpdate('opencode', true);
    expect(JSON.parse(await fs.readFile(file, 'utf8')).update).toBe('auto');
  });

  it('stores Codex in Emjosh settings and returns file errors', async () => {
    const { service, getSettings } = setup({ versions: {} });
    await service.setAutoUpdate('codex', true);
    expect(getSettings().autoUpdate.codex).toBe(true);
    await fs.writeFile(path.join(home, '.claude.json'), 'not json');
    const failed = await service.setAutoUpdate('claude', true);
    expect(failed.ok).toBe(false);
    expect(failed.error).toMatch(/not plain JSON/);
  });
});

describe('autoUpdateSweep', () => {
  const DAY = 24 * 60 * 60_000;
  const enabled: AgentCliUpdateSettings = { ...EMPTY, autoUpdate: { codex: true } };

  it('updates a stale Emjosh-owned CLI and records the check', async () => {
    await installFake('.volta/bin/codex');
    await installFake('.volta/bin/volta');
    const { service, calls, getSettings } = setup({
      versions: { codex: ['0.171.0', '0.172.0'] },
      latest: { '@openai/codex': '0.172.0' },
      settings: enabled,
      now: () => 5 * DAY,
    });
    await service.autoUpdateSweep();
    expect(calls.some((c) => c.args[0] === 'install')).toBe(true);
    expect(getSettings().lastResults.codex).toMatchObject({ trigger: 'auto', ok: true });
    expect(getSettings().lastCheckedAt.codex).toBe(5 * DAY);
  });

  it('does nothing when toggled off, checked within a day, or already current', async () => {
    await installFake('.volta/bin/codex');
    await installFake('.volta/bin/volta');
    const latest = { '@openai/codex': '0.172.0' };
    for (const settings of [EMPTY, { ...enabled, lastCheckedAt: { codex: 4.5 * DAY } }]) {
      const { service, calls } = setup({
        versions: { codex: ['0.171.0'] },
        latest,
        settings,
        now: () => 5 * DAY,
      });
      await service.autoUpdateSweep();
      expect(calls.filter((c) => c.args[0] === 'install')).toHaveLength(0);
    }
    const current = setup({
      versions: { codex: ['0.172.0'] },
      latest,
      settings: enabled,
      now: () => 5 * DAY,
    });
    await current.service.autoUpdateSweep();
    expect(current.calls.filter((c) => c.args[0] === 'install')).toHaveLength(0);
    expect(current.getSettings().lastCheckedAt.codex).toBe(5 * DAY);
  });

  it('waits while a conversation is mid-turn and retries on the next sweep', async () => {
    await installFake('.volta/bin/codex');
    await installFake('.volta/bin/volta');
    const { service, calls, getSettings } = setup({
      versions: { codex: ['0.171.0'] },
      latest: { '@openai/codex': '0.172.0' },
      settings: enabled,
      activeTurns: true,
      now: () => 5 * DAY,
    });
    await service.autoUpdateSweep();
    expect(calls).toHaveLength(0);
    expect(getSettings().lastCheckedAt.codex).toBeUndefined();
  });

  it('retries later when the latest version cannot be looked up', async () => {
    await installFake('.volta/bin/codex');
    const { service, calls, getSettings } = setup({
      versions: { codex: ['0.171.0'] },
      settings: enabled,
      now: () => 5 * DAY,
    });
    await service.autoUpdateSweep();
    expect(calls).toHaveLength(0);
    expect(getSettings().lastCheckedAt.codex).toBeUndefined();
  });

  it('never touches CLIs that update themselves', async () => {
    await installFake('.local/bin/claude');
    const { service, calls } = setup({
      versions: { claude: ['2.1.0'] },
      latest: { '@anthropic-ai/claude-code': '9.9.9' },
      settings: { ...EMPTY, autoUpdate: { claude: true } },
      now: () => 5 * DAY,
    });
    await service.autoUpdateSweep();
    expect(calls).toHaveLength(0);
  });
});
