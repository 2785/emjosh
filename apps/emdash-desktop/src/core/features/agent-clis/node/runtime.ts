import { execFile } from 'node:child_process';
import type { RunCommand } from './service';

const MAX_BUFFER = 4 * 1024 * 1024;

/** Runs a program with an argument array; no shell is involved. */
export const runCommand: RunCommand = (command, args, { env, timeoutMs }) =>
  new Promise((resolve) => {
    execFile(
      command,
      args,
      { env, timeout: timeoutMs, maxBuffer: MAX_BUFFER, windowsHide: true, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (!error) return resolve({ exitCode: 0, stdout, stderr, timedOut: false });
        const e = error as NodeJS.ErrnoException & { killed?: boolean; code?: unknown };
        if (typeof e.code === 'number') {
          return resolve({ exitCode: e.code, stdout, stderr, timedOut: false });
        }
        if (e.killed) return resolve({ exitCode: null, stdout, stderr, timedOut: true });
        resolve({ exitCode: null, stdout, stderr, timedOut: false, spawnError: e.message });
      }
    );
  });

/** Newest version from the npm registry's `latest` dist-tag; null on any failure. */
export async function fetchNpmLatestVersion(npmPackage: string): Promise<string | null> {
  const response = await fetch(`https://registry.npmjs.org/${npmPackage}/latest`, {
    signal: AbortSignal.timeout(6_000),
    headers: { accept: 'application/json' },
  });
  if (!response.ok) return null;
  const body = (await response.json()) as { version?: unknown };
  return typeof body.version === 'string' ? body.version : null;
}
