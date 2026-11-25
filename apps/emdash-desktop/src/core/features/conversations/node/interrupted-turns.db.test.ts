import { ok, type Result } from '@emdash/shared';
import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '@core/services/app-db/node/db';
import {
  INTERRUPTED_TURN_PROMPT,
  readInterruptedTurns,
  recordInterruptedAcpTurns,
  startInterruptedTurnResumer,
} from './interrupted-turns';
import { resetStaleAcpAgentStatuses } from './reset-stale-acp-agent-statuses';

const logger = { warn: vi.fn() };

describe('interrupted chat turns', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;
  let db: AppDb;

  beforeEach(async () => {
    fixture = await openFixture('empty');
    fixture.sqlite.pragma('foreign_keys = OFF');
    db = fixture.db as unknown as AppDb;
  });

  afterEach(() => fixture.close());

  describe('recording at boot', () => {
    it('records only local, linked chat conversations whose agent was working', async () => {
      seed({ id: 'working' });
      seed({ id: 'awaiting', status: 'awaiting-input' });
      seed({ id: 'idle', status: 'idle' });
      seed({ id: 'completed', status: 'completed' });
      seed({ id: 'tui', type: 'pty' });
      seed({ id: 'remote', location: 'remote' });
      seed({ id: 'unlinked', projectId: null, taskId: null });
      seed({ id: 'untracked', untracked: true });

      await recordInterruptedAcpTurns(db, logger);

      expect(await readInterruptedTurns(db)).toEqual(['working']);
    });

    it('keeps conversations recorded by an earlier boot that were not resumed yet', async () => {
      seed({ id: 'first' });
      await recordInterruptedAcpTurns(db, logger);
      await resetStaleAcpAgentStatuses(db);
      seed({ id: 'second' });

      await recordInterruptedAcpTurns(db, logger);

      expect(await readInterruptedTurns(db)).toEqual(['first', 'second']);
    });

    it('records before the stale status repair clears the working status', async () => {
      seed({ id: 'working' });

      await recordInterruptedAcpTurns(db, logger);
      await resetStaleAcpAgentStatuses(db);

      expect(statusOf('working')).toBe('idle');
      expect(await readInterruptedTurns(db)).toEqual(['working']);
    });
  });

  describe('resuming', () => {
    it('sends one keep-going prompt once the project is attached, then clears the record', async () => {
      await recordAndRepair([{ id: 'c1' }]);
      const harness = createHarness({ attached: ['project-1'] });

      await vi.waitFor(() => expect(harness.send).toHaveBeenCalledTimes(1));
      expect(harness.start).toHaveBeenCalledWith('c1');
      expect(harness.send).toHaveBeenCalledWith('c1', INTERRUPTED_TURN_PROMPT);
      expect(await readInterruptedTurns(db)).toEqual([]);

      harness.openProject('project-1');
      await flush();
      expect(harness.send).toHaveBeenCalledTimes(1);
      harness.dispose();
    });

    it('waits for the conversation project to attach', async () => {
      await recordAndRepair([{ id: 'c1' }, { id: 'c2', projectId: 'project-2' }]);
      const harness = createHarness({ attached: ['project-1'] });

      await vi.waitFor(() => expect(harness.send).toHaveBeenCalledWith('c1', expect.any(String)));
      expect(await readInterruptedTurns(db)).toEqual(['c2']);

      harness.openProject('project-2');
      await vi.waitFor(() => expect(harness.send).toHaveBeenCalledWith('c2', expect.any(String)));
      expect(harness.send).toHaveBeenCalledTimes(2);
      expect(await readInterruptedTurns(db)).toEqual([]);
      harness.dispose();
    });

    it('sends nothing and clears the record when the setting is off', async () => {
      await recordAndRepair([{ id: 'c1' }]);
      const harness = createHarness({ attached: ['project-1'], enabled: false });

      await vi.waitFor(async () => expect(await readInterruptedTurns(db)).toEqual([]));
      expect(harness.start).not.toHaveBeenCalled();
      expect(harness.send).not.toHaveBeenCalled();
      harness.dispose();
    });

    it('skips a conversation the user already sent something to', async () => {
      await recordAndRepair([{ id: 'c1' }]);
      setStatus('c1', 'working');
      const harness = createHarness({ attached: ['project-1'] });

      await vi.waitFor(async () => expect(await readInterruptedTurns(db)).toEqual([]));
      expect(harness.send).not.toHaveBeenCalled();
      harness.dispose();
    });

    it('skips a conversation that got busy while its session was starting', async () => {
      await recordAndRepair([{ id: 'c1' }]);
      const harness = createHarness({
        attached: ['project-1'],
        onStart: () => setStatus('c1', 'working'),
      });

      await vi.waitFor(() => expect(harness.start).toHaveBeenCalledWith('c1'));
      await flush();
      expect(harness.send).not.toHaveBeenCalled();
      expect(await readInterruptedTurns(db)).toEqual([]);
      harness.dispose();
    });

    it('drops deleted conversations without sending', async () => {
      await recordAndRepair([{ id: 'c1', untracked: true }]);
      const harness = createHarness({ attached: ['project-1'] });

      await vi.waitFor(async () => expect(await readInterruptedTurns(db)).toEqual([]));
      expect(harness.send).not.toHaveBeenCalled();
      harness.dispose();
    });
  });

  type SeedInput = {
    id: string;
    type?: 'acp' | 'pty';
    location?: 'local' | 'remote';
    status?: string;
    projectId?: string | null;
    taskId?: string | null;
    untracked?: boolean;
  };

  function seed(input: SeedInput): void {
    fixture.sqlite
      .prepare(
        `INSERT INTO conversations
          (id, title, type, location, agent_status, project_id, task_id, untracked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.id,
        input.id,
        input.type ?? 'acp',
        input.location ?? 'local',
        input.status ?? 'working',
        input.projectId === undefined ? 'project-1' : input.projectId,
        input.taskId === undefined ? 'task-1' : input.taskId,
        input.untracked ? '2026-01-01T00:00:00.000Z' : null
      );
  }

  async function recordAndRepair(inputs: SeedInput[]): Promise<void> {
    for (const input of inputs) seed({ ...input, untracked: false });
    await recordInterruptedAcpTurns(db, logger);
    await resetStaleAcpAgentStatuses(db);
    for (const input of inputs) {
      if (input.untracked) {
        fixture.sqlite
          .prepare(`UPDATE conversations SET untracked_at = ? WHERE id = ?`)
          .run('2026-01-01T00:00:00.000Z', input.id);
      }
    }
  }

  function setStatus(id: string, status: string): void {
    fixture.sqlite
      .prepare(`UPDATE conversations SET agent_status = ? WHERE id = ?`)
      .run(status, id);
  }

  function statusOf(id: string): string | null {
    const row = fixture.sqlite
      .prepare(`SELECT agent_status FROM conversations WHERE id = ?`)
      .get(id) as { agent_status: string | null } | undefined;
    return row?.agent_status ?? null;
  }

  function createHarness(options: { attached: string[]; enabled?: boolean; onStart?: () => void }) {
    const attached = new Set(options.attached);
    let opened: ((projectId: string) => void) | undefined;
    const start = vi.fn(async (_conversationId: string): Promise<Result<unknown, unknown>> => {
      options.onStart?.();
      return ok();
    });
    const send = vi.fn(
      async (_conversationId: string, _text: string): Promise<Result<unknown, unknown>> => ok()
    );
    const dispose = startInterruptedTurnResumer({
      db,
      projects: {
        on: ((_name: 'projectOpened', handler: (projectId: string) => void) => {
          opened = handler;
          return () => {
            opened = undefined;
          };
        }) as never,
        requireAttached: ((projectId: string) =>
          attached.has(projectId)
            ? ok({})
            : { success: false, error: { type: 'not-attached' } }) as never,
      },
      isEnabled: async () => options.enabled ?? true,
      start,
      send,
      logger,
    });
    return {
      start,
      send,
      dispose,
      openProject(projectId: string) {
        attached.add(projectId);
        opened?.(projectId);
      },
    };
  }
});

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}
