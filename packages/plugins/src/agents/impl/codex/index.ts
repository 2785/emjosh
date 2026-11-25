import {
  definePlugin,
  registerPluginBehavior,
} from '@emdash/core/services/agent-plugins/api/plugins';
import {
  buildStandardCommand,
  codexMcpAdapter,
  homebrewOption,
  npmDependency,
} from '@emdash/core/services/agent-plugins/api/plugins/helpers';
import { connectStdioAcp } from '../../helpers/acp-stdio';
import { resolveAdapterAsset } from '../../helpers/adapter-assets';
import { authenticatedFromEnv, commandAuthStatus } from '../../helpers/auth';
import { enrichCodexUpdate } from './acp-enrich';
import { isCodexSessionNotFound } from './acp-errors';
import { codexAcpConfigEnv } from './acp-spawn';
import { codexAdapter } from './adapter';
import { buildCodexHookConfig } from './hooks';
import { icon } from './icon';
import { probeCodexUsage } from './usage';

export const plugin = definePlugin(
  {
    id: 'codex',
    name: 'Codex',
    description:
      'CLI that connects to OpenAI models for project-aware code assistance and terminal workflows.',
    websiteUrl: 'https://github.com/openai/codex',
  },
  {
    usageLimits: { kind: 'supported' },
    acp: {
      kind: 'supported',
    },
    autoApprove: {
      kind: 'supported',
    },
    auth: {
      kind: 'supported',
      methods: [
        {
          kind: 'cli-login',
          id: 'codex-login',
          name: 'Sign in with Codex',
          args: ['login', '--device-auth'],
          description: 'Open the Codex CLI sign-in flow in a terminal.',
        },
        {
          kind: 'api-key',
          id: 'openai-api-key',
          name: 'Use an OpenAI API key',
          envVars: [{ name: 'OPENAI_API_KEY', label: 'OpenAI API key' }],
          helpUrl: 'https://platform.openai.com/api-keys',
        },
      ],
    },
    models: {
      kind: 'selectable',
      modelOptions: {
        'gpt-5.6-sol': {
          name: '5.6 Sol',
          description: 'Model for coding and everyday work.',
          modelFeatures: { intelligence: 5, speed: 3 },
        },
        'gpt-5.6-terra': {
          name: '5.6 Terra',
          description: 'Balanced model for agentic coding.',
          modelFeatures: { intelligence: 5, speed: 4 },
        },
        'gpt-5.6-luna': {
          name: '5.6 Luna',
          description: 'Fast model for simpler tasks.',
          modelFeatures: { intelligence: 4, speed: 5 },
        },
      },
    },
    hooks: {
      kind: 'config',
      scope: 'global',
      supportedEvents: ['notification', 'stop', 'session'],
    },
    hostDependency: npmDependency({
      id: 'codex',
      package: '@openai/codex',
      extraOptions: {
        macos: [
          {
            method: 'curl',
            command: 'curl -fsSL https://chatgpt.com/codex/install.sh | sh',
            elevation: 'never',
          },
          homebrewOption({ formula: 'codex', cask: true }),
        ],
        linux: [
          {
            method: 'curl',
            command: 'curl -fsSL https://chatgpt.com/codex/install.sh | sh',
            elevation: 'never',
          },
          homebrewOption({ formula: 'codex', cask: true }),
        ],
        windows: [
          {
            method: 'powershell',
            command:
              'powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"',
            updateCommand:
              'powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"',
          },
        ],
      },
    }),
    mcp: {
      kind: 'supported',
      scope: 'global',
      supportedTransports: ['stdio', 'http'],
    },
    prompt: {
      kind: 'argv',
      flag: '',
    },
    sessions: {
      kind: 'resumable',
    },
  },
  { icon }
);

export const provider = registerPluginBehavior(plugin, {
  usageLimits: { probe: probeCodexUsage },
  acp: {
    buildSpawn: (ctx) => ({
      command: process.execPath,
      args: [resolveAdapterAsset(codexAdapter)],
      env: {
        ELECTRON_RUN_AS_NODE: '1',
        CODEX_PATH: ctx.cli,
        ...codexAcpConfigEnv(ctx),
      },
    }),
    connect: (io, toClient) => {
      return connectStdioAcp(io, toClient);
    },
    enrich: enrichCodexUpdate,
    // enrich marks the end of every turn, including the ones Codex starts itself (`/goal`).
    reportsAgentTurnEnd: true,
    isSessionNotFound: isCodexSessionNotFound,
  },
  auth: {
    checkStatus: async (ctx) => {
      const envStatus = authenticatedFromEnv(ctx, ['OPENAI_API_KEY']);
      if (envStatus.kind === 'authenticated') return envStatus;
      return commandAuthStatus(ctx, ['login', 'status'], {
        authenticatedPattern: /authenticated|logged in|signed in/i,
        unauthenticatedPattern: /not authenticated|not logged in|not signed in|login required/i,
      });
    },
  },
  prompt: {
    buildCommand: (ctx) =>
      buildStandardCommand(ctx, {
        autoApproveFlag:
          '-c approval_policy=never -c sandbox_mode=danger-full-access --dangerously-bypass-hook-trust',
        initialPromptFlag: '',
        resumeFlag: 'resume',
        sessionIdFlag: ' ',
        sessionIdOnResumeOnly: true,
        resumeWithoutSessionFlag: 'resume --last',
        deduplicateFlags: ['--dangerously-bypass-approvals-and-sandbox'],
        modelFlag: '-m',
      }),
  },
  hooks: buildCodexHookConfig(),
  mcp: codexMcpAdapter(),
});
