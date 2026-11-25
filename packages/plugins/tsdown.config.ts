import { createRequire } from 'node:module';
import { defineConfig } from 'tsdown';
import type { UserConfig } from 'tsdown';
import { adapterAssets } from './src/agents/adapter-manifest.ts';

const require = createRequire(import.meta.url);

const mainConfig = {
  entry: {
    agents: 'src/agents/registry.ts',
    'agents/adapter-manifest': 'src/agents/adapter-manifest.ts',
    'agents/helpers/adapter-assets': 'src/agents/helpers/adapter-assets.ts',
    'agents/helpers/adapter-validation': 'src/agents/helpers/adapter-validation.ts',
    'agents/types': 'src/agents/types.ts',
    integrations: 'src/integrations/index.ts',
    'integrations/github': 'src/integrations/impl/github/types.ts',
    issues: 'src/issues/index.ts',
    'pull-requests': 'src/pull-requests/index.ts',
    'pull-requests/github': 'src/pull-requests/impl/github/client.ts',
    'pull-requests/schemas': 'src/pull-requests/schemas.ts',
    'pull-requests/types': 'src/pull-requests/types.ts',
    repository: 'src/repository/index.ts',
  },
  format: ['esm'],
  dts: true,
  deps: {
    neverBundle: ['zod', 'smol-toml', '@emdash/core', '@emdash/shared'],
  },
  sourcemap: true,
  clean: true,
} satisfies UserConfig;

const adapterConfigs: UserConfig[] = adapterAssets.map((asset) => ({
  entry: {
    [`adapters/${asset.name}`]: require.resolve(asset.specifier),
  },
  format: [asset.format],
  dts: false,
  sourcemap: true,
  clean: false,
  // Adapters run as Node inside the Electron binary via ELECTRON_RUN_AS_NODE=1. Drop the flag
  // once running so the agent CLI and the commands it runs for the user don't inherit it.
  banner: 'delete process.env.ELECTRON_RUN_AS_NODE;',
  deps: {
    alwaysBundle: [/.*/],
    neverBundle: [...(asset.external ?? [])],
    onlyBundle: false,
  },
}));

export default defineConfig([mainConfig, ...adapterConfigs]);
