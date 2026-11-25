import { PageLayout } from '@emdash/ui/react/patterns';
import { Badge, Button, Spinner, Switch } from '@emdash/ui/react/primitives';
import type { AgentCliInfo } from '../api/schemas';

export type AgentClisViewProps = {
  clis: AgentCliInfo[] | undefined;
  loading: boolean;
  error?: string;
  /** Errors from toggling auto-update, by CLI id. */
  toggleErrors: Record<string, string>;
  onUpdate(id: AgentCliInfo['id']): void;
  onToggleAutoUpdate(id: AgentCliInfo['id'], enabled: boolean): void;
  onRefresh(): void;
};

function autoUpdateOwnerText(cli: AgentCliInfo): string {
  return cli.autoUpdate.owner === 'cli'
    ? `Managed by ${cli.name} itself (its own config file).`
    : 'Managed by Emjosh: checks daily and updates when no chat of this CLI is mid-turn.';
}

function AgentCliCard({
  cli,
  toggleError,
  onUpdate,
  onToggleAutoUpdate,
}: {
  cli: AgentCliInfo;
  toggleError?: string;
  onUpdate: AgentClisViewProps['onUpdate'];
  onToggleAutoUpdate: AgentClisViewProps['onToggleAutoUpdate'];
}) {
  const result = cli.lastUpdate;
  return (
    <section className="space-y-3 rounded-lg border p-4" aria-label={cli.name}>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-medium">{cli.name}</h3>
            {cli.installed && <span className="text-sm">{cli.version ?? 'version unknown'}</span>}
            {cli.updateAvailable && (
              <Badge tone="warning">Update available: {cli.latestVersion}</Badge>
            )}
            {cli.installMethod && cli.installed && (
              <Badge tone="neutral">{cli.installMethod}</Badge>
            )}
          </div>
          <p className="truncate text-xs text-foreground-muted">
            {cli.installed ? cli.path : 'Not installed'}
          </p>
        </div>
        {cli.installed && (
          <Button
            variant="secondary"
            size="sm"
            disabled={cli.updating || cli.updateBlockedReason !== null}
            onClick={() => onUpdate(cli.id)}
          >
            {cli.updating ? <Spinner size="sm" /> : null}
            {cli.updating ? 'Updating…' : 'Update'}
          </Button>
        )}
      </div>

      {cli.installed && cli.updateBlockedReason && (
        <p role="alert" className="text-xs text-foreground-destructive">
          {cli.updateBlockedReason}
        </p>
      )}
      {cli.installed && cli.updateCommand && (
        <p className="font-mono text-xs text-foreground-muted">{cli.updateCommand.join(' ')}</p>
      )}

      {cli.installed && (
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0 space-y-0.5">
            <p className="text-sm">Auto-update</p>
            <p className="text-xs text-foreground-muted">{autoUpdateOwnerText(cli)}</p>
            {cli.autoUpdate.detail && (
              <p className="text-xs text-foreground-muted">{cli.autoUpdate.detail}</p>
            )}
            {toggleError && (
              <p role="alert" className="text-xs text-foreground-destructive">
                {toggleError}
              </p>
            )}
          </div>
          <Switch
            aria-label={`Auto-update ${cli.name}`}
            checked={cli.autoUpdate.enabled}
            onCheckedChange={(checked) => onToggleAutoUpdate(cli.id, checked)}
          />
        </div>
      )}

      {result && (
        <div className="space-y-1 text-xs">
          <p className={result.error ? 'text-foreground-destructive' : 'text-foreground-muted'}>
            {result.trigger === 'auto' ? 'Automatic update' : 'Last update'}
            {': '}
            {result.error
              ? 'failed'
              : result.before === result.after
                ? `no change (${result.after ?? 'unknown'})`
                : `${result.before ?? 'unknown'} → ${result.after ?? 'unknown'}`}
            {' · '}
            {new Date(result.at).toLocaleString()}
          </p>
          {result.error && (
            <p role="alert" className="text-foreground-destructive">
              {result.error}
            </p>
          )}
          {result.output && (
            <details>
              <summary className="cursor-pointer text-foreground-muted">Command output</summary>
              <pre className="mt-1 max-h-48 overflow-auto rounded bg-background-secondary p-2 font-mono whitespace-pre-wrap">
                {result.output}
              </pre>
            </details>
          )}
        </div>
      )}
    </section>
  );
}

export function AgentClisView({
  clis,
  loading,
  error,
  toggleErrors,
  onUpdate,
  onToggleAutoUpdate,
  onRefresh,
}: AgentClisViewProps) {
  return (
    <div className="space-y-6 pb-4">
      <PageLayout.Header
        sticky
        title="Agent CLIs"
        description="Update the agent CLIs installed on this machine. Running chats keep the old version until they are restarted."
      />
      {error && (
        <p role="alert" className="text-sm text-foreground-destructive">
          {error}
        </p>
      )}
      {loading && !clis && <Spinner />}
      {clis?.map((cli) => (
        <AgentCliCard
          key={cli.id}
          cli={cli}
          toggleError={toggleErrors[cli.id]}
          onUpdate={onUpdate}
          onToggleAutoUpdate={onToggleAutoUpdate}
        />
      ))}
      <Button variant="text" onClick={onRefresh} disabled={loading} aria-label="Check for updates">
        {loading ? 'Checking…' : 'Check for updates'}
      </Button>
    </div>
  );
}
