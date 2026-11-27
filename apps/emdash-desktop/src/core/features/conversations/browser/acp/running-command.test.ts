import { describe, expect, it } from 'vitest';
import { findRunningCommand, formatElapsed, summarizeCommand } from './running-command';

const exec = (id: string, status: string, command = `run ${id}`) => ({
  kind: 'execute-tool-call',
  id,
  status,
  command,
});

describe('findRunningCommand', () => {
  it('finds a running command inside a tool group, newest first', () => {
    const items = [
      exec('old', 'running'),
      { kind: 'tool-group', id: 'g', children: [exec('done', 'done'), exec('newer', 'running')] },
    ];

    expect(findRunningCommand(items)).toEqual({ id: 'newer', command: 'run newer' });
  });

  it('ignores finished commands and other tool calls', () => {
    expect(
      findRunningCommand([
        exec('a', 'done'),
        { kind: 'read-tool-call', id: 'r', status: 'running' },
      ])
    ).toBeNull();
    expect(findRunningCommand(undefined)).toBeNull();
  });
});

describe('formatElapsed', () => {
  it('reads compactly', () => {
    expect(formatElapsed(4_000)).toBe('4s');
    expect(formatElapsed(372_000)).toBe('6m 12s');
    expect(formatElapsed(3_780_000)).toBe('1h 3m');
  });
});

describe('summarizeCommand', () => {
  it('keeps the first line and shortens long ones', () => {
    expect(summarizeCommand('glab repo create x\n--private')).toBe('glab repo create x');
    expect(summarizeCommand('x'.repeat(200)).length).toBe(110);
    expect(summarizeCommand('x'.repeat(200)).endsWith('…')).toBe(true);
  });
});
