import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SidebarTaskAgentLogos } from './task-agent-logos';

const mocks = vi.hoisted(() => ({
  defaultAgent: 'claude' as string | undefined,
  stats: {} as Record<string, number>,
}));

vi.mock('@core/features/settings/api/browser/use-app-settings-key', () => ({
  useAppSettingsKey: () => ({ value: mocks.defaultAgent }),
}));

vi.mock('@core/features/conversations/api/browser/conversation-selectors', () => ({
  taskConversationStats: () => mocks.stats,
}));

vi.mock('@core/features/agents/api/browser/use-agent-metadata', () => ({
  useAgentMetadata: () => ({
    data: [
      { id: 'claude', name: 'Claude Code' },
      { id: 'codex', name: 'Codex' },
      { id: 'gemini', name: 'Gemini' },
      { id: 'antigravity', name: 'Antigravity' },
    ],
  }),
}));

vi.mock('@core/features/agents/contributions/browser/agent-icon', async () => {
  const { createElement } = await import('react');
  return {
    AgentIcon: ({ id }: { id: string }) => createElement('i', { 'data-agent-icon': id }),
  };
});

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

describe('SidebarTaskAgentLogos', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    mocks.defaultAgent = 'claude';
    mocks.stats = {};
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  function render() {
    // The component only hands the store to the mocked selector.
    act(() => root.render(<SidebarTaskAgentLogos task={{} as never} />));
    return {
      strip: host.querySelector('[data-testid="sidebar-agent-logos"]'),
      icons: [...host.querySelectorAll('[data-agent-icon]')].map((el) =>
        el.getAttribute('data-agent-icon')
      ),
    };
  }

  it('renders nothing for a task running only the default agent', () => {
    mocks.stats = { claude: 2 };
    const { strip, icons } = render();
    expect(strip).toBeNull();
    expect(icons).toEqual([]);
  });

  it('shows the logo of a non-default agent, named in its label', () => {
    mocks.stats = { claude: 1, codex: 1 };
    const { strip, icons } = render();
    expect(icons).toEqual(['codex']);
    expect(strip?.getAttribute('aria-label')).toBe('Codex');
  });

  it('follows the configured default agent', () => {
    mocks.defaultAgent = 'codex';
    mocks.stats = { codex: 1 };
    expect(render().icons).toEqual([]);

    mocks.stats = { claude: 1 };
    expect(render().icons).toEqual(['claude']);
  });

  it('caps the logos but names every non-default agent', () => {
    mocks.stats = { codex: 3, gemini: 2, antigravity: 1 };
    const { strip, icons } = render();
    expect(icons).toEqual(['codex', 'gemini']);
    expect(strip?.getAttribute('aria-label')).toBe('Codex, Gemini, Antigravity');
  });
});
