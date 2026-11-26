import type { PromptResponse } from '@agentclientprotocol/sdk';
import type { AcpAgentApi } from '@emdash/core/services/agent-plugins/api/plugins';
import { describe, expect, it, vi } from 'vitest';
import { withSteering } from './steering';

type Deferred = { promise: Promise<PromptResponse>; resolve: (r: PromptResponse) => void };
function deferred(): Deferred {
  let resolve!: (r: PromptResponse) => void;
  const promise = new Promise<PromptResponse>((r) => (resolve = r));
  return { promise, resolve };
}
const answer = (text: string): PromptResponse =>
  ({ stopReason: 'end_turn', _meta: { text } }) as PromptResponse;
const text = (r: PromptResponse) => (r._meta as { text: string }).text;

function fakeAgent() {
  const prompts: Deferred[] = [];
  const agent = {
    initialize: vi.fn(async () => ({ protocolVersion: 1, _meta: { other: 1 } })),
    prompt: vi.fn(() => {
      const d = deferred();
      prompts.push(d);
      return d.promise;
    }),
    extMethod: vi.fn(async () => ({ forwarded: true })),
  } as unknown as AcpAgentApi;
  return { agent, prompts };
}

const content = [{ type: 'text', text: 'also do X' }] as never;

describe('withSteering', () => {
  it('advertises steering and keeps the rest of the initialize response', async () => {
    const { agent } = fakeAgent();

    const response = await withSteering(agent).initialize({ protocolVersion: 1 });

    expect(response._meta).toEqual({ other: 1, steering: { supported: true } });
  });

  it('sends a steering prompt into the running turn and reports it injected', async () => {
    const { agent, prompts } = fakeAgent();
    const steered = withSteering(agent);
    void steered.prompt({ sessionId: 's', prompt: [] });

    const outcome = await steered.extMethod!('_session/steering', {
      sessionId: 's',
      prompt: content,
    });

    expect(outcome).toEqual({ outcome: 'injected' });
    expect(prompts).toHaveLength(2);
    expect(agent.prompt).toHaveBeenLastCalledWith({ sessionId: 's', prompt: content });
  });

  it('answers the turn with the last steering prompt, not the early answer to the first', async () => {
    const { agent, prompts } = fakeAgent();
    const steered = withSteering(agent);
    let settled: PromptResponse | undefined;
    void steered.prompt({ sessionId: 's', prompt: [] }).then((r) => (settled = r));
    await steered.extMethod!('_session/steering', { sessionId: 's', prompt: content });

    prompts[0]!.resolve(answer('early'));
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBeUndefined();

    prompts[1]!.resolve(answer('final'));
    await vi.waitFor(() => expect(settled).toBeDefined());
    expect(text(settled!)).toBe('final');
  });

  it('follows a chain of steering prompts to the last one', async () => {
    const { agent, prompts } = fakeAgent();
    const steered = withSteering(agent);
    let settled: PromptResponse | undefined;
    void steered.prompt({ sessionId: 's', prompt: [] }).then((r) => (settled = r));
    await steered.extMethod!('_session/steering', { sessionId: 's', prompt: content });
    await steered.extMethod!('_session/steering', { sessionId: 's', prompt: content });

    prompts[0]!.resolve(answer('first'));
    prompts[1]!.resolve(answer('second'));
    prompts[2]!.resolve(answer('third'));

    await vi.waitFor(() => expect(settled).toBeDefined());
    expect(text(settled!)).toBe('third');
  });

  it('declines when no turn is running, so the runtime queues the message instead', async () => {
    const { agent } = fakeAgent();
    const steered = withSteering(agent);

    const outcome = await steered.extMethod!('_session/steering', {
      sessionId: 's',
      prompt: content,
    });

    expect(outcome).toEqual({ outcome: 'not_running' });
    expect(agent.prompt).not.toHaveBeenCalled();
  });

  it('does not leak a steering prompt into the next turn', async () => {
    const { agent, prompts } = fakeAgent();
    const steered = withSteering(agent);
    const first = steered.prompt({ sessionId: 's', prompt: [] });
    prompts[0]!.resolve(answer('one'));
    await first;

    const second = steered.prompt({ sessionId: 's', prompt: [] });
    prompts[1]!.resolve(answer('two'));

    expect(text(await second)).toBe('two');
  });

  it('forwards other extension methods', async () => {
    const { agent } = fakeAgent();

    const result = await withSteering(agent).extMethod!('_other/thing', { a: 1 });

    expect(result).toEqual({ forwarded: true });
    expect(agent.extMethod).toHaveBeenCalledWith('_other/thing', { a: 1 });
  });
});
