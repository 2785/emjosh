import { useCallback, useEffect, type ReactNode } from 'react';
import { getSharedChatContext } from '@core/features/conversations/api/browser/chat/shared-chat-context';
import { useAppSettingsKey } from '@core/features/settings/api/browser/use-app-settings-key';
import { applyThemeToAll } from '@core/features/terminals/api/browser/pty/pty';
import { FRAME_TINT_ATTRIBUTE, frameTintCss } from '@core/primitives/theme/api/frame-tint';
import { ThemeProvider as CoreThemeProvider } from '@core/primitives/theme/browser';

const FRAME_TINT_CSS = frameTintCss();

/** Chat column max width per Settings → Interface → Chat width. */
const CHAT_CONTENT_WIDTHS = { comfortable: '42rem', wide: '64rem', full: 'none' } as const;

export function ThemeProvider({ children }: { readonly children: ReactNode }) {
  const { value, isLoading, update } = useAppSettingsKey('theme');
  const frameTint = useAppSettingsKey('frameTint').value ?? 'none';
  const interfaceSettings = useAppSettingsKey('interface').value;
  const chatWidth = interfaceSettings?.chatWidth ?? 'wide';
  const wrapCodeBlocks = interfaceSettings?.wrapCodeBlocks ?? true;
  const handleThemeApplied = useCallback(() => applyThemeToAll(), []);

  useEffect(() => {
    const root = document.documentElement;
    if (frameTint === 'none') root.removeAttribute(FRAME_TINT_ATTRIBUTE);
    else root.setAttribute(FRAME_TINT_ATTRIBUTE, frameTint);
  }, [frameTint]);

  useEffect(() => {
    document.documentElement.style.setProperty(
      '--em-chat-content-width',
      CHAT_CONTENT_WIDTHS[chatWidth]
    );
  }, [chatWidth]);

  useEffect(() => {
    getSharedChatContext().setWrapCode(wrapCodeBlocks);
  }, [wrapCodeBlocks]);

  return (
    <CoreThemeProvider
      theme={value ?? null}
      isLoading={isLoading}
      onThemeChange={update}
      onThemeApplied={handleThemeApplied}
    >
      <style>{FRAME_TINT_CSS}</style>
      {children}
    </CoreThemeProvider>
  );
}
