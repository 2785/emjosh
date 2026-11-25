import { Button, Dialog, SearchInput, Spinner, toast } from '@emdash/ui/react/primitives';
import { Sparkles } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { openWorkspace } from '@core/features/workspace-control/api/browser/open-workspace';
import { useModalController } from '@core/manifests/browser/modal-api';
import { defineModal } from '@core/primitives/modals/react';
import { getWorkspaceControlClient } from '../api/browser/client';
import type {
  WorkspaceAskStatus,
  WorkspaceRef,
  WorkspaceSearchResult,
} from '../api/workspace-search';
import { WorkspaceChip } from './workspace-chip';

export type FindWorkspaceModalArgs = {
  query?: string;
  /** Start the agent search at once (the command palette's "Ask an agent to find …"). */
  ask?: boolean;
};

const SEARCH_DELAY_MS = 150;

const POLL_MS = 300;

type AskState =
  | { kind: 'idle' }
  | { kind: 'running'; status: WorkspaceAskStatus | null }
  | { kind: 'finished'; status: WorkspaceAskStatus };

function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/**
 * Finds a workspace from free text. Metadata matches show as you type; when they aren't
 * conclusive, Enter (or "Ask an agent") has a cheap read-only agent look through feeds and
 * chats.
 */
export function FindWorkspaceModal({
  query: initialQuery = '',
  ask: askOnOpen = false,
}: FindWorkspaceModalArgs) {
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

  const [now, setNow] = useState(() => Date.now());
  const runId = useRef<string | null>(null);

  useEffect(() => {
    if (ask.kind !== 'running') return;
    const tick = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(tick);
  }, [ask.kind]);

  // Leaving the modal stops a run in progress.
  useEffect(
    () => () => {
      const id = runId.current;
      if (id)
        void getWorkspaceControlClient().then((client) => client.cancelWorkspaceAsk({ runId: id }));
    },
    []
  );

  const askAgent = (text = query.trim()) => {
    if (!text || ask.kind === 'running') return;
    setAsk({ kind: 'running', status: null });
    setNow(Date.now());
    void (async () => {
      try {
        const client = await getWorkspaceControlClient();
        const { runId: id } = await client.startWorkspaceAsk({ query: text });
        runId.current = id;
        for (;;) {
          const status = await client.workspaceAskStatus({ runId: id });
          if (runId.current !== id) return;
          if (status.state === 'running') {
            setAsk({ kind: 'running', status });
            await new Promise((resolve) => setTimeout(resolve, POLL_MS));
            continue;
          }
          runId.current = null;
          setAsk({ kind: 'finished', status });
          return;
        }
      } catch (error) {
        runId.current = null;
        setAsk({
          kind: 'finished',
          status: {
            runId: '',
            query: text,
            startedAt: Date.now(),
            state: 'failed',
            step: 'Failed',
            completed: [],
            error: error instanceof Error ? error.message : String(error),
          },
        });
      }
    })();
  };

  const cancelAsk = () => {
    const id = runId.current;
    runId.current = null;
    setAsk({ kind: 'idle' });
    if (id)
      void getWorkspaceControlClient().then((client) => client.cancelWorkspaceAsk({ runId: id }));
  };

  const askedOnOpen = useRef(false);
  useEffect(() => {
    if (askOnOpen && initialQuery.trim() && !askedOnOpen.current) {
      askedOnOpen.current = true;
      askAgent(initialQuery.trim());
    }
    // Only on open: the query typed afterwards must not restart the run.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
              {ask.kind === 'running' && <Spinner size="sm" />}
              {ask.kind === 'running' && ask.status && (
                <span className="ml-auto tabular-nums">
                  {formatElapsed(now - ask.status.startedAt)}
                </span>
              )}
              {ask.kind === 'running' && (
                <Button size="sm" variant="ghost" onClick={cancelAsk}>
                  Cancel
                </Button>
              )}
            </div>
            {ask.kind === 'running' && (
              <div className="flex flex-col gap-0.5 text-foreground-muted">
                {ask.status?.completed.map((step) => (
                  <span key={step} className="text-xs text-foreground-passive">
                    ✓ {step}
                  </span>
                ))}
                <span>{ask.status?.step ?? 'Starting…'}</span>
              </div>
            )}
            {ask.kind === 'finished' && ask.status.state === 'failed' && (
              <p className="text-foreground-error">{ask.status.error}</p>
            )}
            {ask.kind === 'finished' && ask.status.state === 'done' && ask.status.result && (
              <>
                <p className="whitespace-pre-wrap">{ask.status.result.answer}</p>
                {ask.status.result.workspaces.map((workspace) => (
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
              disabled={!query.trim() || ask.kind === 'running'}
              onClick={() => askAgent()}
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
