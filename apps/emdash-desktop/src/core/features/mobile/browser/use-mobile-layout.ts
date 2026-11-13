import { useCallback, useEffect, useState } from 'react';

/** Screens this narrow get the mobile layout (phones, not tablets). */
const NARROW_QUERY = '(max-width: 760px)';
const DESKTOP_VIEW_KEY = 'emjosh-desktop-view';

function isRemoteWeb(): boolean {
  return (window as unknown as { __EMJOSH_REMOTE__?: unknown }).__EMJOSH_REMOTE__ !== undefined;
}

function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => window.matchMedia(NARROW_QUERY).matches);
  useEffect(() => {
    const query = window.matchMedia(NARROW_QUERY);
    const onChange = () => setNarrow(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  return narrow;
}

/**
 * Which layout the app uses: the mobile one on a narrow screen through remote control, unless
 * the user chose the desktop view there. The desktop window always uses the desktop layout.
 */
export function useLayoutMode(): 'desktop' | 'mobile' | 'desktop-on-mobile' {
  const narrow = useNarrow();
  if (!isRemoteWeb() || !narrow) return 'desktop';
  return localStorage.getItem(DESKTOP_VIEW_KEY) === '1' ? 'desktop-on-mobile' : 'mobile';
}

export function useDesktopViewSwitch(): () => void {
  return useCallback(() => {
    localStorage.setItem(DESKTOP_VIEW_KEY, '1');
    location.reload();
  }, []);
}

export function switchToMobileView(): void {
  localStorage.removeItem(DESKTOP_VIEW_KEY);
  location.reload();
}
