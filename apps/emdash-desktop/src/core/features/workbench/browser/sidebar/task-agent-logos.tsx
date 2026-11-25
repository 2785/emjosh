import { Tooltip } from '@emdash/ui/react/primitives';
import { observer } from 'mobx-react-lite';
import { useAgentMetadata } from '@core/features/agents/api/browser/use-agent-metadata';
import { AgentIcon } from '@core/features/agents/contributions/browser/agent-icon';
import { taskConversationStats } from '@core/features/conversations/api/browser/conversation-selectors';
import { useAppSettingsKey } from '@core/features/settings/api/browser/use-app-settings-key';
import { type TaskStore } from '@core/features/tasks/api/browser/stores/task-store';
import { MAX_SIDEBAR_AGENT_LOGOS, nonDefaultAgentIds } from './task-agent-logo-ids';

/** Leading logos for agents other than the configured default; nothing for default-only tasks. */
export const SidebarTaskAgentLogos = observer(function SidebarTaskAgentLogos({
  task,
}: {
  task: TaskStore;
}) {
  const { value: defaultAgentId } = useAppSettingsKey('defaultAgent');
  const ids = nonDefaultAgentIds(taskConversationStats(task), defaultAgentId);
  return <AgentLogoStrip providerIds={ids} />;
});

export function AgentLogoStrip({ providerIds }: { providerIds: string[] }) {
  const { data: agents } = useAgentMetadata();
  if (providerIds.length === 0) return null;

  const names = providerIds.map((id) => agents?.find((a) => a.id === id)?.name ?? id);
  const label = names.join(', ');

  return (
    <Tooltip.Root>
      <Tooltip.Trigger
        render={
          <span
            aria-label={label}
            data-testid="sidebar-agent-logos"
            className="flex shrink-0 items-center gap-0.5 opacity-60 grayscale transition group-hover/row:opacity-100 group-hover/row:grayscale-0 group-data-[active]/row:opacity-100 group-data-[active]/row:grayscale-0"
          />
        }
      >
        {providerIds.slice(0, MAX_SIDEBAR_AGENT_LOGOS).map((id) => (
          <AgentIcon key={id} id={id} size={12} />
        ))}
      </Tooltip.Trigger>
      <Tooltip.Content>{label}</Tooltip.Content>
    </Tooltip.Root>
  );
}
