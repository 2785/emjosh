import type { AgentStatus } from '@core/primitives/agents/api';

export type MobileTaskEntry = {
  projectId: string;
  projectName: string;
  taskId: string;
  name: string;
  status: AgentStatus | null;
  /** ISO time of the last real activity, for ordering and "2h ago". */
  activityAt: string | undefined;
  initiativeName: string | null;
  pullRequest: 'open' | 'draft' | 'merged' | 'closed' | null;
};

export type MobileTaskSections = {
  /** Waiting for the user, failed, or finished and not yet seen. */
  attention: MobileTaskEntry[];
  working: MobileTaskEntry[];
  recent: MobileTaskEntry[];
};

const ATTENTION_ORDER: Partial<Record<AgentStatus, number>> = {
  'awaiting-input': 0,
  error: 1,
  completed: 2,
};

/**
 * Epoch milliseconds for an activity time. SQLite's CURRENT_TIMESTAMP is UTC but carries no
 * zone ("2026-11-26 16:30:17"), which `Date.parse` would read as local time.
 */
export function parseActivityTime(value: string | undefined): number {
  if (!value) return Number.NaN;
  const utc = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(value)
    ? `${value.replace(' ', 'T')}Z`
    : value;
  return Date.parse(utc);
}

const byRecency = (a: MobileTaskEntry, b: MobileTaskEntry) =>
  (parseActivityTime(b.activityAt) || 0) - (parseActivityTime(a.activityAt) || 0) ||
  a.taskId.localeCompare(b.taskId);

/** Splits workspaces into what needs the user, what's running, and the rest, newest first. */
export function mobileTaskSections(
  entries: readonly MobileTaskEntry[],
  query = ''
): MobileTaskSections {
  const needle = query.trim().toLowerCase();
  const matching = needle
    ? entries.filter((entry) =>
        [entry.name, entry.projectName, entry.initiativeName ?? '']
          .join(' ')
          .toLowerCase()
          .includes(needle)
      )
    : entries;
  const attention = matching
    .filter((entry) => entry.status !== null && ATTENTION_ORDER[entry.status] !== undefined)
    .sort((a, b) => ATTENTION_ORDER[a.status!]! - ATTENTION_ORDER[b.status!]! || byRecency(a, b));
  return {
    attention,
    working: matching
      .filter((entry) => entry.status === 'working' || entry.status === 'background')
      .sort(byRecency),
    recent: matching
      .filter((entry) => entry.status === null || entry.status === 'idle')
      .sort(byRecency),
  };
}

/** "now", "5m", "3h", "2d": compact enough for a phone row. */
export function shortAgo(iso: string | undefined, now = Date.now()): string {
  if (!iso) return '';
  const minutes = Math.floor(Math.max(0, now - parseActivityTime(iso)) / 60_000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
