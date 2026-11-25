import { useCallback, useEffect, useState } from 'react';
import { getAgentClisClient } from '../api/browser/client';
import type { AgentCliInfo } from '../api/schemas';
import { AgentClisView } from './agent-clis-view';

const UPDATE_TIMEOUT_MS = 6 * 60_000;

export function AgentClisSettingsPage() {
  const [clis, setClis] = useState<AgentCliInfo[]>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [toggleErrors, setToggleErrors] = useState<Record<string, string>>({});

  const load = useCallback(async (lookUpLatest: boolean) => {
    setLoading(true);
    setError(undefined);
    try {
      const client = await getAgentClisClient();
      setClis(await client.list());
      // A failed latest-version lookup only leaves "update available" unknown.
      if (lookUpLatest) setClis(await client.refreshLatest(undefined, { timeoutMs: 30_000 }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(true);
  }, [load]);

  const patch = (id: AgentCliInfo['id'], change: Partial<AgentCliInfo>) =>
    setClis((current) => current?.map((cli) => (cli.id === id ? { ...cli, ...change } : cli)));

  return (
    <AgentClisView
      clis={clis}
      loading={loading}
      error={error}
      toggleErrors={toggleErrors}
      onRefresh={() => void load(true)}
      onUpdate={(id) => {
        patch(id, { updating: true });
        void (async () => {
          try {
            const client = await getAgentClisClient();
            await client.update({ id }, { timeoutMs: UPDATE_TIMEOUT_MS });
          } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
          }
          await load(false);
        })();
      }}
      onToggleAutoUpdate={(id, enabled) => {
        void (async () => {
          try {
            const client = await getAgentClisClient();
            const result = await client.setAutoUpdate({ id, enabled });
            setToggleErrors((errors) => {
              const { [id]: _drop, ...rest } = errors;
              return result.ok || !result.error ? rest : { ...rest, [id]: result.error };
            });
          } catch (e) {
            setToggleErrors((errors) => ({
              ...errors,
              [id]: e instanceof Error ? e.message : String(e),
            }));
          }
          await load(false);
        })();
      }}
    />
  );
}
