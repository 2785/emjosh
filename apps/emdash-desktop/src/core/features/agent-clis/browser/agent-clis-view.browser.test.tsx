import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import type { AgentCliInfo } from '../api/schemas';
import { AgentClisView } from './agent-clis-view';

const base: AgentCliInfo = {
  id: 'codex',
  name: 'Codex',
  installed: true,
  path: '/Users/me/.volta/bin/codex',
  version: '0.171.0',
  latestVersion: '0.172.0',
  updateAvailable: true,
  installMethod: 'Volta',
  updateCommand: ['/Users/me/.volta/bin/volta', 'install', '@openai/codex@latest'],
  updateBlockedReason: null,
  autoUpdate: { owner: 'emjosh', enabled: false, detail: null },
  updating: false,
  lastUpdate: null,
};

async function render(clis: AgentCliInfo[], handlers = {}) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const props = {
    clis,
    loading: false,
    toggleErrors: {},
    onUpdate: vi.fn(),
    onToggleAutoUpdate: vi.fn(),
    onRefresh: vi.fn(),
    ...handlers,
  };
  await act(async () => root.render(<AgentClisView {...props} />));
  return {
    host,
    props,
    cleanup: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

describe('AgentClisView', () => {
  it('shows version, update availability and who owns auto-update; update and toggle call back', async () => {
    const { host, props, cleanup } = await render([
      base,
      {
        ...base,
        id: 'claude',
        name: 'Claude Code',
        updateAvailable: false,
        autoUpdate: { owner: 'cli', enabled: true, detail: null },
      },
    ]);
    const codex = host.querySelector('section[aria-label="Codex"]') as HTMLElement;
    expect(codex.textContent).toContain('0.171.0');
    expect(codex.textContent).toContain('Update available: 0.172.0');
    expect(codex.textContent).toContain('Managed by Emjosh');
    expect(codex.textContent).toContain('volta install @openai/codex@latest');
    expect(host.textContent).toContain('Managed by Claude Code itself');
    expect(host.textContent).toContain('Running chats keep the old version');

    await act(async () =>
      [...codex.querySelectorAll('button')].find((b) => b.textContent === 'Update')?.click()
    );
    expect(props.onUpdate).toHaveBeenCalledWith('codex');
    await act(async () => (codex.querySelector('[role="switch"]') as HTMLElement).click());
    expect(props.onToggleAutoUpdate).toHaveBeenCalledWith('codex', true);
    await cleanup();
  });

  it('disables Update while updating and when blocked, showing the reason', async () => {
    const { host, cleanup } = await render([
      { ...base, updating: true },
      { ...base, id: 'claude', name: 'Claude Code', updateBlockedReason: 'volta missing' },
    ]);
    const buttons = [...host.querySelectorAll('section button')];
    expect(buttons[0]?.textContent).toBe('Updating…');
    expect((buttons[0] as HTMLButtonElement).disabled).toBe(true);
    expect((buttons[1] as HTMLButtonElement).disabled).toBe(true);
    expect(host.textContent).toContain('volta missing');
    await cleanup();
  });

  it('shows the last result with command output verbatim, and errors', async () => {
    const { host, cleanup } = await render([
      {
        ...base,
        lastUpdate: {
          ok: false,
          at: 0,
          trigger: 'auto',
          command: ['x'],
          before: '0.171.0',
          after: '0.171.0',
          output: 'EACCES: permission denied',
          error: 'The update command exited with code 3.',
        },
      },
    ]);
    expect(host.textContent).toContain('Automatic update: failed');
    expect(host.textContent).toContain('exited with code 3');
    expect(host.querySelector('pre')?.textContent).toBe('EACCES: permission denied');
    await cleanup();
  });

  it('shows an uninstalled CLI without controls', async () => {
    const { host, cleanup } = await render([
      { ...base, installed: false, path: null, version: null, updateAvailable: false },
    ]);
    expect(host.textContent).toContain('Not installed');
    expect(host.querySelector('section button')).toBeNull();
    await cleanup();
  });
});
