import { describe, expect, it } from 'vitest';
import { labelledName, nextLabel, normalizeLabel, workspaceRef } from './labels';

describe('initiative labels', () => {
  it('hands out letters in order, skipping issued ones, then two letters', () => {
    expect(nextLabel(new Set())).toBe('A');
    expect(nextLabel(new Set(['A', 'B', 'D']))).toBe('C');
    const alphabet = Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i));
    expect(nextLabel(new Set(alphabet))).toBe('AA');
    expect(nextLabel(new Set([...alphabet, 'AA']))).toBe('AB');
  });

  it('upper-cases labels and rejects unusable ones', () => {
    expect(normalizeLabel(' api ')).toBe('API');
    expect(normalizeLabel('ui-2')).toBe('UI-2');
    for (const bad of ['', ' ', '-A', 'A B', 'TOOLONG', 'É']) {
      expect(() => normalizeLabel(bad)).toThrow(/1 to 6/);
    }
  });

  it('names workspaces with their label', () => {
    expect(workspaceRef('Codex parity', 'F')).toBe('Workspace F "Codex parity"');
    expect(workspaceRef('Codex parity')).toBe('Workspace "Codex parity"');
    expect(labelledName('API', 'A')).toBe('A "API"');
  });
});
