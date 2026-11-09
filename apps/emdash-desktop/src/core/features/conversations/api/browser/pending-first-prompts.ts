/**
 * First prompts with images for chat conversations that don't exist yet. Images can only be
 * uploaded to an existing conversation, so the new-task dialog leaves the prompt here, keyed by
 * the conversation id it creates, and the conversation's chat sends it once connected.
 */

export type PendingFirstPromptImage = {
  name: string;
  mimeType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
  data: Uint8Array;
};

export type PendingFirstPrompt = {
  text: string;
  hiddenContext?: string;
  images: PendingFirstPromptImage[];
};

const pending = new Map<string, PendingFirstPrompt>();

export function setPendingFirstPrompt(conversationId: string, prompt: PendingFirstPrompt): void {
  pending.set(conversationId, prompt);
}

/** Returns the conversation's pending first prompt, at most once. */
export function takePendingFirstPrompt(conversationId: string): PendingFirstPrompt | undefined {
  const prompt = pending.get(conversationId);
  pending.delete(conversationId);
  return prompt;
}
