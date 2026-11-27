import { createContext, useContext, useLayoutEffect } from 'react';

/**
 * A view with its own borderless titlebar already carries Linux's window controls, so the
 * workspace's plain fallback titlebar would stack a second bar on top of it. The workspace
 * provides this; the borderless titlebar registers itself with it while mounted.
 */
export const BorderlessTitlebarContext = createContext<(() => () => void) | null>(null);

export function useRegisterBorderlessTitlebar(): void {
  const register = useContext(BorderlessTitlebarContext);
  useLayoutEffect(() => register?.(), [register]);
}
