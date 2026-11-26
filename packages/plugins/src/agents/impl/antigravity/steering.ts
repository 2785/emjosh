import type { PromptRequest, PromptResponse } from '@agentclientprotocol/sdk';
import type { AcpAgentApi } from '@emdash/core/services/agent-plugins/api/plugins';
import { override } from './override';

/**
 * agy steers its running turn when a second `session/prompt` arrives on the same session: it
 * answers the first prompt at once with `end_turn`, keeps working, and answers the second prompt
 * when the turn really ends. The runtime would read the early answer as the turn ending, so this
 * wrapper
 * - offers the runtime's `_session/steering` (a prompt sent into the running turn), and
 * - holds the first prompt's answer back until the last steering prompt is answered.
 */
export function withSteering(agent: AcpAgentApi): AcpAgentApi {
  const running = new Set<string>();
  const latest = new Map<string, Promise<PromptResponse>>();

  const initialize: AcpAgentApi['initialize'] = async (params) => {
    const response = await agent.initialize(params);
    return {
      ...response,
      _meta: { ...response._meta, steering: { supported: true } },
    };
  };

  const prompt: AcpAgentApi['prompt'] = async (params) => {
    const { sessionId } = params;
    running.add(sessionId);
    try {
      let result = await agent.prompt(params);
      // Steering prompts sent while this one ran; a newer one may arrive while one is awaited.
      for (let next = latest.get(sessionId); next; next = latest.get(sessionId)) {
        latest.delete(sessionId);
        result = await next;
      }
      return result;
    } finally {
      running.delete(sessionId);
      latest.delete(sessionId);
    }
  };

  const extMethod: NonNullable<AcpAgentApi['extMethod']> = async (method, params) => {
    if (method !== '_session/steering') {
      if (!agent.extMethod) throw new Error(`Unsupported extension method ${method}`);
      return agent.extMethod(method, params);
    }
    const sessionId = String(params.sessionId);
    // A turn that already ended would take this as a new turn the runtime knows nothing about.
    if (!running.has(sessionId)) return { outcome: 'not_running' };
    const steering = agent.prompt({
      sessionId,
      prompt: params.prompt as PromptRequest['prompt'],
    });
    // The running prompt awaits it; if that one fails first, nobody else reports this failure.
    steering.catch(() => {});
    latest.set(sessionId, steering);
    return { outcome: 'injected' };
  };

  return override(agent, { initialize, prompt, extMethod });
}
