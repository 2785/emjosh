import { describe, expect, it, vi } from 'vitest';
import { needsUnarchive, openWorkspace, type OpenWorkspaceDeps } from './open-workspace';

const target = { id: 't1', projectId: 'p1', name: 'N', archived: true };

function deps(archived: boolean | undefined): OpenWorkspaceDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    navigate: vi.fn(() => void calls.push('navigate')),
    restore: vi.fn(async () => void calls.push('restore')),
    isArchived: () => archived,
  };
}

describe('openWorkspace', () => {
  it('unarchives before navigating', async () => {
    const d = deps(true);
    await openWorkspace(target, d);
    expect(d.calls).toEqual(['restore', 'navigate']);
    expect(d.navigate).toHaveBeenCalledWith(
      expect.objectContaining({ params: { projectId: 'p1', taskId: 't1' } })
    );
  });

  it('navigates directly when active, trusting the live store over the search result', async () => {
    const d = deps(false);
    await openWorkspace(target, d);
    expect(d.calls).toEqual(['navigate']);
  });

  it('falls back to the search result when the task is not loaded', () => {
    expect(needsUnarchive(target, deps(undefined))).toBe(true);
    expect(needsUnarchive({ ...target, archived: false }, deps(undefined))).toBe(false);
  });
});
