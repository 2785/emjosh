import { z } from 'zod';
import { defineSettingsContribution } from '@core/primitives/settings/api';

export const preferredConversationTypeSettingsContribution = defineSettingsContribution({
  key: 'preferredConversationType',
  schema: z.enum(['acp', 'pty']),
  defaults: 'pty' as const,
});

/**
 * What sending a chat message does while the agent is mid-turn:
 * - `queue`: run it after the current turn finishes.
 * - `interrupt` (shown as "Steer"): hand it (merged with any queued messages) to the running
 *   agent mid-turn; agents that can't take messages mid-turn cancel and run it next.
 */
export const followUpModeSettingsContribution = defineSettingsContribution({
  key: 'followUpMode',
  schema: z.enum(['queue', 'interrupt']),
  defaults: 'interrupt' as const,
});

/**
 * Whether chat conversations whose agent was mid-turn when the app quit, restarted, or crashed
 * get an automatic "keep going" message once the app is back.
 */
export const resumeInterruptedTurnsSettingsContribution = defineSettingsContribution({
  key: 'resumeInterruptedTurns',
  schema: z.boolean(),
  defaults: true,
});
