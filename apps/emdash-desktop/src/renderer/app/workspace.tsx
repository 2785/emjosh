import { Toaster } from '@emdash/ui/react/primitives';
import { useCallback, useState } from 'react';
import { LeftSidebar } from '@core/features/workbench/browser/sidebar/left-sidebar';
import { WindowScope } from '@core/features/workbench/browser/window-scope';
import { BorderlessTitlebarContext } from '@core/features/workbench/contributions/browser/borderless-titlebar-registry';
import { Titlebar } from '@core/features/workbench/contributions/browser/Titlebar';
import { detectPlatformContext } from '@core/primitives/keybindings/api';
import {
  useWorkspaceSlots,
  useWorkspaceViewParams,
} from '@core/primitives/navigation/browser/navigation-hooks';
import { useTheme } from '@core/primitives/theme/browser';
import { BrowserShortcutForwarding, KeybindingDispatcherMount } from '@renderer/lib/keybindings';
import { WorkspaceContentLayout, WorkspaceLayout } from '@renderer/lib/layout/workspace-layout';

const isLinux = detectPlatformContext().os === 'linux';

export function Workspace() {
  useTheme();
  const { WrapView, TitlebarSlot, hasTitlebar, MainPanel } = useWorkspaceSlots();
  // Views that draw their own borderless titlebar (projects, settings) say so while mounted.
  const [borderlessTitlebars, setBorderlessTitlebars] = useState(0);
  const registerBorderlessTitlebar = useCallback(() => {
    setBorderlessTitlebars((count) => count + 1);
    return () => setBorderlessTitlebars((count) => count - 1);
  }, []);
  // Linux's frameless window gets its minimize/maximize/close buttons from a titlebar, so a view
  // with none at all (such as home) gets a plain one there.
  const needsFallbackTitlebar = isLinux && !hasTitlebar && borderlessTitlebars === 0;
  const titlebar = needsFallbackTitlebar ? <Titlebar /> : <TitlebarSlot />;
  const { params } = useWorkspaceViewParams();

  return (
    <WindowScope>
      <BrowserShortcutForwarding />
      <KeybindingDispatcherMount />
      <BorderlessTitlebarContext.Provider value={registerBorderlessTitlebar}>
        <WorkspaceLayout
          leftSidebar={<LeftSidebar />}
          mainContent={
            <WrapView {...params}>
              <WorkspaceContentLayout titlebarSlot={titlebar} mainPanel={<MainPanel />} />
            </WrapView>
          }
        />
      </BorderlessTitlebarContext.Provider>
      <Toaster />
    </WindowScope>
  );
}
