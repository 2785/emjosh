/**
 * Pins the Emjosh patch to codex-acp (patches/@agentclientprotocol__codex-acp@*.patch): the
 * session's permission mode is applied to the Codex thread, so turns Codex starts itself (goal
 * continuations) run with it. Drives the real adapter against a stand-in `codex app-server`.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AcpAgentApi } from '@emdash/core/services/agent-plugins/api/plugins';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pluginRegistry } from '../../registry';

const ADAPTER = createRequire(import.meta.url).resolve(
  '@agentclientprotocol/codex-acp/dist/index.js'
);
const FAKE_SERVER = fileURLToPath(new URL('./fixtures/fake-codex-app-server.mjs', import.meta.url));

type Request = { method: string; params: Record<string, unknown> };

describe.skipIf(process.platform === 'win32')('codex-acp thread permissions patch', () => {
  let dir: string;
  let child: ChildProcess;
  let agent: AcpAgentApi;
  let log: string;

  const threadSettingsUpdates = () =>
    readFileSync(log, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Request)
      .filter((request) => request.method === 'thread/settings/update')
      .map(({ params }) => ({
        approvalPolicy: params.approvalPolicy,
        approvalsReviewer: params.approvalsReviewer,
        sandbox: (params.sandboxPolicy as { type?: string } | undefined)?.type,
      }));

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'codex-acp-patch-'));
    log = join(dir, 'requests.jsonl');
    writeFileSync(log, '');
    const codex = join(dir, 'codex');
    writeFileSync(codex, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_SERVER}" "$@"\n`);
    chmodSync(codex, 0o755);
    child = spawn(process.execPath, [ADAPTER], {
      cwd: dir,
      env: { ...process.env, CODEX_PATH: codex, FAKE_CODEX_LOG: log, CODEX_HOME: dir },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    agent = pluginRegistry
      .get('codex')!
      .behavior.acp!.connect({ stdin: child.stdin!, stdout: child.stdout! }, () => ({
        sessionUpdate: async () => {},
        requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
      }));
    await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
  });

  afterEach(() => {
    child.kill();
    rmSync(dir, { recursive: true, force: true });
  });

  it('applies the default mode to a new thread, then each mode change', async () => {
    const { sessionId } = await agent.newSession({ cwd: dir, mcpServers: [] });
    expect(threadSettingsUpdates()).toEqual([
      { approvalPolicy: 'on-request', approvalsReviewer: 'auto_review', sandbox: 'workspaceWrite' },
    ]);

    await agent.setSessionConfigOption!({
      sessionId,
      configId: 'mode',
      value: 'agent-full-access',
    });
    await agent.setSessionConfigOption!({ sessionId, configId: 'mode', value: 'read-only' });

    expect(threadSettingsUpdates().slice(1)).toEqual([
      { approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: 'dangerFullAccess' },
      { approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: expect.any(String) },
    ]);
  });

  it('applies the mode to a loaded thread', async () => {
    await agent.loadSession!({ sessionId: 'thread-1', cwd: dir, mcpServers: [] });
    expect(threadSettingsUpdates()).toEqual([
      { approvalPolicy: 'on-request', approvalsReviewer: 'auto_review', sandbox: 'workspaceWrite' },
    ]);
  });
});
