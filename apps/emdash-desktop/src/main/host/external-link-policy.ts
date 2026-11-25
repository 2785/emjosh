/**
 * Whether `url` belongs to the origin the main window's renderer was loaded from.
 *
 * Only same-origin navigations may stay inside the main window. Everything else — including
 * local dev servers on `localhost` / `127.0.0.1` — must go through the external-link flow so
 * the user can pick an in-app browser tab or the system browser instead of getting a bare,
 * unmanaged Electron window.
 */
export function isInternalAppUrl(url: string, rendererUrl: string): boolean {
  const target = parseOrigin(url);
  const app = parseOrigin(rendererUrl);
  if (!target || !app) return false;
  return target.protocol === app.protocol && target.host === app.host;
}

function parseOrigin(value: string): { protocol: string; host: string } | undefined {
  try {
    const parsed = new URL(value);
    // `URL.origin` is "null" for custom schemes such as app://, so compare the parts directly.
    return { protocol: parsed.protocol, host: parsed.host.toLowerCase() };
  } catch {
    return undefined;
  }
}

export type LinkDecision = 'stay' | 'external' | 'deny';

/**
 * What the main window does with a link or navigation target: same-origin stays, http(s) goes to
 * the external-link flow, and anything else (e.g. `emjosh://workspace/<id>`, which the renderer
 * handles itself) is denied so it can never open an unmanaged window.
 */
export function decideMainWindowLink(url: string, rendererUrl: string): LinkDecision {
  if (isInternalAppUrl(url, rendererUrl)) return 'stay';
  return /^https?:\/\//i.test(url) ? 'external' : 'deny';
}
