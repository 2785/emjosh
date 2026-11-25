import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * The commit a worktree is on (its HEAD, so a renamed branch still counts), and whether work
 * happened on it since `startedAt` (epoch seconds). A fresh branch is just its base commit,
 * which every later branch contains, so it doesn't count as work.
 */
export async function worktreeTip(
  path: string,
  startedAt: number
): Promise<{ sha: string; workedOn: boolean } | null> {
  try {
    const { stdout } = await execFileAsync('git', ['log', '-1', '--format=%H %ct', 'HEAD'], {
      cwd: path,
    });
    const [sha, time] = stdout.trim().split(' ');
    return sha ? { sha, workedOn: Number(time) > startedAt } : null;
  } catch {
    return null;
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
