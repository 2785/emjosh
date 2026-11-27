import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentBrowserPort } from '@core/features/browser/api/agent-browser';
import {
  CONTROL_MCP_INSTRUCTIONS,
  type ControlMcpEndpoint,
  startControlMcpEndpoint,
} from './mcp-endpoint';
import { WorkspaceControlService } from './workspace-control-service';

describe('control MCP endpoint', () => {
  let endpoint: ControlMcpEndpoint | undefined;
  let dir: string;

  afterEach(async () => {
    await endpoint?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function start(browser?: AgentBrowserPort) {
    dir = mkdtempSync(join(tmpdir(), 'control-endpoint-'));
    const callerContext = vi.fn(async (conversationId: string) =>
      conversationId === 'conv-1' ? { taskId: 't1', provider: 'claude' } : null
    );
    const service = new WorkspaceControlService({
      listProjects: async () => [{ id: 'p1', name: 'api', path: '/repos/api' }],
      listWorkspaces: async () => [
        {
          id: 't1',
          name: 'fix-login',
          projectId: 'p1',
          projectName: 'api',
          branch: null,
          archived: false,
          agentStatus: 'working',
          lastActivityAt: null,
          initiativeId: null,
        },
      ],
      pullRequestForBranch: async () => null,
      callerContext,
      archiveWorkspace: async () => {},
      restoreWorkspace: async () => {},
      renameWorkspace: async () => {},
      addProject: async () => ({ id: 'x', name: 'x', path: '/x' }),
      cloneProject: async () => ({ id: 'x', name: 'x', path: '/x' }),
      renameProject: async () => {},
      removeProject: async () => {},
      createWorkspace: async () => ({ id: 'x', name: 'x', branch: 'x' }),
      browser,
    });
    endpoint = await startControlMcpEndpoint({
      service,
      endpointFile: join(dir, 'control-endpoint.json'),
      version: 'test',
    });
    return { callerContext, file: join(dir, 'control-endpoint.json') };
  }

  async function connect(headers: Record<string, string>) {
    const client = new Client({ name: 'test', version: '1' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(endpoint!.info.url), { requestInit: { headers } })
    );
    return client;
  }

  it('tells agents to link workspaces with the emjosh scheme', async () => {
    await start();
    expect(CONTROL_MCP_INSTRUCTIONS).toContain('emjosh://workspace/<workspace id>');
    expect(CONTROL_MCP_INSTRUCTIONS).toContain('find_workspaces');
  });

  it('publishes its URL, token and instructions in a file only the user can read', async () => {
    const { file } = await start();

    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(endpoint!.info);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(endpoint!.info.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect(endpoint!.info.instructions).toBe(CONTROL_MCP_INSTRUCTIONS);
  });

  it('lets agents drive browser pages scoped to their workspace', async () => {
    const page = { pageId: 'p1', url: 'https://example.com/', title: 'Example', loading: false };
    const browser: AgentBrowserPort = {
      open: vi.fn(async () => page),
      pages: vi.fn(() => [page]),
      navigate: vi.fn(async () => page),
      snapshot: vi.fn(async () => ({ page, text: '[e1] link "More"' })),
      screenshot: vi.fn(async () => ({ page, pngBase64: 'aGk=' })),
      act: vi.fn(async () => ({ page, detail: 'Clicked.' })),
      console: vi.fn(async () => ({ page, entries: [{ level: 'error', text: 'boom' }] })),
      show: vi.fn(async () => page),
      close: vi.fn(async () => ({ closed: 'p1' })),
    };
    await start(browser);
    const client = await connect({
      authorization: `Bearer ${endpoint!.info.token}`,
      'x-emjosh-conversation': 'conv-1',
    });

    const opened = await client.callTool({
      name: 'browser_open',
      arguments: { url: 'https://example.com', show: true },
    });
    expect(browser.open).toHaveBeenCalledWith('t1', { url: 'https://example.com', show: true });
    expect(JSON.stringify(opened.content)).toContain('Page p1');

    const snapshot = await client.callTool({ name: 'browser_snapshot', arguments: {} });
    expect(browser.snapshot).toHaveBeenCalledWith('t1', undefined);
    expect(JSON.stringify(snapshot.content)).toContain('[e1] link');

    await client.callTool({ name: 'browser_click', arguments: { pageId: 'p1', ref: 'e1' } });
    expect(browser.act).toHaveBeenCalledWith('t1', 'p1', { type: 'click', ref: 'e1' });

    await client.callTool({
      name: 'browser_type',
      arguments: { ref: 'e2', text: 'hello', submit: true },
    });
    expect(browser.act).toHaveBeenLastCalledWith('t1', undefined, {
      type: 'type',
      ref: 'e2',
      text: 'hello',
      submit: true,
    });

    const shot = await client.callTool({ name: 'browser_screenshot', arguments: {} });
    expect(shot.content).toContainEqual({ type: 'image', data: 'aGk=', mimeType: 'image/png' });

    const logs = await client.callTool({ name: 'browser_console', arguments: {} });
    expect(JSON.stringify(logs.content)).toContain('[error] boom');
    await client.close();
  });

  it('reports that the agent browser is unavailable when the app has none', async () => {
    await start();
    const client = await connect({ authorization: `Bearer ${endpoint!.info.token}` });
    const result = await client.callTool({ name: 'browser_pages', arguments: {} });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('not available');
    await client.close();
  });

  it('serves the workspace tools to authenticated callers, scoped to their conversation', async () => {
    await start();
    const client = await connect({
      authorization: `Bearer ${endpoint!.info.token}`,
      'x-emjosh-conversation': 'conv-1',
    });

    const tools = (await client.listTools()).tools.map((tool) => tool.name).sort();
    expect(tools).toEqual([
      'add_project',
      'add_to_initiative',
      'add_workspace_agent',
      'app_api_call',
      'app_api_describe',
      'app_api_list',
      'app_api_read',
      'archive_workspaces',
      'browser_click',
      'browser_close',
      'browser_console',
      'browser_navigate',
      'browser_open',
      'browser_pages',
      'browser_press',
      'browser_screenshot',
      'browser_scroll',
      'browser_select',
      'browser_show',
      'browser_snapshot',
      'browser_type',
      'browser_wait_for',
      'clone_project',
      'create_initiative',
      'create_workspace',
      'current_workspace',
      'find_workspaces',
      'handoff_summary',
      'list_initiatives',
      'list_projects',
      'list_subscriptions',
      'list_workspaces',
      'mark_workspace_done',
      'merge_workspaces',
      'pin_workspaces',
      'post_message',
      'read_messages',
      'remove_from_initiative',
      'remove_project',
      'rename_project',
      'rename_workspace',
      'send_to_workspace',
      'set_initiative_lead',
      'set_message_delivery',
      'set_workspace_dependencies',
      'set_workspace_label',
      'stop_workspace',
      'subscribe',
      'unarchive_workspaces',
      'unsubscribe',
      'update_workspace_settings',
      'wait_for_messages',
      'workspace_settings',
    ]);
    // Clients such as Claude Code put these into the agent's system prompt.
    expect(client.getInstructions()).toContain('call rename_workspace');
    expect(client.getInstructions()).toContain('app_api_list');
    expect(client.getInstructions()).toContain('create_initiative');
    expect(client.getInstructions()).toContain('dedicated lead workspace that only orchestrates');
    expect(client.getInstructions()).toContain('background shell loop');
    expect(client.getInstructions()).toContain('set_message_delivery');
    expect(client.getInstructions()).toContain('not a branch-style slug');
    expect(client.getInstructions()).toContain("the lead's broadcasts");
    expect(client.getInstructions()).toContain("Don't do a workspace's work on its branch");
    expect(client.getInstructions()).toContain("Don't add dependencies by default");
    expect(client.getInstructions()).toContain('fold them with merge_workspaces');
    const dependencies = await client.callTool({
      name: 'set_workspace_dependencies',
      arguments: { workspaceId: 't1', dependsOn: [] },
    });
    expect(dependencies.isError).toBe(true);
    expect((dependencies.content as { text: string }[])[0]!.text).toContain(
      'Initiatives are not available'
    );
    const current = await client.callTool({ name: 'current_workspace', arguments: {} });
    expect(JSON.parse((current.content as { text: string }[])[0]!.text)).toMatchObject({
      id: 't1',
      name: 'fix-login',
    });
    await client.close();
  });

  it('rejects requests without the token', async () => {
    await start();

    await expect(connect({ authorization: 'Bearer wrong' })).rejects.toThrow();
    const response = await fetch(endpoint!.info.url, { method: 'POST', body: '{}' });
    expect(response.status).toBe(401);
  });
});
