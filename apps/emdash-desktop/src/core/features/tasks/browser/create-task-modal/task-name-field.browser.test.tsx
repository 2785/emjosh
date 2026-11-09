import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskNameField } from './task-name-field';

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

describe('TaskNameField', () => {
  let host: HTMLDivElement;
  let root: Root;
  const state = {
    taskName: 'fix login',
    placeholder: '',
    effectiveTaskName: 'fix login',
    handleTaskNameChange: () => {},
    showSlugHint: false,
    isPending: false,
  };

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  const press = (key: string, init: KeyboardEventInit = {}) =>
    act(() => {
      host
        .querySelector('input')!
        .dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...init }));
    });

  it('creates the task on Enter when "Create tasks with Enter" is on', async () => {
    const onSubmit = vi.fn();
    await act(async () =>
      root.render(<TaskNameField state={state as never} onSubmit={onSubmit} />)
    );
    press('Enter');
    expect(onSubmit).toHaveBeenCalledOnce();
    // Cmd+Enter is the dialog-wide shortcut; the field leaves it alone.
    press('Enter', { metaKey: true });
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it('does nothing on Enter when the setting is off', async () => {
    await act(async () => root.render(<TaskNameField state={state as never} />));
    expect(() => press('Enter')).not.toThrow();
  });
});
