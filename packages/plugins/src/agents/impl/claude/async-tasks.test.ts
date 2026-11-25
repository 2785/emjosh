import { PassThrough } from 'node:stream';
import type { AnyMessage, Client, SessionNotification } from '@agentclientprotocol/sdk';
import { decodeSessionUpdate } from '@emdash/core/runtimes/acp/api';
import { describe, expect, it, vi } from 'vitest';
import { connectStdioAcp } from '../../helpers/acp-stdio';
import { enrichClaudeUpdate } from './acp-transform';
import { carryAsyncTaskUpdate } from './async-tasks';

function sessionUpdate(update: Record<string, unknown>): AnyMessage {
  return { jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's1', update } };
}

const spawned = sessionUpdate({
  sessionUpdate: 'async_task_spawned',
  asyncTaskId: 'b1',
  name: 'pnpm test',
  taskType: 'shell',
  description: 'pnpm test',
  showInTranscript: true,
  canStop: true,
  toolCallId: 'tool-1',
});

function normalize(message: AnyMessage) {
  const update = (message as { params: SessionNotification }).params.update;
  return enrichClaudeUpdate(decodeSessionUpdate(update), update);
}

describe('Claude async task updates', () => {
  it('turns task start and end into background_task events', () => {
    expect(normalize(carryAsyncTaskUpdate(spawned)!)).toEqual({
      kind: 'background_task',
      taskId: 'b1',
      state: 'running',
    });
    const ended = sessionUpdate({
      sessionUpdate: 'async_task_state_update',
      asyncTaskId: 'b1',
      state: 'completed',
      summary: 'Tests passed',
    });
    expect(normalize(carryAsyncTaskUpdate(ended)!)).toEqual({
      kind: 'background_task',
      taskId: 'b1',
      state: 'completed',
    });
  });

  it('drops progress and malformed task updates', () => {
    expect(
      carryAsyncTaskUpdate(
        sessionUpdate({ sessionUpdate: 'async_task_progress', asyncTaskId: 'b1', summary: '…' })
      )
    ).toBeNull();
    expect(
      carryAsyncTaskUpdate(
        sessionUpdate({ sessionUpdate: 'async_task_state_update', asyncTaskId: 'b1', state: '?' })
      )
    ).toBeNull();
    expect(carryAsyncTaskUpdate(sessionUpdate({ sessionUpdate: 'async_task_spawned' }))).toBeNull();
  });

  it('passes every other message through untouched', () => {
    const chunk = sessionUpdate({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'hi' },
    });
    const response: AnyMessage = { jsonrpc: '2.0', id: 1, result: {} };
    expect(carryAsyncTaskUpdate(chunk)).toBe(chunk);
    expect(carryAsyncTaskUpdate(response)).toBe(response);
    expect(normalize(chunk)).toMatchObject({ kind: 'message', text: 'hi' });
  });

  it('leaves session titles to the baseline decoder', () => {
    const title = sessionUpdate({ sessionUpdate: 'session_info_update', title: 'Fix login' });
    expect(normalize(title)).toEqual({ kind: 'title', title: 'Fix login' });
  });

  it('delivers carried updates through the SDK, which rejects the raw ones', async () => {
    const raw = await deliver(undefined);
    expect(raw.map((params) => params.update.sessionUpdate)).toEqual(['agent_message_chunk']);
    const carried = await deliver(carryAsyncTaskUpdate);
    expect(carried).toHaveLength(2);
    expect(enrichClaudeUpdate(decodeSessionUpdate(carried[0]!.update), carried[0]!.update)).toEqual(
      { kind: 'background_task', taskId: 'b1', state: 'running' }
    );
  });
});

async function deliver(mapIncoming: typeof carryAsyncTaskUpdate | undefined) {
  const stdout = new PassThrough();
  const received: SessionNotification[] = [];
  const client = {
    sessionUpdate: vi.fn(async (params: SessionNotification) => {
      received.push(params);
    }),
  } as unknown as Client;
  connectStdioAcp({ stdin: new PassThrough(), stdout }, () => client, mapIncoming);
  stdout.write(`${JSON.stringify(spawned)}\n`);
  stdout.write(
    `${JSON.stringify(sessionUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } }))}\n`
  );
  // The message chunk is written last, so once it arrives everything before it was handled.
  await vi.waitFor(() => expect(received.at(-1)?.update.sessionUpdate).toBe('agent_message_chunk'));
  return received;
}
