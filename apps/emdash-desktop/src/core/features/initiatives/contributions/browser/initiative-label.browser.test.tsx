import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeAll, describe, expect, it } from 'vitest';
import { InitiativeLabel } from './initiative-label';

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

describe('InitiativeLabel', () => {
  it('shows the label as a badge named for assistive tech', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(<InitiativeLabel label="F" />));

    const badge = host.querySelector('[aria-label="Label F"]');
    expect(badge?.textContent).toBe('F');
    await act(async () => root.unmount());
    host.remove();
  });
});
