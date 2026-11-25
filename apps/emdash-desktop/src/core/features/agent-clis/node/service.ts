import { accessSync, constants, realpathSync } from 'node:fs';
import path from 'node:path';
import type { Scope } from '@emdash/shared/concurrency';
import {
  agentCliUpdateSettingsSchema,
  type AgentCliId,
  type AgentCliInfo,
  type AgentCliUpdateResult,
  type AgentCliUpdateSettings,
} from '../api/schemas';
import { readJsonKey, writeJsonKey } from './config-files';
import { AGENT_CLI_DEFINITIONS, type AgentCliDefinition } from './definitions';
import {
  detectInstallMethod,
  INSTALL_METHOD_LABELS,
  planUpdate,
  type UpdatePlan,
} from './install-method';
import { compareVersions, parseVersion } from './versions';

export type CommandOutcome = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Set when the process could not be started. */
  spawnError?: string;
};

export type RunCommand = (
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; timeoutMs: number }
) => Promise<CommandOutcome>;

export type AgentCliServiceDeps = {
  /** The user's login-shell environment, so the same binaries are found as in a terminal. */
  buildEnv(): NodeJS.ProcessEnv;
  run: RunCommand;
  /** Newest published version of an npm package; null when it cannot be determined. */
  fetchLatestVersion(npmPackage: string): Promise<string | null>;
  settings: {
    get(): Promise<AgentCliUpdateSettings>;
    set(value: AgentCliUpdateSettings): Promise<void>;
  };
  /** Whether any conversation of this CLI's provider is mid-turn. */
  hasActiveTurns(id: AgentCliId): Promise<boolean>;
  homeDir: string;
  now?: () => number;
};

const VERSION_TIMEOUT_MS = 8_000;
const UPDATE_TIMEOUT_MS = 5 * 60_000;
const LATEST_TTL_MS = 10 * 60_000;
const AUTO_CHECK_INTERVAL_MS = 24 * 60 * 60_000;
const SWEEP_INTERVAL_MS = 60 * 60_000;
const SWEEP_STARTUP_DELAY_MS = 90_000;

type Located = { path: string; realpath: string };

export type AgentCliService = ReturnType<typeof createAgentCliService>;

export function createAgentCliService(deps: AgentCliServiceDeps) {
  const now = deps.now ?? Date.now;
  const latestCache = new Map<string, { at: number; version: string | null }>();
  const updating = new Set<AgentCliId>();
  let settingsQueue: Promise<unknown> = Promise.resolve();

  const definition = (id: AgentCliId): AgentCliDefinition => {
    const found = AGENT_CLI_DEFINITIONS.find((d) => d.id === id);
    if (!found) throw new Error(`Unknown agent CLI: ${id}`);
    return found;
  };

  function findExecutable(
    names: string[],
    env: NodeJS.ProcessEnv,
    extraDirs: string[]
  ): Located | null {
    const dirs = [...(env.PATH ?? '').split(path.delimiter).filter(Boolean), ...extraDirs];
    const exts =
      process.platform === 'win32'
        ? ['', ...(env.PATHEXT ?? '.EXE').split(';').filter(Boolean)]
        : [''];
    for (const dir of dirs) {
      for (const name of names) {
        for (const ext of exts) {
          const candidate = path.join(dir, name + ext);
          try {
            accessSync(candidate, constants.X_OK);
            return { path: candidate, realpath: realpathSync(candidate) };
          } catch {
            // not here
          }
        }
      }
    }
    return null;
  }

  const locate = (def: AgentCliDefinition, env: NodeJS.ProcessEnv) =>
    findExecutable(def.binaryNames, env, def.extraDirs(deps.homeDir));

  async function probeVersion(binary: string, env: NodeJS.ProcessEnv): Promise<string | null> {
    const out = await deps.run(binary, ['--version'], { env, timeoutMs: VERSION_TIMEOUT_MS });
    if (out.spawnError || out.timedOut) return null;
    return parseVersion(`${out.stdout}\n${out.stderr}`);
  }

  function updatePlanFor(def: AgentCliDefinition, located: Located, env: NodeJS.ProcessEnv) {
    const method = detectInstallMethod(located);
    const voltaPath =
      method === 'volta'
        ? (findExecutable(['volta'], env, [path.dirname(located.path)])?.path ?? null)
        : null;
    const plan: UpdatePlan = planUpdate(def.id, { path: located.path, method, voltaPath });
    return { method, plan };
  }

  async function readSettings(): Promise<AgentCliUpdateSettings> {
    return agentCliUpdateSettingsSchema.parse(await deps.settings.get());
  }

  /** Serialises read-modify-write of the shared settings value. */
  function patchSettings(
    change: (current: AgentCliUpdateSettings) => AgentCliUpdateSettings
  ): Promise<void> {
    const next = settingsQueue.then(async () => deps.settings.set(change(await readSettings())));
    settingsQueue = next.catch(() => undefined);
    return next;
  }

  async function autoUpdateInfo(
    def: AgentCliDefinition,
    env: NodeJS.ProcessEnv,
    settings: AgentCliUpdateSettings
  ): Promise<AgentCliInfo['autoUpdate']> {
    if (def.autoUpdate.owner === 'emjosh') {
      return { owner: 'emjosh', enabled: settings.autoUpdate[def.id] === true, detail: null };
    }
    const config = def.autoUpdate;
    const file = config.file(deps.homeDir, env);
    try {
      return { owner: 'cli', ...config.read(await readJsonKey(file, config.key)) };
    } catch (error) {
      return { owner: 'cli', enabled: false, detail: (error as Error).message };
    }
  }

  async function infoFor(
    def: AgentCliDefinition,
    env: NodeJS.ProcessEnv,
    settings: AgentCliUpdateSettings
  ): Promise<AgentCliInfo> {
    const located = locate(def, env);
    const autoUpdate = await autoUpdateInfo(def, env, settings);
    const base = {
      id: def.id,
      name: def.name,
      autoUpdate,
      updating: updating.has(def.id),
      lastUpdate: settings.lastResults[def.id] ?? null,
    };
    if (!located) {
      return {
        ...base,
        installed: false,
        path: null,
        version: null,
        latestVersion: null,
        updateAvailable: false,
        installMethod: null,
        updateCommand: null,
        updateBlockedReason: 'Not installed.',
      };
    }
    const version = await probeVersion(located.path, env);
    const latestVersion = latestCache.get(def.id)?.version ?? null;
    const { method, plan } = updatePlanFor(def, located, env);
    return {
      ...base,
      installed: true,
      path: located.path,
      version,
      latestVersion,
      updateAvailable:
        version !== null && latestVersion !== null && compareVersions(latestVersion, version) > 0,
      installMethod: INSTALL_METHOD_LABELS[method],
      updateCommand: plan.kind === 'run' ? [plan.command, ...plan.args] : null,
      updateBlockedReason: plan.kind === 'blocked' ? plan.reason : null,
    };
  }

  async function list(): Promise<AgentCliInfo[]> {
    const env = deps.buildEnv();
    const settings = await readSettings();
    return Promise.all(AGENT_CLI_DEFINITIONS.map((def) => infoFor(def, env, settings)));
  }

  async function latestVersion(def: AgentCliDefinition, force: boolean): Promise<string | null> {
    if (!def.npmPackage) return null;
    const cached = latestCache.get(def.id);
    if (!force && cached && now() - cached.at < LATEST_TTL_MS) return cached.version;
    let version: string | null = null;
    try {
      version = await deps.fetchLatestVersion(def.npmPackage);
    } catch {
      // A failed lookup must not break the page; keep whatever was known.
      return cached?.version ?? null;
    }
    latestCache.set(def.id, { at: now(), version });
    return version;
  }

  async function refreshLatest(): Promise<AgentCliInfo[]> {
    await Promise.all(AGENT_CLI_DEFINITIONS.map((def) => latestVersion(def, false)));
    return list();
  }

  async function update(
    id: AgentCliId,
    trigger: AgentCliUpdateResult['trigger'] = 'manual'
  ): Promise<AgentCliUpdateResult> {
    const def = definition(id);
    const env = deps.buildEnv();
    const record = async (result: AgentCliUpdateResult) => {
      await patchSettings((s) => ({ ...s, lastResults: { ...s.lastResults, [id]: result } }));
      return result;
    };
    const fail = (error: string, command: string[] = [], before: string | null = null) =>
      record({ ok: false, at: now(), trigger, command, before, after: before, output: '', error });

    if (updating.has(id)) return fail('An update is already running.');
    const located = locate(def, env);
    if (!located) return fail(`${def.name} is not installed.`);
    const { plan } = updatePlanFor(def, located, env);
    if (plan.kind === 'blocked') return fail(plan.reason);

    updating.add(id);
    try {
      const before = await probeVersion(located.path, env);
      const command = [plan.command, ...plan.args];
      const out = await deps.run(plan.command, plan.args, { env, timeoutMs: UPDATE_TIMEOUT_MS });
      const output = [out.stdout, out.stderr].filter(Boolean).join('\n');
      const after = await probeVersion(located.path, env);
      let error: string | null = null;
      if (out.spawnError) error = out.spawnError;
      else if (out.timedOut) error = 'The update timed out.';
      else if (out.exitCode !== 0) error = `The update command exited with code ${out.exitCode}.`;
      else if (after !== null && before !== null && after === before) {
        const latest = latestCache.get(id)?.version ?? null;
        if (latest && compareVersions(latest, after) > 0) {
          error = `The command succeeded but ${def.name} is still ${after}; the newest release is ${latest}. A different copy may have been updated.`;
        }
      }
      latestCache.delete(id);
      return await record({
        ok: error === null,
        at: now(),
        trigger,
        command,
        before,
        after,
        output,
        error,
      });
    } finally {
      updating.delete(id);
    }
  }

  async function setAutoUpdate(
    id: AgentCliId,
    enabled: boolean
  ): Promise<{ ok: boolean; error: string | null }> {
    const def = definition(id);
    try {
      if (def.autoUpdate.owner === 'emjosh') {
        await patchSettings((s) => ({ ...s, autoUpdate: { ...s.autoUpdate, [id]: enabled } }));
      } else {
        const config = def.autoUpdate;
        await writeJsonKey(
          config.file(deps.homeDir, deps.buildEnv()),
          config.key,
          config.write(enabled)
        );
      }
      return { ok: true, error: null };
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
  }

  /**
   * Updates Emjosh-owned CLIs that have auto-update on, at most once a day each, and never while
   * a conversation of that CLI is mid-turn (it is retried on the next sweep).
   */
  async function autoUpdateSweep(): Promise<void> {
    for (const def of AGENT_CLI_DEFINITIONS) {
      if (def.autoUpdate.owner !== 'emjosh') continue;
      const settings = await readSettings();
      if (settings.autoUpdate[def.id] !== true) continue;
      if (now() - (settings.lastCheckedAt[def.id] ?? 0) < AUTO_CHECK_INTERVAL_MS) continue;
      const env = deps.buildEnv();
      const located = locate(def, env);
      if (!located) continue;
      if (await deps.hasActiveTurns(def.id)) continue;

      const latest = def.npmPackage ? await latestVersion(def, true) : null;
      if (def.npmPackage && !latest) continue;
      const version = await probeVersion(located.path, env);
      const stale = latest && version ? compareVersions(latest, version) > 0 : true;
      if (stale) await update(def.id, 'auto');
      await patchSettings((s) => ({
        ...s,
        lastCheckedAt: { ...s.lastCheckedAt, [def.id]: now() },
      }));
    }
  }

  function startAutoUpdates(scope: Scope): void {
    const sweep = () => void autoUpdateSweep().catch(() => undefined);
    const first = setTimeout(sweep, SWEEP_STARTUP_DELAY_MS);
    const every = setInterval(sweep, SWEEP_INTERVAL_MS);
    first.unref();
    every.unref();
    scope.add(() => {
      clearTimeout(first);
      clearInterval(every);
    });
  }

  return { list, refreshLatest, update, setAutoUpdate, autoUpdateSweep, startAutoUpdates };
}
