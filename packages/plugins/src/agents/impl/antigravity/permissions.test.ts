import type {
  Client,
  RequestPermissionRequest,
  SessionConfigOption,
  SessionNotification,
} from '@agentclientprotocol/sdk';
import type { AcpAgentApi } from '@emdash/core/services/agent-plugins/api/plugins';
import { describe, expect, it, vi } from 'vitest';
import { BYPASS_MODE, withPermissionModes } from './permissions';

const modeOption = (currentValue: string): SessionConfigOption => ({
  id: 'mode',
  name: 'Mode',
  category: 'mode',
  type: 'select',
  currentValue,
  options: [
    { value: 'default', name: 'Default' },
    { value: 'accept-edits', name: 'Accept edits' },
    { value: 'auto', name: 'Auto' },
    { value: 'plan', name: 'Plan' },
  ],
});

const modeValues = (options: readonly SessionConfigOption[] | null | undefined) => {
  const mode = options?.find((option) => option.id === 'mode');
  return mode?.type === 'select'
    ? {
        current: mode.currentValue,
        choices: (mode.options as { value: string }[]).map((choice) => choice.value),
      }
    : undefined;
};

const permission = (title: string, kind: 'other' | 'execute'): RequestPermissionRequest => ({
  sessionId: 's',
  toolCall: { toolCallId: 't', title, kind, status: 'pending' },
  options: [
    { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
    { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
  ],
});
const approved = { outcome: { outcome: 'selected', optionId: 'allow' } };

function setup() {
  let agyMode = 'default';
  const asked: RequestPermissionRequest[] = [];
  const updates: SessionNotification[] = [];
  const inner: Client = {
    sessionUpdate: async (notification) => {
      updates.push(notification);
    },
    requestPermission: async (params) => {
      asked.push(params);
      return { outcome: { outcome: 'cancelled' } };
    },
  } as Client;
  let client!: Client;
  const agyAgent = {
    initialize: vi.fn(),
    newSession: vi.fn(async () => ({ sessionId: 's', configOptions: [modeOption(agyMode)] })),
    prompt: vi.fn(),
    cancel: vi.fn(),
    setSessionConfigOption: vi.fn(async (params: { value: string | boolean }) => {
      agyMode = String(params.value);
      // agy announces the new options before it answers.
      await client.sessionUpdate({
        sessionId: 's',
        update: { sessionUpdate: 'config_option_update', configOptions: [modeOption(agyMode)] },
      });
      return { configOptions: [modeOption(agyMode)] };
    }),
  } as unknown as AcpAgentApi;
  const agent = withPermissionModes((wrapClient) => {
    client = wrapClient(inner);
    return agyAgent;
  });
  return { agent, client: () => client, agyAgent, asked, updates, agyMode: () => agyMode };
}

describe('withPermissionModes', () => {
  it('adds a bypass choice to agy’s mode option', async () => {
    const { agent } = setup();
    const session = await agent.newSession({ cwd: '/w', mcpServers: [] });
    expect(modeValues(session.configOptions)).toEqual({
      current: 'default',
      choices: ['default', 'accept-edits', 'auto', 'plan', BYPASS_MODE],
    });
  });

  it('runs bypass as agy auto, shows bypass, and approves every permission request', async () => {
    const { agent, client, agyAgent, asked, updates, agyMode } = setup();
    await agent.newSession({ cwd: '/w', mcpServers: [] });
    const response = await agent.setSessionConfigOption!({
      sessionId: 's',
      configId: 'mode',
      value: BYPASS_MODE,
    });

    expect(agyAgent.setSessionConfigOption).toHaveBeenCalledWith({
      sessionId: 's',
      configId: 'mode',
      value: 'auto',
    });
    expect(agyMode()).toBe('auto');
    expect(modeValues(response.configOptions)?.current).toBe(BYPASS_MODE);
    const announced = updates[0]!.update;
    expect(
      announced.sessionUpdate === 'config_option_update' && modeValues(announced.configOptions)
    ).toMatchObject({ current: BYPASS_MODE });
    await expect(
      client().requestPermission(permission('rm -rf build', 'execute'))
    ).resolves.toEqual(approved);
    expect(asked).toEqual([]);
  });

  it('in auto, approves only the host’s emjosh MCP tools', async () => {
    const { agent, client, asked } = setup();
    await agent.newSession({ cwd: '/w', mcpServers: [] });
    await agent.setSessionConfigOption!({ sessionId: 's', configId: 'mode', value: 'auto' });

    await expect(
      client().requestPermission(permission('Run mcp_emjosh_rename_workspace', 'other'))
    ).resolves.toEqual(approved);
    await client().requestPermission(permission('Run mcp_github_create_issue', 'other'));
    await client().requestPermission(permission('echo Run mcp_emjosh_x', 'execute'));
    await client().requestPermission(permission('Run mcp_emjosh_x', 'execute'));
    expect(asked.map((request) => request.toolCall.title)).toEqual([
      'Run mcp_github_create_issue',
      'echo Run mcp_emjosh_x',
      'Run mcp_emjosh_x',
    ]);
  });

  it('asks as usual in other modes and after leaving bypass', async () => {
    const { agent, client, asked } = setup();
    await agent.newSession({ cwd: '/w', mcpServers: [] });
    await client().requestPermission(permission('Run mcp_emjosh_list_projects', 'other'));
    await agent.setSessionConfigOption!({ sessionId: 's', configId: 'mode', value: BYPASS_MODE });
    await agent.setSessionConfigOption!({ sessionId: 's', configId: 'mode', value: 'default' });
    await client().requestPermission(permission('ls', 'execute'));
    expect(asked).toHaveLength(2);
  });

  it('pauses bypass while agy is out of auto and resumes it when agy returns', async () => {
    const { agent, client, updates, asked } = setup();
    await agent.newSession({ cwd: '/w', mcpServers: [] });
    await agent.setSessionConfigOption!({ sessionId: 's', configId: 'mode', value: BYPASS_MODE });
    const switchTo = (mode: string) =>
      client().sessionUpdate({
        sessionId: 's',
        update: { sessionUpdate: 'config_option_update', configOptions: [modeOption(mode)] },
      });

    await client().sessionUpdate({
      sessionId: 's',
      update: { sessionUpdate: 'current_mode_update', currentModeId: 'plan' },
    });
    await switchTo('plan');
    await client().requestPermission(permission('ls', 'execute'));
    expect(asked).toHaveLength(1);

    // agy leaving plan mode puts itself back in auto: the user's bypass applies again.
    await client().sessionUpdate({
      sessionId: 's',
      update: { sessionUpdate: 'current_mode_update', currentModeId: 'auto' },
    });
    await switchTo('auto');
    const announced = updates.at(-1)!.update;
    expect(
      announced.sessionUpdate === 'config_option_update' && modeValues(announced.configOptions)
    ).toMatchObject({ current: BYPASS_MODE });
    await expect(
      client().requestPermission(permission('curl -X POST https://staging', 'execute'))
    ).resolves.toEqual(approved);
    expect(asked).toHaveLength(1);
  });

  it('drops bypass when the user picks another mode, even after agy changes modes itself', async () => {
    const { agent, client, asked } = setup();
    await agent.newSession({ cwd: '/w', mcpServers: [] });
    await agent.setSessionConfigOption!({ sessionId: 's', configId: 'mode', value: BYPASS_MODE });
    await agent.setSessionConfigOption!({ sessionId: 's', configId: 'mode', value: 'auto' });
    await client().requestPermission(permission('ls', 'execute'));
    expect(asked).toHaveLength(1);
  });

  it('restores bypass when agy fails to switch modes', async () => {
    const { agent, agyAgent, client, asked } = setup();
    await agent.newSession({ cwd: '/w', mcpServers: [] });
    vi.mocked(agyAgent.setSessionConfigOption!).mockRejectedValueOnce(new Error('nope'));
    await expect(
      agent.setSessionConfigOption!({ sessionId: 's', configId: 'mode', value: BYPASS_MODE })
    ).rejects.toThrow('nope');
    await client().requestPermission(permission('ls', 'execute'));
    expect(asked).toHaveLength(1);
  });
});
