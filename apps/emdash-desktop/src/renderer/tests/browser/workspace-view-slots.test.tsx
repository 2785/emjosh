import { act, type ComponentType, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const navigationMocks = vi.hoisted(() => ({
  useWorkspaceSlots: vi.fn(),
}));

vi.mock('@core/features/workbench/browser/sidebar/left-sidebar', () => ({
  LeftSidebar: () => null,
}));
vi.mock('@core/features/workbench/browser/window-scope', () => ({
  WindowScope: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('@core/primitives/navigation/browser/navigation-hooks', () => ({
  useWorkspaceSlots: navigationMocks.useWorkspaceSlots,
  useWorkspaceViewParams: () => ({ params: {} }),
}));
vi.mock('@core/primitives/theme/browser', () => ({ useTheme: () => undefined }));
vi.mock('@renderer/lib/keybindings', () => ({
  BrowserShortcutForwarding: () => null,
  KeybindingDispatcherMount: () => null,
}));
vi.mock('@renderer/lib/layout/workspace-layout', () => ({
  WorkspaceLayout: ({ mainContent }: { mainContent: ReactNode }) => mainContent,
  WorkspaceContentLayout: ({
    titlebarSlot,
    mainPanel,
  }: {
    titlebarSlot: ReactNode;
    mainPanel: ReactNode;
  }) => (
    <>
      {titlebarSlot}
      {mainPanel}
    </>
  ),
}));
vi.mock('@emdash/ui/react/primitives', () => ({ Toaster: () => null }));
// Linux, where the window controls live in the titlebar.
vi.mock('@core/primitives/keybindings/api', () => ({
  detectPlatformContext: () => ({ os: 'linux' }),
}));
vi.mock('@core/features/workbench/contributions/browser/Titlebar', () => ({
  Titlebar: () => <header data-fallback-titlebar />,
}));

import { useRegisterBorderlessTitlebar } from '@core/features/workbench/contributions/browser/borderless-titlebar-registry';
import { Workspace } from '@renderer/app/workspace';

type TestSlots = {
  WrapView: ComponentType<{ children: ReactNode }>;
  TitlebarSlot: ComponentType;
  hasTitlebar: boolean;
  MainPanel: ComponentType;
  currentView: string;
};

function slotsFor(view: string): TestSlots {
  return {
    WrapView: ({ children }) => <section data-wrapper={view}>{children}</section>,
    TitlebarSlot: () => <header data-titlebar={view} />,
    hasTitlebar: true,
    MainPanel: () => <main data-main={view} />,
    currentView: view,
  };
}

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

describe('Workspace active view composition', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    navigationMocks.useWorkspaceSlots.mockReset();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it('renders the wrapper and slots from one navigation snapshot', async () => {
    navigationMocks.useWorkspaceSlots
      .mockReturnValueOnce(slotsFor('project'))
      .mockReturnValue(slotsFor('task'));

    await act(async () => root.render(<Workspace />));

    expect(host.querySelector('[data-wrapper="project"]')).not.toBeNull();
    expect(host.querySelector('[data-titlebar="project"]')).not.toBeNull();
    expect(host.querySelector('[data-main="project"]')).not.toBeNull();
    expect(navigationMocks.useWorkspaceSlots).toHaveBeenCalledOnce();
    expect(host.querySelector('[data-fallback-titlebar]')).toBeNull();
  });

  it('gives views without a titlebar a plain one on Linux, for the window controls', async () => {
    navigationMocks.useWorkspaceSlots.mockReturnValue({
      ...slotsFor('home'),
      TitlebarSlot: () => null,
      hasTitlebar: false,
    });

    await act(async () => root.render(<Workspace />));

    expect(host.querySelector('[data-fallback-titlebar]')).not.toBeNull();
    expect(host.querySelector('[data-main="home"]')).not.toBeNull();
  });
  it('adds no plain titlebar when the view draws its own borderless one', async () => {
    const OwnTitlebarMain = () => {
      useRegisterBorderlessTitlebar();
      return <main data-main="project" data-own-titlebar />;
    };
    navigationMocks.useWorkspaceSlots.mockReturnValue({
      ...slotsFor('project'),
      TitlebarSlot: () => null,
      hasTitlebar: false,
      MainPanel: OwnTitlebarMain,
    });

    await act(async () => root.render(<Workspace />));

    expect(host.querySelector('[data-own-titlebar]')).not.toBeNull();
    expect(host.querySelector('[data-fallback-titlebar]')).toBeNull();
  });

  it('brings the plain titlebar back once a borderless view is left', async () => {
    const OwnTitlebarMain = () => {
      useRegisterBorderlessTitlebar();
      return <main data-main="project" />;
    };
    const borderless = {
      ...slotsFor('project'),
      TitlebarSlot: () => null,
      hasTitlebar: false,
      MainPanel: OwnTitlebarMain,
    };
    const home = { ...slotsFor('home'), TitlebarSlot: () => null, hasTitlebar: false };
    navigationMocks.useWorkspaceSlots.mockReturnValue(borderless);
    await act(async () => root.render(<Workspace />));
    expect(host.querySelector('[data-fallback-titlebar]')).toBeNull();

    navigationMocks.useWorkspaceSlots.mockReturnValue(home);
    await act(async () => root.render(<Workspace />));

    expect(host.querySelector('[data-fallback-titlebar]')).not.toBeNull();
  });
});
