import type { ComposerNotice } from '@emdash/ui/react/components';
import { useEffect, useRef, useState } from 'react';
import {
  formatElapsed,
  RUNNING_COMMAND_NOTICE_AFTER_MS,
  summarizeCommand,
  type RunningCommand,
} from './running-command';

/**
 * A notice above the composer while the agent's turn waits on a long shell command, with a Stop
 * button. The clock starts when this chat first sees the command running, so reopening a chat
 * counts from then.
 */
export function useRunningCommandNotice(
  running: RunningCommand | null,
  canStop: boolean,
  onStop: () => void
): ComposerNotice | null {
  const firstSeen = useRef(new Map<string, number>());
  const [now, setNow] = useState(() => Date.now());
  const runningId = running?.id;

  useEffect(() => {
    if (!runningId) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [runningId]);

  if (!running || !canStop) return null;
  // The clock starts at the first render that sees the command: `now` can be stale by then.
  if (!firstSeen.current.has(running.id)) firstSeen.current.set(running.id, Date.now());
  const elapsed = now - firstSeen.current.get(running.id)!;
  if (elapsed < RUNNING_COMMAND_NOTICE_AFTER_MS) return null;

  return {
    variant: 'info',
    title: 'Waiting on a command',
    message: `${summarizeCommand(running.command)} · running ${formatElapsed(elapsed)}`,
    action: { label: 'Stop', onClick: onStop },
  };
}
