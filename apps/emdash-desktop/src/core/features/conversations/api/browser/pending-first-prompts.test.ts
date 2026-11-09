import { describe, expect, it } from 'vitest';
import { setPendingFirstPrompt, takePendingFirstPrompt } from './pending-first-prompts';

describe('pending first prompts', () => {
  it('hands the prompt to its conversation once', () => {
    const prompt = {
      text: 'Look at this',
      images: [{ name: 'Image 1', mimeType: 'image/png' as const, data: new Uint8Array([1]) }],
    };
    setPendingFirstPrompt('conv-1', prompt);

    expect(takePendingFirstPrompt('conv-2')).toBeUndefined();
    expect(takePendingFirstPrompt('conv-1')).toBe(prompt);
    expect(takePendingFirstPrompt('conv-1')).toBeUndefined();
  });
});
