import { cp, rm } from 'node:fs/promises';
import { basename, extname, resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';
import type { Plugin } from 'vite';
import { desktopWorkers } from './src/core/manifests/node/workers';
import { resolveAppIdentity } from './src/core/primitives/app-identity/api/app-identity';

function desktopWorkerBuildInputs(): Record<string, string> {
  return Object.fromEntries(
    Object.values(desktopWorkers).map((worker) => [
      basename(worker.file, extname(worker.file)),
      resolve(worker.entry),
    ])
  );
}

function copyAdapterAssetsPlugin() {
  return {
    name: 'copy-plugin-adapter-assets',
    async closeBundle(): Promise<void> {
      const source = resolve('../../packages/plugins/dist/adapters');
      const target = resolve('out/main/adapters');
      try {
        await rm(target, { recursive: true, force: true });
        await cp(source, target, { recursive: true });
      } catch (error) {
        if (isNodeError(error) && error.code === 'ENOENT') return;
        throw error;
      }
    },
  };
}

/**
 * Fills `%PRODUCT_NAME%` in index.html with the build flavor's product name. The personal
 * build replaces the Emdash logo between the `splash-logo` markers with a text wordmark.
 */
function productNameHtmlPlugin(): Plugin {
  let productName = 'Emdash';
  let personal = false;
  return {
    name: 'product-name-html',
    configResolved(config) {
      const identity = resolveAppIdentity({
        dev: config.env.DEV === true,
        build: config.env.VITE_BUILD,
      });
      productName = identity.PRODUCT_NAME;
      personal = identity.IS_PERSONAL;
    },
    transformIndexHtml: (html) => {
      const named = html.replaceAll('%PRODUCT_NAME%', productName);
      if (!personal) return named;
      return named.replace(
        /<!-- splash-logo -->[\s\S]*?<!-- \/splash-logo -->/,
        `<div class="boot-splash-wordmark">${productName}</div>`
      );
    },
  };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

// Workspace packages must be bundled (not externalized) in main/preload builds:
// externalized modules are resolved by Node at runtime, where the `development`
// export condition is off, so dev runs would silently load stale dists.
const workspacePackages = [
  '@emdash/chat-ui',
  '@emdash/core',
  '@emdash/plugins',
  '@emdash/shared',
  '@emdash/theme',
  '@emdash/ui',
  '@emdash/wire',
];

export default defineConfig({
  main: {
    root: 'src/main',
    envDir: resolve('.'),
    plugins: [copyAdapterAssetsPlugin()],
    // formidable (bundled via @emdash/plugins -> asana) reassigns `require`
    // behind a `global.GENTLY` guard, which Rollup rejects. Defining it false
    // makes the branch dead code so the bundle builds.
    define: {
      'global.GENTLY': 'false',
    },
    build: {
      externalizeDeps: {
        exclude: workspacePackages,
      },
      rollupOptions: {
        input: {
          index: resolve('src/entry/main.ts'),
          // stdio bridge for MCP clients outside the app (see src/entry/mcp-bridge.ts).
          'mcp-bridge': resolve('src/entry/mcp-bridge.ts'),
          ...desktopWorkerBuildInputs(),
        },
        output: {
          entryFileNames: '[name].js',
        },
      },
    },
    resolve: {
      alias: {
        '@': resolve('src'),
        '@core': resolve('src/core'),
        '@main': resolve('src/main'),
        '@root': resolve('.'),
      },
    },
  },
  preload: {
    root: 'src/entry',
    build: {
      externalizeDeps: {
        exclude: workspacePackages,
      },
      rollupOptions: {
        input: {
          index: resolve('src/entry/preload.ts'),
        },
      },
    },
    resolve: {
      alias: {
        '@root': resolve('.'),
      },
    },
  },
  renderer: {
    root: 'src/renderer',
    // Minified for a smaller bundle to load at launch; names are kept so in-app CPU profiles
    // (Record UI Performance Profile) still name real functions.
    build: { minify: 'esbuild' },
    esbuild: { minifyIdentifiers: false },
    // Same env files as main, so build flavor variables (VITE_BUILD) reach the renderer too.
    envDir: resolve('.'),
    plugins: [react(), tailwindcss(), productNameHtmlPlugin()],
    resolve: {
      alias: {
        '@': resolve('src'),
        '@core': resolve('src/core'),
        '@renderer': resolve('src/renderer'),
        '@root': resolve('.'),
        // cli-agent-plugins metadata/icons chunks transitively reference node:buffer
        // (through hook-config helpers bundled in the same tsdown chunk), even though
        // those helpers never run in the renderer. Alias to the browser-safe polyfill.
        'node:buffer': 'buffer',
      },
    },
    server: {
      port: 3000,
    },
  },
});
