import { spawn as nodeSpawn } from 'node:child_process';
import { tmpdir } from 'node:os';

/**
 * One run of Claude Code's cheapest model for workspace search questions. Read-only by
 * construction: no tools, no MCP servers, no hooks, no saved session. User settings still load,
 * as they may hold its credentials (e.g. Vertex env).
 */
export const SEARCH_MODEL = 'haiku';

export function claudeSearchArgs(system: string): string[] {
  return [
    '-p',
    '--model',
    SEARCH_MODEL,
    '--tools',
    '',
    '--strict-mcp-config',
    '--no-session-persistence',
    '--settings',
    JSON.stringify({ disableAllHooks: true }),
    '--output-format',
    'json',
    '--system-prompt',
    system,
  ];
}

/** The reply text of `claude -p --output-format json`; throws on an error result. */
export function parseClaudeOutput(stdout: string): string {
  let parsed: { result?: unknown; is_error?: unknown };
  try {
    parsed = JSON.parse(stdout.trim()) as typeof parsed;
  } catch {
    throw new Error(`Unexpected output from claude: ${stdout.trim().slice(0, 200)}`);
  }
  const result = typeof parsed.result === 'string' ? parsed.result : '';
  if (parsed.is_error === true) throw new Error(`claude failed: ${result.slice(0, 200)}`);
  return result;
}

export type SearchModelOptions = {
  /** Env for the CLI: the user's login-shell env, so PATH and credentials match a terminal. */
  env: () => NodeJS.ProcessEnv;
  command?: string;
  timeoutMs?: number;
  spawn?: typeof nodeSpawn;
};

export function createClaudeSearchModel(options: SearchModelOptions) {
  const spawn = options.spawn ?? nodeSpawn;
  const timeoutMs = options.timeoutMs ?? 120_000;
  return (input: { system: string; prompt: string; signal?: AbortSignal }): Promise<string> =>
    new Promise((resolve, reject) => {
      // The prompt goes through stdin: it is long and holds user text.
      const child = spawn(options.command ?? 'claude', claudeSearchArgs(input.system), {
        cwd: tmpdir(),
        env: options.env(),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error('The search agent took too long.'));
      }, timeoutMs);
      const abort = () => {
        clearTimeout(timer);
        child.kill();
        reject(new Error('Cancelled.'));
      };
      if (input.signal?.aborted) abort();
      else input.signal?.addEventListener('abort', abort, { once: true });
      child.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
      child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
      child.on('error', (error: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        reject(
          error.code === 'ENOENT'
            ? new Error('Asking an agent needs the Claude Code CLI (claude) on PATH.')
            : error
        );
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        input.signal?.removeEventListener('abort', abort);
        try {
          if (code !== 0 && !stdout.trim()) {
            throw new Error(`claude exited with ${code}: ${stderr.trim().slice(0, 200)}`);
          }
          resolve(parseClaudeOutput(stdout));
        } catch (error) {
          reject(error);
        }
      });
      child.stdin?.end(input.prompt);
    });
}
