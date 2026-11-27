/** The part of a transcript item this needs; tool groups hold their calls as `children`. */
export type TranscriptItemLike = {
  kind: string;
  id: string;
  status?: string;
  command?: string;
  children?: readonly TranscriptItemLike[];
};

export type RunningCommand = { id: string; command: string };

/** The most recent shell command the agent started that has not finished. */
export function findRunningCommand(
  items: readonly TranscriptItemLike[] | undefined
): RunningCommand | null {
  for (let index = (items?.length ?? 0) - 1; index >= 0; index--) {
    const item = items![index]!;
    if (item.children) {
      const nested = findRunningCommand(item.children);
      if (nested) return nested;
    } else if (item.kind === 'execute-tool-call' && item.status === 'running' && item.command) {
      return { id: item.id, command: item.command };
    }
  }
  return null;
}

/** A command that runs this long is worth pointing out: the agent's turn waits for it. */
export const RUNNING_COMMAND_NOTICE_AFTER_MS = 10_000;

/** "45s", "6m 12s", "1h 3m". */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** The command's first line, shortened to fit a one-line notice. */
export function summarizeCommand(command: string, max = 110): string {
  const firstLine = command.trim().split('\n', 1)[0] ?? '';
  return firstLine.length > max ? `${firstLine.slice(0, max - 1)}…` : firstLine;
}
