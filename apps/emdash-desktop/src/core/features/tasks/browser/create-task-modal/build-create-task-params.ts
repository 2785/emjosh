import type { PullRequest } from '@emdash/plugins/pull-requests/schemas';
import { nextDefaultConversationTitle } from '@core/features/conversations/api/browser/conversation-title-utils';
import type {
  PendingFirstPrompt,
  PendingFirstPromptImage,
} from '@core/features/conversations/api/browser/pending-first-prompts';
import type { InitialConversationState } from '@core/features/tasks/contributions/browser/task-config/initial-conversation-section';
import { extractIssueMentionTargets } from '@core/primitives/issues/api';
import type { TaskConfig } from '@core/primitives/tasks/api';
import type { TaskLifecycleStatus } from '@core/primitives/tasks/api';
import { buildFinalPrompt } from './initial-conversation-text';
import type { LinkedType } from './use-create-task-state';

function buildInitialQueue(state: InitialConversationState) {
  const text = state.prompt.trim();
  if (!text) return undefined;

  const hiddenContextParts: string[] = [];
  if (state.issueContext?.trim()) {
    hiddenContextParts.push(state.issueContext.trim());
  }

  const targets = extractIssueMentionTargets(state.prompt);
  for (const target of targets) {
    const context = state.issueMentionContexts[target.token];
    if (context?.trim()) hiddenContextParts.push(context.trim());
  }

  const hiddenContext = hiddenContextParts.join('\n\n').trim();
  return [
    {
      text: state.prompt,
      ...(hiddenContext && { hiddenContext }),
    },
  ];
}

const IMAGE_MIME_TYPES: readonly PendingFirstPromptImage['mimeType'][] = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
];

function dataUrlBytes(dataUrl: string): Uint8Array | null {
  const comma = dataUrl.indexOf(',');
  if (!dataUrl.startsWith('data:') || comma < 0) return null;
  const binary = atob(dataUrl.slice(comma + 1));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function promptImages(state: InitialConversationState): PendingFirstPromptImage[] {
  return state.images.flatMap((image, index) => {
    const mimeType = IMAGE_MIME_TYPES.find((type) => type === image.mimeType);
    const data = image.previewUrl ? dataUrlBytes(image.previewUrl) : null;
    return mimeType && data ? [{ name: `Image ${index + 1}`, mimeType, data }] : [];
  });
}

/**
 * A chat first message with images, which only an existing conversation can take, so it is sent
 * by the conversation once created (see pending-first-prompts) instead of the initial queue.
 */
export function buildPendingFirstPrompt(
  state: InitialConversationState
): PendingFirstPrompt | null {
  if (!state.useChatUi) return null;
  const images = promptImages(state);
  if (images.length === 0) return null;
  const queued = buildInitialQueue(state)?.[0];
  return {
    text: queued?.text ?? '',
    ...(queued?.hiddenContext && { hiddenContext: queued.hiddenContext }),
    images,
  };
}

export function buildInitialConversation(
  state: InitialConversationState
): NonNullable<TaskConfig['initialConversation']> | undefined {
  const { provider } = state;
  if (!provider) return undefined;
  const type = state.useChatUi ? 'acp' : 'pty';

  return {
    id: crypto.randomUUID(),
    provider,
    title: nextDefaultConversationTitle(provider, []),
    ...(type === 'acp'
      ? { initialQueue: buildPendingFirstPrompt(state) ? undefined : buildInitialQueue(state) }
      : state.initialPromptSupported
        ? { initialPrompt: buildFinalPrompt(state.issueContext, state.prompt) }
        : {}),
    autoApprove: state.autoApprove,
    ...(type === 'acp' ? { options: state.options } : { model: state.model ?? undefined }),
    type,
  };
}

export function deriveInitialStatus(
  linkedType: LinkedType,
  linkedPR: PullRequest | null
): TaskLifecycleStatus | undefined {
  if (linkedType !== 'pr' || !linkedPR) return undefined;
  return linkedPR.status === 'open' && !linkedPR.isDraft ? 'review' : undefined;
}
