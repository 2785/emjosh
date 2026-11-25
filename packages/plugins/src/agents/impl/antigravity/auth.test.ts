import type { AgentAuthContext } from '@emdash/core/services/agent-plugins/api/plugins';
import { describe, expect, it, vi } from 'vitest';
import { antigravityAuthStatus } from './auth';

function context(
  env: Record<string, string>,
  exec: AgentAuthContext['exec'] = vi.fn()
): AgentAuthContext {
  return { cli: 'agy', env, exec, fs: {} as AgentAuthContext['fs'] };
}

describe('antigravityAuthStatus', () => {
  it('treats gcloud ADC and Gemini API keys as signed in without running the CLI', async () => {
    const exec = vi.fn();
    await expect(antigravityAuthStatus(context({ AGY_ADC_AUTH: 'true' }, exec))).resolves.toEqual({
      kind: 'authenticated',
    });
    await expect(antigravityAuthStatus(context({ GEMINI_API_KEY: 'k' }, exec))).resolves.toEqual({
      kind: 'authenticated',
    });
    expect(exec).not.toHaveBeenCalled();
  });

  it('reads the Google sign-in from `agy models`', async () => {
    const exec = vi.fn(async () => ({
      stdout: 'Fetching available models...\ngemini-4-carbon-medium\tGemini 4 Carbon (Medium)\n',
      stderr: '',
    }));
    await expect(antigravityAuthStatus(context({}, exec))).resolves.toEqual({
      kind: 'authenticated',
    });
    expect(exec).toHaveBeenCalledWith('agy', ['models'], { timeout: 15_000 });
  });

  it('reports signed out when agy asks to sign in', async () => {
    const exec = vi.fn(async () => {
      throw Object.assign(new Error('exit 1'), {
        stdout: 'Fetching available models...\n',
        stderr:
          'Error: Please sign in to view available models. Launch the CLI without arguments to sign in.',
      });
    });
    await expect(antigravityAuthStatus(context({}, exec))).resolves.toEqual({
      kind: 'unauthenticated',
    });
  });
});
