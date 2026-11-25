// Stand-in for `codex app-server`: answers the JSON-RPC requests codex-acp makes to start and
// configure sessions, and appends each request to $FAKE_CODEX_LOG as one JSON line.
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const THREAD_ID = 'thread-1';

function thread(cwd) {
  return {
    id: THREAD_ID,
    extra: null,
    sessionId: THREAD_ID,
    forkedFromId: null,
    parentThreadId: null,
    preview: '',
    ephemeral: false,
    isPinned: false,
    historyMode: 'legacy',
    modelProvider: 'openai',
    createdAt: 1,
    updatedAt: 1,
    recencyAt: 1,
    status: { type: 'idle' },
    path: null,
    cwd,
    cliVersion: '0.146.1',
    source: 'vscode',
    canAcceptDirectInput: true,
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    turns: [],
  };
}

function threadResponse(cwd) {
  return {
    thread: thread(cwd),
    model: 'gpt-5.6-sol',
    modelProvider: 'openai',
    serviceTier: null,
    cwd,
    runtimeWorkspaceRoots: [cwd],
    instructionSources: [],
    approvalPolicy: 'on-request',
    approvalsReviewer: 'user',
    sandbox: { type: 'workspaceWrite', writableRoots: [], networkAccess: false },
    reasoningEffort: null,
    multiAgentMode: 'explicitRequestOnly',
  };
}

const model = {
  id: 'gpt-5.6-sol',
  model: 'gpt-5.6-sol',
  displayName: 'GPT-5.6-Sol',
  description: 'Fake model.',
  hidden: false,
  supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'Low' }],
  defaultReasoningEffort: 'low',
  inputModalities: ['text'],
  supportsPersonality: false,
  isDefault: true,
};

function result(method, params) {
  switch (method) {
    case 'initialize':
      return {
        userAgent: 'fake',
        codexHome: '/nonexistent',
        platformFamily: 'unix',
        platformOs: 'macos',
      };
    case 'config/read':
      return { config: {}, origins: {}, layers: [] };
    case 'account/read':
      return { account: { type: 'apiKey' }, requiresOpenaiAuth: false };
    case 'skills/list':
      return { data: [] };
    case 'model/list':
      return { data: [model], nextCursor: null };
    case 'thread/start':
    case 'thread/resume':
      return threadResponse(params?.cwd ?? '/');
    case 'thread/read':
      return { thread: thread(params?.cwd ?? '/') };
    default:
      return {};
  }
}

createInterface({ input: process.stdin }).on('line', (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (typeof message.method !== 'string' || message.id === undefined) return;
  if (process.env.FAKE_CODEX_LOG) {
    appendFileSync(
      process.env.FAKE_CODEX_LOG,
      `${JSON.stringify({ method: message.method, params: message.params })}\n`
    );
  }
  process.stdout.write(
    `${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: result(message.method, message.params) })}\n`
  );
});
