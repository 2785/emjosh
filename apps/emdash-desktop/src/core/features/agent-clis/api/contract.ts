import { defineContract, procedure } from '@emdash/wire/rpc';
import { z } from 'zod';
import { agentCliIdSchema, agentCliInfoSchema, agentCliUpdateResultSchema } from './schemas';

export const agentClisDomain = 'agentClis' as const;

export const agentClisContract = defineContract({
  /** Installed agent CLIs with cached latest versions; spawns one `--version` per CLI. */
  list: procedure({ input: z.void().optional(), output: z.array(agentCliInfoSchema) }),
  /** Looks up latest versions (npm registry), then lists. A failed lookup leaves versions unknown. */
  refreshLatest: procedure({ input: z.void().optional(), output: z.array(agentCliInfoSchema) }),
  update: procedure({
    input: z.object({ id: agentCliIdSchema }),
    output: agentCliUpdateResultSchema,
  }),
  setAutoUpdate: procedure({
    input: z.object({ id: agentCliIdSchema, enabled: z.boolean() }),
    output: z.object({ ok: z.boolean(), error: z.string().nullable() }),
  }),
});
