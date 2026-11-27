/** Window managers that tile windows and draw no window buttons of their own. */
const TILING_DESKTOPS = [
  'sway',
  'i3',
  'hyprland',
  'niri',
  'river',
  'bspwm',
  'awesome',
  'qtile',
  'xmonad',
  'herbstluftwm',
  'dwm',
  'dwl',
];

/** Variables the tiling compositors export to everything started inside their session. */
const TILING_SESSION_VARIABLES = [
  'SWAYSOCK',
  'I3SOCK',
  'HYPRLAND_INSTANCE_SIGNATURE',
  'NIRI_SOCKET',
];

/**
 * Whether the app runs under a tiling window manager, where its own minimize/maximize/close
 * buttons are just noise. `EMJOSH_WINDOW_CONTROLS=always|never` overrides the guess.
 */
export function usesTilingWindowManager(env: NodeJS.ProcessEnv): boolean {
  const override = env.EMJOSH_WINDOW_CONTROLS?.toLowerCase();
  if (override === 'always') return false;
  if (override === 'never') return true;
  if (TILING_SESSION_VARIABLES.some((name) => Boolean(env[name]))) return true;
  const desktops = (env.XDG_CURRENT_DESKTOP ?? '')
    .toLowerCase()
    .split(':')
    .map((name) => name.trim());
  return desktops.some((name) => TILING_DESKTOPS.includes(name));
}
