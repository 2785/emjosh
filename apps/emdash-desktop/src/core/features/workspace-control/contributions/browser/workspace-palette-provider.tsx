import { Command } from 'cmdk';
import { GitBranch, Sparkles } from 'lucide-react';
import { openModal } from '@core/manifests/browser/modal-api';
import { IS_PERSONAL } from '@core/primitives/app-identity/api/app-identity';
import type {
  PaletteProviderDef,
  PaletteProviderMatch,
  PaletteProviderRenderProps,
} from '@core/primitives/palette/api';
import { getWorkspaceControlClient } from '../../api/browser/client';
import { openWorkspaceLink } from '../../api/browser/open-workspace';
import { isFreeTextQuery, type WorkspaceSearchHit } from '../../api/workspace-search';

const ITEM_CLASS =
  'flex cursor-pointer items-center gap-2.5 text-foreground-muted aria-selected:text-foreground rounded-md px-2 py-2 text-sm aria-selected:bg-background-2';

/** Instant metadata hits shown inline, so the palette stays fast; the rest is for the agent. */
const INLINE_HITS = 6;
const ASK_ID = 'ask';

type WorkspaceMatch = PaletteProviderMatch & {
  readonly workspace?: WorkspaceSearchHit['workspace'];
  readonly ask?: string;
};

async function confirmUnarchive(name: string): Promise<boolean> {
  const outcome = await openModal('confirmActionModal', {
    title: 'Unarchive workspace',
    description: `"${name}" is archived. Unarchive it and open it?`,
    confirmLabel: 'Unarchive and open',
  });
  return outcome.success;
}

function WorkspacePaletteRow({
  match,
  value,
  onSelect,
}: PaletteProviderRenderProps<WorkspaceMatch>) {
  if (match.ask !== undefined) {
    const query = match.ask;
    return (
      <Command.Item
        value={value}
        className={ITEM_CLASS}
        onSelect={() => {
          onSelect();
          void openModal('findWorkspaceModal', { query, ask: true });
        }}
      >
        <Sparkles size={14} className="shrink-0 text-foreground/40" />
        <span className="min-w-0 flex-1 truncate">{match.title}</span>
        <span className="text-xs text-foreground/40">Enter</span>
      </Command.Item>
    );
  }
  const workspace = match.workspace;
  return (
    <Command.Item
      value={value}
      className={ITEM_CLASS}
      onSelect={() => {
        onSelect();
        if (workspace) void openWorkspaceLink(workspace.id, confirmUnarchive);
      }}
    >
      <GitBranch size={14} className="shrink-0 text-foreground/40" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate">
          {match.title}
          {workspace?.archived && <span className="ml-2 text-xs text-foreground/40">archived</span>}
        </span>
        {match.subtitle && (
          <span className="truncate text-xs text-foreground/40">{match.subtitle}</span>
        )}
      </span>
    </Command.Item>
  );
}

/**
 * Free text in the command palette: an "Ask an agent to find …" item (first for text that reads
 * like a description, a PR/MR or a ticket; otherwise last, so it never takes Enter from a command
 * being typed), plus instant workspace matches the other providers don't already show (PR, branch,
 * id, ticket, archived).
 */
export const workspacePaletteProviderDef: PaletteProviderDef<'workspaces', WorkspaceMatch> = {
  kind: 'workspaces',
  keyword: '@workspaces',
  minQueryLength: 2,
  search: async ({ query, context }) => {
    if (!IS_PERSONAL) return [];
    const ask: WorkspaceMatch = {
      id: ASK_ID,
      title: `Ask an agent to find “${query}”`,
      section: 'Find',
      ask: query,
      relevance: isFreeTextQuery(query)
        ? { band: 'exact', score: Number.MAX_SAFE_INTEGER }
        : { band: 'secondary', score: 0 },
    };
    const matches = await getWorkspaceControlClient()
      .then((client) => client.searchWorkspaces({ query }))
      .then((result) =>
        result.hits
          // A name-only match of an active workspace is already in the task results.
          .filter(
            (hit) => hit.workspace.archived || hit.reasons.some((reason) => reason !== 'name')
          )
          .slice(0, INLINE_HITS)
          .map(
            (hit, index): WorkspaceMatch => ({
              id: hit.workspace.id,
              title: hit.workspace.name,
              subtitle: [hit.workspace.projectName, `matched ${hit.reasons.join(', ')}`].join(
                ' · '
              ),
              section: 'Workspaces',
              workspace: hit.workspace,
              relevance: {
                band: hit.score >= 90 ? 'exact' : hit.score >= 60 ? 'prefix' : 'substring',
                score: hit.score - index * 0.001,
                contextAffinity: hit.workspace.id === context.taskId ? 1 : 0,
              },
            })
          )
      )
      .catch(() => []);
    return [ask, ...matches];
  },
  render: WorkspacePaletteRow,
};

export const workspacePaletteProviderDefs = [workspacePaletteProviderDef] as const;
