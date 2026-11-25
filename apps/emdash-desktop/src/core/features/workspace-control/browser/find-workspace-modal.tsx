import { Button, Dialog, SearchInput, Spinner, toast } from '@emdash/ui/react/primitives';
import { Sparkles } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { openWorkspace } from '@core/features/workspace-control/api/browser/open-workspace';
import { useModalController } from '@core/manifests/browser/modal-api';
import { defineModal } from '@core/primitives/modals/react';
import { getWorkspaceControlClient } from '../api/browser/client';
import type {
  WorkspaceAskResult,
  WorkspaceRef,
  WorkspaceSearchResult,
} from '../api/workspace-search';
import { WorkspaceChip } from './workspace-chip';

export type FindWorkspaceModalArgs = { query?: string };

const SEARCH_DELAY_MS = 150;

type AskState =
  | { kind: 'idle' }
  | { kind: 'asking'; query: string }
  | { kind: 'answered'; result: WorkspaceAskResult }
  | { kind: 'failed'; query: string; message: string };

/**
 * Finds a workspace from free text. Metadata matches show as you type; when they aren't
 * conclusive, Enter (or "Ask an agent") has a cheap read-only agent look through feeds and
 * chats.
 */
export function FindWorkspaceModal({ query: initialQuery = '' }: FindWorkspaceModalArgs) {
  const controller = useModalController('findWorkspaceModal');
  const [query, setQuery] = useState(initialQuery);
  const [result, setResult] = useState<WorkspaceSearchResult | null>(null);
  const [ask, setAsk] = useState<AskState>({ kind: 'idle' });
  const latest = useRef(query);
  latest.current = query;

  useEffect(() => {
    const text = query.trim();
    if (!text) {
      setResult(null);
      return;
    }
    const timer = setTimeout(() => {
      void getWorkspaceControlClient()
        .then((client) => client.searchWorkspaces({ query: text }))
        .then((found) => {
          if (latest.current.trim() === text) setResult(found);
        })
        .catch((error: unknown) => {
          if (latest.current.trim() === text) {
            setResult({ query: text, hits: [], conclusive: false });
            toast.error('Workspace search failed', { description: String(error) });
          }
        });
    }, SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [query]);

  const open = (workspace: WorkspaceRef) => {
    void openWorkspace(workspace)
      .then(() => controller.dismiss())
      .catch((error: unknown) =>
        toast.error('Could not open the workspace', { description: String(error) })
      );
  };

  const askAgent = () => {
    const text = query.trim();
    if (!text || ask.kind === 'asking') return;
    setAsk({ kind: 'asking', query: text });
    void getWorkspaceControlClient()
      .then((client) => client.askAboutWorkspaces({ query: text }))
      .then((answer) => setAsk({ kind: 'answered', result: answer }))
      .catch((error: unknown) =>
        setAsk({
          kind: 'failed',
          query: text,
          message: error instanceof Error ? error.message : String(error),
        })
      );
  };

  const hits = result?.query === query.trim() ? result.hits : (result?.hits ?? []);
  const top = hits[0];

  return (
    <>
      <Dialog.Header>
        <Dialog.Title>Find workspace</Dialog.Title>
      </Dialog.Header>
      <Dialog.Body className="flex flex-col gap-3 pt-0 text-sm">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (result?.conclusive && top && !top.workspace.archived) open(top.workspace);
            else askAgent();
          }}
        >
          <SearchInput
            autoFocus
            value={query}
            placeholder="PR/MR URL or number, branch, ticket, id, or what it was about"
            onChange={(event) => setQuery(event.target.value)}
            onClear={() => setQuery('')}
          />
        </form>

        {ask.kind !== 'idle' && (
          <div className="flex flex-col gap-2 rounded-md border border-border bg-background-1 p-3">
            <div className="flex items-center gap-2 text-xs text-foreground-muted">
              <Sparkles size={14} />
              <span>Agent</span>
              {ask.kind === 'asking' && <Spinner size="sm" />}
            </div>
            {ask.kind === 'asking' && (
              <p className="text-foreground-muted">Looking through workspaces, feeds and chats…</p>
            )}
            {ask.kind === 'failed' && <p className="text-foreground-error">{ask.message}</p>}
            {ask.kind === 'answered' && (
              <>
                <p className="whitespace-pre-wrap">{ask.result.answer}</p>
                {ask.result.workspaces.map((workspace) => (
                  <WorkspaceChip
                    key={workspace.id}
                    workspace={workspace}
                    note={workspace.why}
                    onOpen={open}
                  />
                ))}
              </>
            )}
          </div>
        )}

        <div className="flex max-h-96 flex-col gap-2 overflow-y-auto">
          {query.trim() && result && hits.length === 0 && (
            <p className="text-foreground-passive">No workspace matches by name, branch or PR.</p>
          )}
          {hits.map((hit, index) => (
            <WorkspaceChip
              key={hit.workspace.id}
              workspace={hit.workspace}
              note={`Matched ${hit.reasons.join(', ')}`}
              selected={index === 0 && result?.conclusive}
              onOpen={open}
            />
          ))}
        </div>

        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-foreground-passive">
            {result?.conclusive
              ? 'Enter opens the top match.'
              : query.trim()
                ? 'Enter asks an agent (a quick, read-only model run).'
                : ''}
          </span>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={controller.dismiss}>
              Close
            </Button>
            <Button
              variant="secondary"
              disabled={!query.trim() || ask.kind === 'asking'}
              onClick={askAgent}
            >
              <Sparkles size={14} />
              Ask an agent
            </Button>
          </div>
        </div>
      </Dialog.Body>
    </>
  );
}

export const findWorkspaceModal = defineModal<FindWorkspaceModalArgs>()({
  id: 'findWorkspaceModal',
  component: FindWorkspaceModal,
  size: 'lg',
});
