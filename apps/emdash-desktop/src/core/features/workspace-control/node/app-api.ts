import { encodeTopic } from '@emdash/wire/rpc';
import { z } from 'zod';

/**
 * Everything the app's UI can do, offered to agents: the procedures, live-model mutations and
 * live states of the desktop wire contracts, by dotted path (e.g. `appSettings.update`,
 * `tasks.tasks.restore`). Built from the contracts, so it grows with the app.
 */

export type AppApiEntry =
  | { kind: 'procedure'; path: string; input: z.ZodTypeAny }
  | { kind: 'mutation'; path: string; key: z.ZodTypeAny; input: z.ZodTypeAny }
  | { kind: 'state'; path: string; key: z.ZodTypeAny; topicId: string };

type Node = Record<string, unknown>;

function isRecord(value: unknown): value is Node {
  return typeof value === 'object' && value !== null;
}

/** Walks contract definitions into callable entries, sorted by path. */
export function appApiCatalog(contracts: Record<string, unknown>): AppApiEntry[] {
  const entries: AppApiEntry[] = [];
  const walk = (node: Node, prefix: string[]) => {
    for (const [name, def] of Object.entries(node)) {
      if (!isRecord(def)) continue;
      const path = [...prefix, name];
      switch (def.kind) {
        case 'procedure':
          entries.push({
            kind: 'procedure',
            path: path.join('.'),
            input: def.input as z.ZodTypeAny,
          });
          break;
        case 'liveModel': {
          const key = def.keySchema as z.ZodTypeAny;
          for (const [mutation, mutationDef] of Object.entries(def.mutations as Node)) {
            entries.push({
              kind: 'mutation',
              path: [...path, mutation].join('.'),
              key,
              input: (mutationDef as { input: z.ZodTypeAny }).input,
            });
          }
          for (const [state, stateDef] of Object.entries(def.states as Node)) {
            entries.push({
              kind: 'state',
              path: [...path, state].join('.'),
              key,
              topicId: (stateDef as { id: string }).id,
            });
          }
          break;
        }
        case 'liveState':
          entries.push({
            kind: 'state',
            path: path.join('.'),
            key: def.keySchema as z.ZodTypeAny,
            topicId: def.id as string,
          });
          break;
        case undefined:
          walk(def, path);
          break;
        // Logs, event streams, jobs and file transfers need a live subscription; not offered.
        default:
          break;
      }
    }
  };
  walk(contracts, []);
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

/** JSON Schema of a zod schema; types zod can't express (custom app types) become `{}`. */
export function jsonSchemaOf(schema: z.ZodTypeAny): unknown {
  try {
    const json = z.toJSONSchema(schema, { unrepresentable: 'any', io: 'input' }) as Node;
    delete json.$schema;
    return json;
  } catch {
    return {};
  }
}

/** How agents reach the app's wire: the same calls and snapshots the UI makes. */
export type AppWire = {
  call(path: string, input: unknown): Promise<unknown>;
  snapshot(topic: string): Promise<{ data: unknown }>;
};

export class AppApi {
  private readonly byPath: Map<string, AppApiEntry>;

  constructor(
    private readonly entries: readonly AppApiEntry[],
    private readonly wire: AppWire
  ) {
    this.byPath = new Map(entries.map((entry) => [entry.path, entry]));
  }

  /** Paths and kinds, optionally only those containing `filter` (case-insensitive). */
  list(filter?: string): { path: string; kind: AppApiEntry['kind'] }[] {
    const needle = filter?.trim().toLowerCase();
    return this.entries
      .filter((entry) => !needle || entry.path.toLowerCase().includes(needle))
      .map(({ path, kind }) => ({ path, kind }));
  }

  describe(path: string) {
    const entry = this.require(path);
    switch (entry.kind) {
      case 'procedure':
        return { path, kind: entry.kind, input: jsonSchemaOf(entry.input) };
      case 'mutation':
        return {
          path,
          kind: entry.kind,
          key: jsonSchemaOf(entry.key),
          input: jsonSchemaOf(entry.input),
        };
      case 'state':
        return { path, kind: entry.kind, key: jsonSchemaOf(entry.key) };
    }
  }

  /** Calls a procedure, or a mutation with its live model's `key`. */
  async call(path: string, input: unknown, key?: unknown): Promise<unknown> {
    const entry = this.require(path);
    if (entry.kind === 'procedure') return this.wire.call(path, input);
    if (entry.kind === 'mutation') {
      return this.wire.call(path, {
        key: entry.key.parse(key),
        input,
        mutationId: crypto.randomUUID(),
      });
    }
    throw new Error(`'${path}' is a live state; read it with app_api_read.`);
  }

  /** The current value of a live state for `key`. */
  async read(path: string, key?: unknown): Promise<unknown> {
    const entry = this.require(path);
    if (entry.kind !== 'state') throw new Error(`'${path}' is not a live state.`);
    return (await this.wire.snapshot(encodeTopic(entry.topicId, entry.key.parse(key)))).data;
  }

  private require(path: string): AppApiEntry {
    const entry = this.byPath.get(path);
    if (!entry) throw new Error(`Unknown app API path '${path}'. List paths with app_api_list.`);
    return entry;
  }
}
