import { describe, expect, it } from 'vitest';
import { detectInstallMethod, planUpdate } from './install-method';

// Paths as reported by a real Volta-managed Codex install (`codex doctor` and `which`).
const VOLTA_SHIM = '/Users/me/.volta/bin/codex';
const VOLTA_REAL =
  '/Users/me/.volta/tools/image/packages/@openai/codex/lib/node_modules/@openai/codex/bin/codex.js';

describe('detectInstallMethod', () => {
  it.each([
    [VOLTA_SHIM, '/Users/me/.volta/bin/volta', 'volta'],
    ['/Users/me/bin/codex', VOLTA_REAL, 'volta'],
    ['/opt/homebrew/bin/codex', '/opt/homebrew/Cellar/codex/0.172.0/bin/codex', 'homebrew'],
    ['/usr/local/bin/codex', '/usr/local/lib/node_modules/@openai/codex/bin/codex.js', 'npm'],
    [
      '/Users/me/.bun/bin/codex',
      '/Users/me/.bun/install/global/node_modules/@openai/codex/x',
      'bun',
    ],
    ['/Users/me/Library/pnpm/codex', '/Users/me/Library/pnpm/global/5/node_modules/x', 'pnpm'],
    ['/Users/me/.local/bin/claude', '/Users/me/.local/share/claude/versions/2.1.318', 'native'],
    ['/Users/me/.opencode/bin/opencode', '/Users/me/.opencode/bin/opencode', 'native'],
    ['/weird/place/tool', '/weird/place/tool', 'unknown'],
  ])('%s -> %s', (p, realpath, expected) => {
    expect(detectInstallMethod({ path: p, realpath })).toBe(expected);
  });

  it('reads Windows paths', () => {
    expect(
      detectInstallMethod({
        path: 'C:\\Users\\me\\.volta\\bin\\codex.exe',
        realpath: 'C:\\Users\\me\\.volta\\bin\\volta.exe',
      })
    ).toBe('volta');
  });
});

describe('planUpdate', () => {
  it('updates Volta Codex through volta, not `codex update`', () => {
    expect(
      planUpdate('codex', {
        path: VOLTA_SHIM,
        method: 'volta',
        voltaPath: '/Users/me/.volta/bin/volta',
      })
    ).toEqual({
      kind: 'run',
      command: '/Users/me/.volta/bin/volta',
      args: ['install', '@openai/codex@latest'],
    });
  });

  it('blocks Volta Codex when volta is missing', () => {
    expect(planUpdate('codex', { path: VOLTA_SHIM, method: 'volta', voltaPath: null }).kind).toBe(
      'blocked'
    );
  });

  it.each(['npm', 'homebrew', 'bun', 'unknown'] as const)(
    'uses `codex update` for %s',
    (method) => {
      expect(planUpdate('codex', { path: '/x/codex', method, voltaPath: null })).toEqual({
        kind: 'run',
        command: '/x/codex',
        args: ['update'],
      });
    }
  );

  it('uses each CLI own update command', () => {
    const input = { path: '/x/bin', method: 'native', voltaPath: null } as const;
    expect(planUpdate('claude', input)).toMatchObject({ args: ['update'] });
    expect(planUpdate('opencode', input)).toMatchObject({ args: ['upgrade'] });
    expect(planUpdate('antigravity', input)).toMatchObject({ args: ['update'] });
  });
});
