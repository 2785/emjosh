import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunningCommand } from './running-command';
import { useRunningCommandNotice } from './use-running-command-notice';

function Harness({
  running,
  canStop = true,
}: {
  running: RunningCommand | null;
  canStop?: boolean;
}) {
  const notice = useRunningCommandNotice(running, canStop, () => {});
  return (
    <div data-notice={notice ? notice.message : ''} data-action={notice?.action?.label ?? ''} />
  );
}

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

describe('useRunningCommandNotice', () => {
  let host: HTMLDivElement;
  let root: Root;
  const command: RunningCommand = { id: 'c1', command: 'glab repo create synctera/x' };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.useRealTimers();
  });

  const notice = () => host.firstElementChild?.getAttribute('data-notice') ?? '';
  const advance = (ms: number) => act(async () => void vi.advanceTimersByTime(ms));

  it('stays quiet for the first 20 seconds of a command, however long the chat was open', async () => {
    await act(async () => root.render(<Harness running={null} />));
    await advance(5 * 60_000);

    await act(async () => root.render(<Harness running={command} />));
    expect(notice()).toBe('');
    await advance(16_000);
    expect(notice()).toBe('');
    await advance(4_000);
    expect(notice()).toBe('glab repo create synctera/x · running 20s');
    expect(host.firstElementChild?.getAttribute('data-action')).toBe('Stop');
  });

  it('starts counting again for the next command', async () => {
    await act(async () => root.render(<Harness running={command} />));
    await advance(22_000);
    expect(notice()).not.toBe('');

    await act(async () => root.render(<Harness running={null} />));
    await act(async () => root.render(<Harness running={{ id: 'c2', command: 'make test' }} />));

    expect(notice()).toBe('');
    await advance(20_000);
    expect(notice()).toBe('make test · running 20s');
  });

  it('shows nothing when the turn cannot be stopped', async () => {
    await act(async () => root.render(<Harness running={command} canStop={false} />));
    await advance(40_000);

    expect(notice()).toBe('');
  });
});
