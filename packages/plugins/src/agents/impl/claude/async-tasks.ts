import type { AnyMessage, SessionUpdate } from '@agentclientprotocol/sdk';
import type { NormalizedEvent } from '@emdash/core/runtimes/acp/api';

/**
 * Claude's adapter reports background work that isn't a subagent (backgrounded shell commands,
 * monitors) only to clients advertising the AIR `asyncTasks` extension, as session updates the
 * ACP SDK doesn't know and would reject:
 *
 *   { sessionUpdate: 'async_task_spawned', asyncTaskId: 'b1', ... }
 *   { sessionUpdate: 'async_task_state_update', asyncTaskId: 'b1', state: 'completed' }
 *
 * `carryAsyncTaskUpdate` rewrites them, before the SDK validates them, into a standard
 * `session_info_update` carrying the task under ASYNC_TASK_META_KEY, which
 * `asyncTaskEvent` turns into a `background_task` event.
 */
export const CLAUDE_CLIENT_CAPABILITIES_META = {
  jetbrains: { air: { version: 1, capabilities: ['asyncTasks'] } },
};

const ASYNC_TASK_META_KEY = 'emdash/asyncTask';

type BackgroundTaskEvent = Extract<NormalizedEvent, { kind: 'background_task' }>;
type CarriedTask = Pick<BackgroundTaskEvent, 'taskId' | 'state'>;

const TASK_STATES: ReadonlySet<string> = new Set([
  'running',
  'paused',
  'completed',
  'failed',
  'stopped',
]);

/** The message to hand the SDK in place of `message`, or null to drop it. */
export function carryAsyncTaskUpdate(message: AnyMessage): AnyMessage | null {
  if (!('method' in message) || message.method !== 'session/update' || 'id' in message) {
    return message;
  }
  const params = message.params as { update?: Record<string, unknown> } | undefined;
  const update = params?.update;
  const kind = update?.sessionUpdate;
  if (typeof kind !== 'string' || !kind.startsWith('async_task_')) return message;
  const task = carriedTask(update!);
  if (!task) return null;
  return {
    ...message,
    params: {
      ...params,
      update: { sessionUpdate: 'session_info_update', _meta: { [ASYNC_TASK_META_KEY]: task } },
    },
  };
}

function carriedTask(update: Record<string, unknown>): CarriedTask | null {
  const taskId = update.asyncTaskId;
  if (typeof taskId !== 'string' || !taskId) return null;
  if (update.sessionUpdate === 'async_task_spawned') return { taskId, state: 'running' };
  if (update.sessionUpdate !== 'async_task_state_update') return null;
  const state = update.state;
  if (typeof state !== 'string' || !TASK_STATES.has(state)) return null;
  return { taskId, state: state as CarriedTask['state'] };
}

/** The `background_task` event a carried async task update stands for, if `raw` is one. */
export function asyncTaskEvent(raw: SessionUpdate): BackgroundTaskEvent | null {
  if (raw.sessionUpdate !== 'session_info_update') return null;
  const task = (raw._meta as Record<string, unknown> | null | undefined)?.[ASYNC_TASK_META_KEY] as
    | Partial<CarriedTask>
    | undefined;
  if (typeof task?.taskId !== 'string' || typeof task.state !== 'string') return null;
  if (!TASK_STATES.has(task.state)) return null;
  return { kind: 'background_task', taskId: task.taskId, state: task.state };
}
