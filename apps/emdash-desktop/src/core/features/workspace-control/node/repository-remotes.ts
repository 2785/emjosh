import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Whether the repository has any git remote; a repository without one has nowhere to push. */
export async function hasGitRemote(repoPath: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('git', ['remote'], { cwd: repoPath });
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}
