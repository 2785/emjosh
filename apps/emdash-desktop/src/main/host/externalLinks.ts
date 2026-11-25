import { shell, type BrowserWindow } from 'electron';
import { desktopHostEvents } from '@core/features/workbench/node';
import { decideMainWindowLink } from '@main/host/external-link-policy';
import { getMainWindow } from '@main/host/window';
import { log } from '@main/lib/logger';

/**
 * Ensure external HTTP(S) links open in the user's default browser and every other
 * non-app link is denied, rather than opening inside (or beside) the Electron window. Keeps app navigation scoped
 * to our renderer while preserving expected link behavior.
 */
function requestExternalLinkOpen(url: string) {
  const mainWindow = getMainWindow();
  if (mainWindow && !mainWindow.isDestroyed()) {
    desktopHostEvents.emit(undefined, { type: 'external-link-open-requested', url });
    return;
  }

  log.warn('External link request had no main window; opening directly', { url });
  shell.openExternal(url).catch((error: unknown) => {
    log.warn('Failed to open external link without main window', { url, error });
  });
}

/**
 * `rendererUrl` is the URL the main window was loaded from; only navigations to that origin
 * stay in-window. Local dev servers on other localhost ports are external links like any other.
 */
export function registerExternalLinkHandlers(win: BrowserWindow, rendererUrl: string) {
  const wc = win.webContents;

  // Handle window.open and target="_blank"
  wc.setWindowOpenHandler(({ url }) => {
    const decision = decideMainWindowLink(url, rendererUrl);
    if (decision === 'external') requestExternalLinkOpen(url);
    return decision === 'stay' ? { action: 'allow' } : { action: 'deny' };
  });

  // Intercept navigations that would leave the app
  wc.on('will-navigate', (event, url) => {
    const decision = decideMainWindowLink(url, rendererUrl);
    if (decision === 'stay') return;
    event.preventDefault();
    if (decision === 'external') requestExternalLinkOpen(url);
  });
}
