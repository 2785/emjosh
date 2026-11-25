import { defineSettingsContribution } from '@core/primitives/settings/api';
import { agentCliUpdateSettingsSchema } from '../api/schemas';

/** Emjosh-driven agent CLI updates: auto-update toggles and the last results. */
export const agentCliUpdatesSettingsContribution = defineSettingsContribution({
  key: 'agentCliUpdates',
  schema: agentCliUpdateSettingsSchema,
  defaults: { autoUpdate: {}, lastResults: {}, lastCheckedAt: {} },
});
