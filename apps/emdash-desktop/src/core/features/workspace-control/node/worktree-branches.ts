import { execFile } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Git operations that leave HEAD somewhere temporary, by the marker they keep in the git dir. */
const IN_PROGRESS: [marker: string, label: string][] = [
  ['rebase-merge', 'mid-rebase'],
  ['rebase-apply', 'mid-rebase'],
  ['MERGE_HEAD', 'mid-merge'],
  ['CHERRY_PICK_HEAD', 'mid-cherry-pick'],
  ['REVERT_HEAD', 'mid-revert'],
  ['BISECT_LOG', 'mid-bisect'],
];

/**
 * The commit a worktree is on (its HEAD, so a renamed branch still counts), and whether work
 * happened on it since `startedAt` (epoch seconds). A fresh branch is just its base commit,
 * which every later branch contains, so it doesn't count as work. `unsettled` says why HEAD
 * isn't the branch's real tip (mid-rebase, detached HEAD…), so it mustn't be compared.
 */
export async function worktreeTip(
  path: string,
  startedAt: number
): Promise<{ sha: string; workedOn: boolean; unsettled: string | null } | null> {
  try {
    const { stdout } = await execFileAsync('git', ['log', '-1', '--format=%H %ct', 'HEAD'], {
      cwd: path,
    });
    const [sha, time] = stdout.trim().split(' ');
    if (!sha) return null;
    return { sha, workedOn: Number(time) > startedAt, unsettled: await unsettledState(path) };
  } catch {
    return null;
  }
}

async function unsettledState(path: string): Promise<string | null> {
  const { stdout } = await execFileAsync('git', ['rev-parse', '--absolute-git-dir'], { cwd: path });
  const gitDir = stdout.trim();
  for (const [marker, label] of IN_PROGRESS) {
    if (await exists(join(gitDir, marker))) return label;
  }
  try {
    await execFileAsync('git', ['symbolic-ref', '-q', 'HEAD'], { cwd: path });
    return null;
  } catch {
    return 'detached HEAD';
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Whether `ancestor` is in the history of `descendant` (a commit or ref). */
export async function isAncestor(
  cwd: string,
  ancestor: string,
  descendant: string
): Promise<boolean> {
  try {
    await execFileAsync('git', ['merge-base', '--is-ancestor', ancestor, descendant], { cwd });
    return true;
  } catch {
    return false;
  }
}

/**
 * The branch checked out in the worktree or repository at `path`, read from its HEAD file
 * (no git process, so it is cheap for every workspace). Null when detached or unreadable.
 */
export async function checkedOutBranch(path: string): Promise<string | null> {
  try {
    let gitDir = join(path, '.git');
    const dotGit = await readFile(gitDir, 'utf8').catch(() => null);
    // A worktree's .git is a file pointing at its git dir; a repository's is the directory.
    const pointer = dotGit && /^gitdir:\s*(.+)$/m.exec(dotGit);
    if (pointer) gitDir = resolve(path, pointer[1]!.trim());
    const head = (await readFile(join(gitDir, 'HEAD'), 'utf8')).trim();
    const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
    return ref ? ref[1]! : null;
  } catch {
    return null;
  }
}
