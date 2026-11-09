import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type ControlMcpEndpoint, startControlMcpEndpoint } from './mcp-endpoint';
import { WorkspaceControlService } from './workspace-control-service';

describe('control MCP endpoint', () => {
  let endpoint: ControlMcpEndpoint | undefined;
  let dir: string;

  afterEach(async () => {
    await endpoint?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function start() {
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
      renameWorkspace: async () => {},
      createWorkspace: async () => ({ id: 'x', name: 'x', branch: 'x' }),
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

  it('publishes its URL and token in a file only the user can read', async () => {
    const { file } = await start();

    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(endpoint!.info);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(endpoint!.info.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
  });

  it('serves the workspace tools to authenticated callers, scoped to their conversation', async () => {
    await start();
    const client = await connect({
      authorization: `Bearer ${endpoint!.info.token}`,
      'x-emjosh-conversation': 'conv-1',
    });

    const tools = (await client.listTools()).tools.map((tool) => tool.name).sort();
    expect(tools).toEqual([
      'add_to_initiative',
      'archive_workspaces',
      'create_initiative',
      'create_workspace',
      'current_workspace',
      'list_initiatives',
      'list_projects',
      'list_workspaces',
      'post_message',
      'read_messages',
      'remove_from_initiative',
      'rename_workspace',
      'set_message_delivery',
      'wait_for_messages',
    ]);
    // Clients such as Claude Code put these into the agent's system prompt.
    expect(client.getInstructions()).toContain('call rename_workspace');
    expect(client.getInstructions()).toContain('create_initiative');
    expect(client.getInstructions()).toContain('background shell loop');
    expect(client.getInstructions()).toContain('set_message_delivery');
    expect(client.getInstructions()).toContain('not a branch-style slug');
    expect(client.getInstructions()).toContain("Don't do another workspace's work on its branch");
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
