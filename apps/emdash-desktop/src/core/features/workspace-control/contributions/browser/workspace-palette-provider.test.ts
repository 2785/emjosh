import { describe, expect, it, vi } from 'vitest';

const searchWorkspaces = vi.fn();
vi.mock('../../api/browser/client', () => ({
  getWorkspaceControlClient: async () => ({ searchWorkspaces }),
}));
vi.mock('@core/manifests/browser/modal-api', () => ({ openModal: vi.fn() }));
vi.mock('@core/primitives/app-identity/api/app-identity', () => ({ IS_PERSONAL: true }));
vi.mock('../../api/browser/open-workspace', () => ({ openWorkspaceLink: vi.fn() }));

import { workspacePaletteProviderDef } from './workspace-palette-provider';

const ref = (id: string, archived = false) => ({
  id,
  name: `WS ${id}`,
  projectName: 'proj',
  archived,
});

describe('workspace palette provider', () => {
  it('puts the ask item first for free text and keeps instant non-name matches', async () => {
    searchWorkspaces.mockResolvedValue({
      hits: [
        { workspace: ref('a'), score: 100, reasons: ['MR !5799'] },
        { workspace: ref('b'), score: 60, reasons: ['name'] },
        { workspace: ref('c', true), score: 60, reasons: ['name'] },
      ],
      conclusive: true,
    });
    const matches = await workspacePaletteProviderDef.search({
      query: 'https://gitlab.com/g/r/-/merge_requests/5799',
      context: {},
    });
    expect(matches.map((m) => m.id)).toEqual(['ask', 'a', 'c']);
    expect(matches[0]!.title).toContain('Ask an agent to find');
    expect(matches[0]!.relevance.band).toBe('exact');
    expect(matches[0]!.relevance.score).toBeGreaterThan(matches[1]!.relevance.score);
  });

  it('keeps the ask item last for short text so Enter still runs commands', async () => {
    searchWorkspaces.mockResolvedValue({ hits: [], conclusive: false });
    const [ask] = await workspacePaletteProviderDef.search({ query: 'settings', context: {} });
    expect(ask!.relevance.band).toBe('secondary');
  });

  it('still offers the ask item when the search fails', async () => {
    searchWorkspaces.mockRejectedValue(new Error('down'));
    const matches = await workspacePaletteProviderDef.search({ query: 'a b c d', context: {} });
    expect(matches.map((m) => m.id)).toEqual(['ask']);
  });
});
