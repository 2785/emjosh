import type {
  Client,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionConfigOption,
} from '@agentclientprotocol/sdk';
import type { AcpAgentApi } from '@emdash/core/services/agent-plugins/api/plugins';
import { override } from './override';

/** Mode added to agy's `mode` option: agy runs in `auto` and every permission request is approved. */
export const BYPASS_MODE = 'bypass';
const AGY_AUTO_MODE = 'auto';
const MODE_OPTION_ID = 'mode';
/**
 * agy titles an MCP tool call `Run mcp_<server>_<tool>` with kind `other`; the host's server is
 * `emjosh`. Shell commands are titled with their command line and have kind `execute`.
 */
const HOST_MCP_CALL_TITLE = /^Run mcp_emjosh_[A-Za-z0-9_]+$/;

const bypassChoice = {
  value: BYPASS_MODE,
  name: 'Bypass permissions',
  description: 'Auto mode, and approve every permission request without asking.',
};

type SessionModes = Map<string, { agyMode?: string; bypass: boolean }>;

/**
 * agy has no ACP mode that never asks: `auto` still asks before MCP tool calls and commands that
 * leave its sandbox, and `--dangerously-skip-permissions` covers the whole process. So:
 * - a `bypass` choice is added to agy's mode option; it runs agy in `auto` and approves every
 *   permission request itself;
 * - in `auto`, calls to the host's own `emjosh` MCP tools are approved without asking.
 */
export function withPermissionModes(
  connect: (wrapClient: (client: Client) => Client) => AcpAgentApi
): AcpAgentApi {
  const sessions: SessionModes = new Map();
  const session = (id: string) => {
    let state = sessions.get(id);
    if (!state) sessions.set(id, (state = { bypass: false }));
    return state;
  };
  /** Records agy's mode from its options and shows `bypass` in its place while it is active. */
  const present = (
    sessionId: string,
    options: readonly SessionConfigOption[] | null | undefined
  ): SessionConfigOption[] | null | undefined => {
    if (!options) return options as null | undefined;
    const state = session(sessionId);
    return options.map((option) => {
      if (option.id !== MODE_OPTION_ID || option.type !== 'select') return option;
      state.agyMode = option.currentValue;
      if (state.agyMode !== AGY_AUTO_MODE) state.bypass = false;
      const choices = option.options as readonly { value: string }[];
      return {
        ...option,
        currentValue: state.bypass ? BYPASS_MODE : option.currentValue,
        options: (choices.some((choice) => choice.value === BYPASS_MODE)
          ? choices
          : [...choices, bypassChoice]) as typeof option.options,
      };
    });
  };

  const agent = connect((client) =>
    override(client, {
      sessionUpdate: (notification) => {
        const { update } = notification;
        if (update.sessionUpdate === 'config_option_update') {
          return client.sessionUpdate({
            ...notification,
            update: {
              ...update,
              configOptions: present(notification.sessionId, update.configOptions)!,
            },
          });
        }
        if (update.sessionUpdate === 'current_mode_update') {
          const state = session(notification.sessionId);
          state.agyMode = update.currentModeId;
          if (state.agyMode !== AGY_AUTO_MODE) state.bypass = false;
        }
        return client.sessionUpdate(notification);
      },
      requestPermission: async (params) => {
        const approval = autoApproval(sessions.get(params.sessionId), params);
        return approval ?? client.requestPermission(params);
      },
    })
  );

  const loadSession = agent.loadSession?.bind(agent);
  const setSessionConfigOption = agent.setSessionConfigOption?.bind(agent);
  return override(agent, {
    newSession: async (params) => {
      const response = await agent.newSession(params);
      return { ...response, configOptions: present(response.sessionId, response.configOptions) };
    },
    ...(loadSession && {
      loadSession: async (params) => {
        const response = await loadSession(params);
        return { ...response, configOptions: present(params.sessionId, response.configOptions) };
      },
    }),
    ...(setSessionConfigOption && {
      setSessionConfigOption: async (params) => {
        if (params.configId !== MODE_OPTION_ID) {
          const response = await setSessionConfigOption(params);
          return {
            ...response,
            configOptions: present(params.sessionId, response.configOptions) ?? [],
          };
        }
        // Set first: agy announces the new options before it answers.
        const state = session(params.sessionId);
        const previous = state.bypass;
        state.bypass = params.value === BYPASS_MODE;
        let response;
        try {
          response = await setSessionConfigOption(
            state.bypass ? { ...params, value: AGY_AUTO_MODE } : params
          );
        } catch (error) {
          state.bypass = previous;
          throw error;
        }
        return {
          ...response,
          configOptions: present(params.sessionId, response.configOptions) ?? [],
        };
      },
    }),
  });
}

function autoApproval(
  state: { agyMode?: string; bypass: boolean } | undefined,
  params: RequestPermissionRequest
): RequestPermissionResponse | null {
  const approve =
    state?.bypass === true || (state?.agyMode === AGY_AUTO_MODE && isHostMcpCall(params.toolCall));
  if (!approve) return null;
  const allow =
    params.options.find((option) => option.kind === 'allow_always') ??
    params.options.find((option) => option.kind === 'allow_once');
  return allow ? { outcome: { outcome: 'selected', optionId: allow.optionId } } : null;
}

function isHostMcpCall(toolCall: RequestPermissionRequest['toolCall']): boolean {
  return toolCall.kind === 'other' && HOST_MCP_CALL_TITLE.test(toolCall.title ?? '');
}
