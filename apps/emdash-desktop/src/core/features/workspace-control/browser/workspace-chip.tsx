import { AgentStatus, type AgentStatusKind } from '@emdash/ui/react/components';
import { Badge, Button } from '@emdash/ui/react/primitives';
import { GitBranch } from 'lucide-react';
import { useState } from 'react';
import { cn } from '@core/primitives/styling/browser/cn';
import type { WorkspaceRef } from '../api/workspace-search';

const AGENT_STATUSES = new Set<string>([
  'working',
  'background',
  'awaiting-input',
  'error',
  'completed',
]);

/**
 * A workspace as a clickable row: name, project, initiative, branch, PR, status. An archived
 * workspace asks before it is unarchived and opened.
 */
export function WorkspaceChip({
  workspace,
  note,
  selected,
  onOpen,
}: {
  workspace: WorkspaceRef;
  /** Why it is listed (what matched, or the agent's reason). */
  note?: string | null;
  selected?: boolean;
  onOpen: (workspace: WorkspaceRef) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const pr = workspace.pullRequest;
  const details = [
    workspace.projectName,
    workspace.initiativeName && `initiative ${workspace.initiativeName}`,
  ].filter(Boolean);

  return (
    <div
      className={cn(
        'flex flex-col gap-1 rounded-md border border-border px-3 py-2 text-sm',
        selected && 'bg-background-2',
        workspace.archived && 'opacity-80'
      )}
      data-workspace-id={workspace.id}
    >
      <button
        type="button"
        className="flex w-full min-w-0 items-center gap-2 text-left"
        onClick={() => (workspace.archived ? setConfirming(true) : onOpen(workspace))}
      >
        <GitBranch size={14} className="shrink-0 text-foreground/40" />
        <span className="min-w-0 flex-1 truncate font-medium">{workspace.name}</span>
        {workspace.agentStatus && AGENT_STATUSES.has(workspace.agentStatus) && (
          <AgentStatus status={workspace.agentStatus as AgentStatusKind} />
        )}
        {pr && (
          <Badge variant="outline" tone={pr.state === 'merged' ? 'info' : 'neutral'}>
            {pr.number ? `${/merge_requests/.test(pr.url) ? '!' : '#'}${pr.number}` : 'PR'}{' '}
            {pr.state}
          </Badge>
        )}
        {workspace.markedDone && <Badge tone="success">done</Badge>}
        {workspace.archived && <Badge tone="warning">archived</Badge>}
      </button>
      <div className="flex min-w-0 items-center gap-2 pl-6 text-xs text-foreground-muted">
        <span className="truncate">{details.join(' · ')}</span>
        {workspace.branch && (
          <span className="truncate font-mono text-foreground-passive">{workspace.branch}</span>
        )}
      </div>
      {note && <p className="pl-6 text-xs text-foreground-passive">{note}</p>}
      {confirming && (
        <div className="flex items-center justify-end gap-2 pl-6 text-xs">
          <span className="mr-auto text-foreground-muted">This workspace is archived.</span>
          <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
            Cancel
          </Button>
          <Button size="sm" onClick={() => onOpen(workspace)}>
            Unarchive and open
          </Button>
        </div>
      )}
    </div>
  );
}
