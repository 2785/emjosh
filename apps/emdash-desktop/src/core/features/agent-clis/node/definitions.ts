import path from 'node:path';
import type { AgentCliId } from '../api/schemas';

export type AutoUpdateConfig =
  | {
      owner: 'cli';
      /** Config file the CLI reads its own auto-update setting from. */
      file: (home: string, env: NodeJS.ProcessEnv) => string;
      read: (value: unknown) => { enabled: boolean; detail: string | null };
      key: string;
      write: (enabled: boolean) => unknown;
    }
  | { owner: 'emjosh' };

export type AgentCliDefinition = {
  id: AgentCliId;
  name: string;
  binaryNames: string[];
  /** Directories searched after PATH, for installers that do not add themselves to it. */
  extraDirs: (home: string) => string[];
  /** npm package whose `latest` dist-tag is the newest release; null when there is no source. */
  npmPackage: string | null;
  autoUpdate: AutoUpdateConfig;
};

const configHome = (home: string, env: NodeJS.ProcessEnv) =>
  env.XDG_CONFIG_HOME || path.join(home, '.config');

export const AGENT_CLI_DEFINITIONS: readonly AgentCliDefinition[] = [
  {
    id: 'claude',
    name: 'Claude Code',
    binaryNames: ['claude'],
    extraDirs: (home) => [path.join(home, '.local', 'bin')],
    npmPackage: '@anthropic-ai/claude-code',
    autoUpdate: {
      owner: 'cli',
      file: (home) => path.join(home, '.claude.json'),
      key: 'autoUpdates',
      read: (value) => ({ enabled: value !== false, detail: null }),
      write: (enabled) => enabled,
    },
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    binaryNames: ['opencode'],
    extraDirs: (home) => [path.join(home, '.opencode', 'bin')],
    npmPackage: null,
    autoUpdate: {
      owner: 'cli',
      file: (home, env) => path.join(configHome(home, env), 'opencode', 'opencode.json'),
      key: 'update',
      read: (value) =>
        value === 'notify'
          ? {
              enabled: false,
              detail: 'Set to "notify": OpenCode announces updates without installing.',
            }
          : { enabled: value !== 'disable', detail: null },
      write: (enabled) => (enabled ? 'auto' : 'disable'),
    },
  },
  {
    id: 'codex',
    name: 'Codex',
    binaryNames: ['codex'],
    extraDirs: (home) => [path.join(home, '.volta', 'bin')],
    npmPackage: '@openai/codex',
    autoUpdate: { owner: 'emjosh' },
  },
  {
    id: 'antigravity',
    name: 'Antigravity',
    binaryNames: ['agy'],
    extraDirs: (home) => [path.join(home, '.local', 'bin')],
    npmPackage: null,
    autoUpdate: { owner: 'emjosh' },
  },
];
