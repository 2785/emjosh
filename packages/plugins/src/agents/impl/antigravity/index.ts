import {
  definePlugin,
  registerPluginBehavior,
} from '@emdash/core/services/agent-plugins/api/plugins';
import { buildStandardCommand } from '@emdash/core/services/agent-plugins/api/plugins/helpers';
import { createNativeAcpBehavior } from '../../helpers/acp-stdio';
import { connectAntigravityAcp, isAntigravitySessionNotFound } from './acp';
import { enrichAntigravityUpdate } from './acp-enrich';
import { antigravityAuthStatus } from './auth';
import { buildAntigravityHookConfig } from './hooks';
import { icon } from './icon';

export const plugin = definePlugin(
  {
    id: 'antigravity',
    name: 'Antigravity',
    description:
      'Google Antigravity CLI (agy) with Gemini and Claude models, shared Antigravity settings, and conversation history.',
    websiteUrl: 'https://antigravity.google/docs/cli-overview',
  },
  {
    acp: {
      kind: 'supported',
    },
    auth: {
      kind: 'supported',
      methods: [
        {
          kind: 'cli-login',
          id: 'antigravity-login',
          name: 'Sign in with Google',
          args: ['acp', '--login'],
          description: 'Open the Antigravity CLI Google sign-in flow in a terminal.',
        },
        {
          kind: 'api-key',
          id: 'gemini-api-key',
          name: 'Use a Gemini API key',
          envVars: [{ name: 'GEMINI_API_KEY', label: 'Gemini API key' }],
          helpUrl: 'https://aistudio.google.com/apikey',
        },
      ],
    },
    autoApprove: {
      kind: 'supported',
    },
    hooks: {
      kind: 'config',
      scope: 'global',
      supportedEvents: ['session', 'start', 'stop'],
    },
    models: {
      kind: 'selectable',
      modelOptions: {
        'gemini-4-carbon': {
          name: 'Gemini 4 Carbon',
          modelFeatures: { intelligence: 4, speed: 3 },
        },
        'gemini-4-neon': {
          name: 'Gemini 4 Neon',
          modelFeatures: { intelligence: 5, speed: 2 },
        },
        'gemini-4-hydrogen': {
          name: 'Gemini 4 Hydrogen',
          modelFeatures: { intelligence: 5, speed: 2 },
        },
        'gemini-4-argon': {
          name: 'Gemini 4 Argon',
          modelFeatures: { intelligence: 3, speed: 4 },
        },
        'gemini-3.8-flash': {
          name: 'Gemini 3.8 Flash',
          modelFeatures: { intelligence: 3, speed: 5 },
        },
        'gemini-3.1-pro': {
          name: 'Gemini 3.1 Pro',
          modelFeatures: { intelligence: 4, speed: 3 },
        },
        'claude-opus-5-5': {
          name: 'Claude Opus 5.5',
          modelFeatures: { intelligence: 5, speed: 2 },
        },
        'claude-sonnet-5-5': {
          name: 'Claude Sonnet 5.5',
          modelFeatures: { intelligence: 4, speed: 4 },
        },
      },
    },
    hostDependency: {
      id: 'antigravity',
      binaryNames: ['agy', 'antigravity'],
      installCommands: {
        macos: [
          {
            method: 'curl',
            command: 'curl -fsSL https://antigravity.google/cli/install.sh | bash',
          },
        ],
        linux: [
          {
            method: 'curl',
            command: 'curl -fsSL https://antigravity.google/cli/install.sh | bash',
          },
        ],
      },
      updates: {
        kind: 'supported',
        releaseSource: {
          kind: 'none',
        },
        update: {
          kind: 'package-manager',
        },
      },
    },
    prompt: {
      kind: 'argv',
      flag: '-i',
    },
    sessions: {
      kind: 'resumable',
    },
  },
  { icon }
);

export const provider = registerPluginBehavior(plugin, {
  acp: {
    ...createNativeAcpBehavior(() => ({ args: ['acp'] })),
    connect: connectAntigravityAcp,
    enrich: enrichAntigravityUpdate,
    reportsAgentTurnEnd: true,
    isSessionNotFound: isAntigravitySessionNotFound,
  },
  auth: {
    checkStatus: antigravityAuthStatus,
  },
  hooks: buildAntigravityHookConfig(),
  prompt: {
    buildCommand: (ctx) =>
      buildStandardCommand(ctx, {
        autoApproveFlag: '--dangerously-skip-permissions',
        initialPromptFlag: '-i',
        // --conversation resumes an existing native agy session by id; passing an
        // unknown id makes agy warn and mint a fresh session, so only pass the
        // hook-captured native id on resume and fall back to -c (most recent).
        resumeFlag: '--conversation=',
        sessionIdFlag: '--conversation=',
        sessionIdOnResumeOnly: true,
        resumeWithoutSessionFlag: '-c',
        modelFlag: '--model',
      }),
  },
});
