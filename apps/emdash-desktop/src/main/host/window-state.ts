import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { app, screen, type BrowserWindow, type Rectangle } from 'electron';
import { log } from '@main/lib/logger';

export type WindowState = {
  /** The window's bounds when neither maximized nor full screen. */
  bounds: Rectangle;
  maximized: boolean;
  fullScreen: boolean;
};

const SAVE_DELAY_MS = 500;
/** How much of the title bar must land on a display for saved bounds to be used. */
const MIN_VISIBLE_PX = 100;

function stateFile(): string {
  return join(app.getPath('userData'), 'window-state.json');
}

/** The saved state, or null when there is none or it no longer fits a connected display. */
export function loadWindowState(): WindowState | null {
  try {
    const saved = JSON.parse(readFileSync(stateFile(), 'utf8')) as WindowState;
    const workAreas = screen.getAllDisplays().map((display) => display.workArea);
    return isRestorable(saved, workAreas) ? saved : null;
  } catch {
    return null;
  }
}

/**
 * Whether saved bounds still place the window's top edge on a display, so a window from a
 * disconnected monitor doesn't open off screen.
 */
export function isRestorable(saved: unknown, workAreas: readonly Rectangle[]): boolean {
  const state = saved as Partial<WindowState> | null;
  const bounds = state?.bounds;
  if (
    !bounds ||
    ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) ||
    bounds.width <= 0 ||
    bounds.height <= 0
  ) {
    return false;
  }
  return workAreas.some((area) => {
    const overlap =
      Math.min(bounds.x + bounds.width, area.x + area.width) - Math.max(bounds.x, area.x);
    return overlap >= MIN_VISIBLE_PX && bounds.y >= area.y && bounds.y < area.y + area.height;
  });
}

/** Saves the window's placement as it moves and resizes, and when it closes. */
export function trackWindowState(window: BrowserWindow): void {
  let timer: NodeJS.Timeout | undefined;
  const save = () => {
    clearTimeout(timer);
    if (window.isDestroyed() || window.isMinimized()) return;
    const state: WindowState = {
      bounds: window.getNormalBounds(),
      maximized: window.isMaximized(),
      fullScreen: window.isFullScreen(),
    };
    writeFile(stateFile(), JSON.stringify(state)).catch((error: unknown) =>
      log.warn('Could not save window position', { error })
    );
  };
  const saveSoon = () => {
    clearTimeout(timer);
    timer = setTimeout(save, SAVE_DELAY_MS);
  };
  window.on('move', saveSoon);
  window.on('resize', saveSoon);
  window.on('maximize', saveSoon);
  window.on('unmaximize', saveSoon);
  window.on('enter-full-screen', saveSoon);
  window.on('leave-full-screen', saveSoon);
  window.on('close', save);
}
