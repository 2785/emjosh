import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { claudeSearchArgs, createClaudeSearchModel, parseClaudeOutput } from './search-model';

describe('claudeSearchArgs', () => {
  it('runs the cheap model with no tools, MCP servers, hooks or saved session', () => {
    const args = claudeSearchArgs('SYS');
    expect(args).toContain('-p');
    expect(args[args.indexOf('--model') + 1]).toBe('haiku');
    expect(args[args.indexOf('--tools') + 1]).toBe('');
    expect(args).toContain('--strict-mcp-config');
    expect(args).toContain('--no-session-persistence');
    expect(args[args.indexOf('--system-prompt') + 1]).toBe('SYS');
    expect(JSON.parse(args[args.indexOf('--settings') + 1]!)).toEqual({ disableAllHooks: true });
  });
});

describe('parseClaudeOutput', () => {
  it('returns the result text', () => {
    expect(parseClaudeOutput('{"result":"hi","is_error":false}')).toBe('hi');
  });
  it('throws on error results and non-JSON', () => {
    expect(() => parseClaudeOutput('{"result":"boom","is_error":true}')).toThrow(/boom/);
    expect(() => parseClaudeOutput('garbage')).toThrow(/Unexpected output/);
  });
});

describe('createClaudeSearchModel', () => {
  it('sends the prompt on stdin and resolves the reply', async () => {
    let written = '';
    const spawn = ((command: string) => {
      const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
      const stdin = new PassThrough();
      stdin.on('data', (chunk: Buffer) => (written += chunk.toString()));
      child.stdin = stdin;
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => true;
      expect(command).toBe('claude');
      setImmediate(() => {
        (child.stdout as PassThrough).write('{"result":"answer","is_error":false}');
        child.emit('close', 0);
      });
      return child;
    }) as never;
    const run = createClaudeSearchModel({ env: () => ({}), spawn });
    await expect(run({ system: 's', prompt: 'the prompt' })).resolves.toBe('answer');
    expect(written).toBe('the prompt');
  });
});
