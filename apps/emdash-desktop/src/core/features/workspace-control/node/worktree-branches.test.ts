import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isAncestor, worktreeTip } from './worktree-branches';

/** Epoch seconds the test commits are dated around. */
const T = 1_790_000_000;

describe('worktree branches', () => {
  let repo: string;
  const git = (args: string[], when = T) =>
    execFileSync('git', args, {
      cwd: repo,
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@t',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@t',
        GIT_AUTHOR_DATE: `@${when} +0000`,
        GIT_COMMITTER_DATE: `@${when} +0000`,
      },
    })
      .toString()
      .trim();
  const commit = (message: string, when: number) => {
    writeFileSync(join(repo, `${message}.txt`), message);
    git(['add', '.']);
    git(['commit', '-qm', message], when);
    return git(['rev-parse', 'HEAD']);
  };

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'worktree-branches-'));
    git(['init', '-q', '-b', 'main']);
  });

  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it('counts a branch as worked on only with commits after the workspace started', async () => {
    const base = commit('base', T + 1_000);

    expect(await worktreeTip(repo, T + 2_000)).toEqual({ sha: base, workedOn: false });
    const work = commit('work', T + 3_000);
    expect(await worktreeTip(repo, T + 2_000)).toEqual({ sha: work, workedOn: true });
    expect(await worktreeTip(join(repo, 'missing'), 0)).toBeNull();
  });

  it("tells whether a branch contains another's work, e.g. after rebasing onto it", async () => {
    commit('base', T + 1_000);
    git(['checkout', '-qb', 'codex']);
    const codex = commit('codex', T + 2_000);
    git(['checkout', '-qb', 'antigravity', 'main']);
    commit('antigravity', T + 3_000);

    expect(await isAncestor(repo, codex, 'antigravity')).toBe(false);
    git(['merge', '-q', '--no-edit', 'codex'], T + 4_000);
    expect(await isAncestor(repo, codex, 'antigravity')).toBe(true);
    expect(await isAncestor(repo, 'antigravity', 'codex')).toBe(false);
  });
});
