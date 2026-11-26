import '@emdash/ui/style.css';
import { ChatComposer } from '@emdash/ui/react/components';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';

async function renderAtWidth(width: number) {
  const host = document.createElement('div');
  host.style.width = `${width}px`;
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <ChatComposer
        modelOptions={{ default: { name: 'Sonnet 5.5' } }}
        selectedModel="default"
        onModelChange={() => {}}
        effortOptions={{ high: { name: 'High' } }}
        selectedEffort="high"
        onEffortChange={() => {}}
        permissionModeOptions={{
          bypassPermissions: { name: 'Bypass permissions', description: 'Accepts all permissions' },
        }}
        selectedPermissionMode="bypassPermissions"
        onPermissionModeChange={() => {}}
        mcpServers={[
          { name: 'emjosh', transport: 'http' },
          { name: 'notion', transport: 'http' },
          { name: 'gopls', transport: 'stdio' },
          { name: 'glean', transport: 'http' },
        ]}
        contextUsage={{ used: 1000, size: 200000 }}
        onAttach={() => {}}
        onSubmit={() => {}}
      />
    )
  );
  return {
    host,
    cleanup: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

describe('chat composer toolbar on a narrow screen', () => {
  it('keeps the attach and send buttons inside the composer', async () => {
    const { host, cleanup } = await renderAtWidth(340);
    try {
      const bounds = host.getBoundingClientRect();
      for (const name of ['Add attachment', 'Send message']) {
        const button = host.querySelector<HTMLElement>(`[aria-label="${name}"]`);
        expect(button, name).not.toBeNull();
        const rect = button!.getBoundingClientRect();
        expect(rect.right, `${name} right edge`).toBeLessThanOrEqual(bounds.right + 0.5);
        expect(rect.left, `${name} left edge`).toBeGreaterThanOrEqual(bounds.left - 0.5);
      }
      expect(host.scrollWidth).toBeLessThanOrEqual(host.clientWidth + 1);
    } finally {
      await cleanup();
    }
  });
});
