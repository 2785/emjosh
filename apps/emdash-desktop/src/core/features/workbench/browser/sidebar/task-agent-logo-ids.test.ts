import { describe, expect, it } from 'vitest';
import { nonDefaultAgentIds } from './task-agent-logo-ids';

describe('nonDefaultAgentIds', () => {
  it('returns nothing when every conversation runs the default agent', () => {
    expect(nonDefaultAgentIds({ claude: 3 }, 'claude')).toEqual([]);
  });

  it('returns nothing for a task without conversations', () => {
    expect(nonDefaultAgentIds({}, 'claude')).toEqual([]);
  });

  it('drops the default agent and keeps the others', () => {
    expect(nonDefaultAgentIds({ claude: 2, codex: 1 }, 'claude')).toEqual(['codex']);
  });

  it('follows the configured default rather than a fixed agent', () => {
    expect(nonDefaultAgentIds({ claude: 1, codex: 1 }, 'codex')).toEqual(['claude']);
  });

  it('orders agents by conversation count, most-used first', () => {
    expect(nonDefaultAgentIds({ gemini: 1, codex: 3, claude: 1 }, 'claude')).toEqual([
      'codex',
      'gemini',
    ]);
  });

  it('ignores zero counts', () => {
    expect(nonDefaultAgentIds({ codex: 0 }, 'claude')).toEqual([]);
  });

  it('shows every agent when no default is set', () => {
    expect(nonDefaultAgentIds({ claude: 1 }, undefined)).toEqual(['claude']);
  });
});
