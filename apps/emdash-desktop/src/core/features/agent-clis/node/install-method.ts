import type { AgentCliId } from '../api/schemas';

export type InstallMethod = 'volta' | 'homebrew' | 'bun' | 'pnpm' | 'npm' | 'native' | 'unknown';

export const INSTALL_METHOD_LABELS: Record<InstallMethod, string> = {
  volta: 'Volta',
  homebrew: 'Homebrew',
  bun: 'Bun',
  pnpm: 'pnpm',
  npm: 'npm',
  native: 'Native installer',
  unknown: 'Unknown',
};

const posix = (p: string) => p.replaceAll('\\', '/');

/**
 * Classifies an install from the command path found on PATH and its resolved real path.
 * Volta is checked first: its shims resolve to the `volta` binary, and its package images
 * live under node_modules, which would otherwise read as plain npm.
 */
export function detectInstallMethod(input: { path: string; realpath: string }): InstallMethod {
  const candidates = [posix(input.path), posix(input.realpath)];
  const any = (test: (p: string) => boolean) => candidates.some(test);
  if (any((p) => p.includes('/.volta/') || p.includes('/Volta/'))) return 'volta';
  if (any((p) => /\/(Cellar|homebrew|linuxbrew)\//i.test(p))) return 'homebrew';
  if (any((p) => p.includes('/.bun/'))) return 'bun';
  if (any((p) => /\/pnpm\/|\/\.pnpm\//.test(p))) return 'pnpm';
  if (any((p) => p.includes('/node_modules/'))) return 'npm';
  if (
    any(
      (p) =>
        p.includes('/.local/bin/') ||
        p.includes('/.opencode/') ||
        p.includes('/.local/share/claude/')
    )
  ) {
    return 'native';
  }
  return 'unknown';
}

export type UpdatePlan =
  | { kind: 'run'; command: string; args: string[] }
  | { kind: 'blocked'; reason: string };

/**
 * The argv that updates the install found at `input.path`, never a shell string.
 * Codex's own `codex update` runs `npm install -g`, which updates a different copy on Volta
 * installs, so those go through Volta.
 */
export function planUpdate(
  id: AgentCliId,
  input: { path: string; method: InstallMethod; voltaPath: string | null }
): UpdatePlan {
  switch (id) {
    case 'claude':
      return { kind: 'run', command: input.path, args: ['update'] };
    case 'opencode':
      return { kind: 'run', command: input.path, args: ['upgrade'] };
    case 'antigravity':
      return { kind: 'run', command: input.path, args: ['update'] };
    case 'codex':
      if (input.method === 'volta') {
        if (!input.voltaPath) {
          return {
            kind: 'blocked',
            reason: 'Codex is installed through Volta, but the volta binary was not found.',
          };
        }
        return {
          kind: 'run',
          command: input.voltaPath,
          args: ['install', '@openai/codex@latest'],
        };
      }
      return { kind: 'run', command: input.path, args: ['update'] };
  }
}
