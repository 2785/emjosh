import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AcpSpawnContext } from '@emdash/core/services/agent-plugins/api/plugins';
import { envConfigRoot } from '@emdash/core/services/agent-plugins/api/plugins/helpers';
import * as toml from 'smol-toml';

const codexHome = envConfigRoot('CODEX_HOME', '.codex');

/** The user's own `developer_instructions` from `$CODEX_HOME/config.toml`, if any. */
function readUserDeveloperInstructions(env: Record<string, string>): string | undefined {
  const root = codexHome({
    env,
    homeDir: os.homedir(),
    platform: process.platform === 'win32' ? 'windows' : 'macos',
  });
  try {
    const config = toml.parse(readFileSync(path.join(root, 'config.toml'), 'utf8'));
    const value = config.developer_instructions;
    return typeof value === 'string' && value.trim() ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Codex doesn't pass MCP server instructions to the model, so the host app's instructions go in
 * as `developer_instructions` through codex-acp's `CODEX_CONFIG`, which overrides config.toml for
 * every session. The user's own developer instructions are kept ahead of the app's.
 */
export function codexAcpConfigEnv(
  ctx: Pick<AcpSpawnContext, 'env' | 'controlInstructions'>
): Record<string, string> {
  if (!ctx.controlInstructions) return {};
  const developerInstructions = [readUserDeveloperInstructions(ctx.env), ctx.controlInstructions]
    .filter(Boolean)
    .join('\n\n');
  return { CODEX_CONFIG: JSON.stringify({ developer_instructions: developerInstructions }) };
}
