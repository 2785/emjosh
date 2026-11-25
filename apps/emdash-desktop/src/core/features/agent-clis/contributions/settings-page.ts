import type { SettingsPageTab } from '@core/features/settings/contributions/views';
import {
  defineSettingsPageContribution,
  type SettingsPageContribution,
} from '@core/primitives/settings/api/page-contribution';
import { AgentClisSettingsPage } from '../browser/agent-clis-page';

export const agentClisSettingsPage = defineSettingsPageContribution({
  id: 'agent-clis',
  label: 'Agent CLIs',
  icon: 'rotate-cw',
  component: AgentClisSettingsPage,
} satisfies SettingsPageContribution<SettingsPageTab>);
