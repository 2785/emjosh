import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { hasGitRemote } from './repository-remotes';

const dirs: string[] = [];
function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'git-remotes-'));
  dirs.push(dir);
  execFileSync('git', ['init', '-q'], { cwd: dir });
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('hasGitRemote', () => {
  it('is false for a repository with no remote', async () => {
    expect(await hasGitRemote(repo())).toBe(false);
  });

  it('is true once a remote exists', async () => {
    const dir = repo();
    execFileSync('git', ['remote', 'add', 'origin', 'git@example.com:me/app.git'], { cwd: dir });

    expect(await hasGitRemote(dir)).toBe(true);
  });

  it('is false for a path that is not a repository', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'not-a-repo-'));
    dirs.push(dir);

    expect(await hasGitRemote(dir)).toBe(false);
  });
});
