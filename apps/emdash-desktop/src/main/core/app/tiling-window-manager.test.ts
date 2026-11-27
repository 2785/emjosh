import { describe, expect, it } from 'vitest';
import { usesTilingWindowManager } from './tiling-window-manager';

describe('usesTilingWindowManager', () => {
  it('recognises a sway session by its socket, even when the desktop name says otherwise', () => {
    expect(usesTilingWindowManager({ SWAYSOCK: '/run/user/1000/sway-ipc.sock' })).toBe(true);
    expect(
      usesTilingWindowManager({
        SWAYSOCK: '/run/user/1000/sway-ipc.sock',
        XDG_CURRENT_DESKTOP: 'Pop',
      })
    ).toBe(true);
  });

  it('recognises other tiling compositors', () => {
    expect(usesTilingWindowManager({ HYPRLAND_INSTANCE_SIGNATURE: 'abc' })).toBe(true);
    expect(usesTilingWindowManager({ NIRI_SOCKET: '/run/niri.sock' })).toBe(true);
    expect(usesTilingWindowManager({ XDG_CURRENT_DESKTOP: 'i3' })).toBe(true);
    expect(usesTilingWindowManager({ XDG_CURRENT_DESKTOP: 'Sway' })).toBe(true);
  });

  it('leaves ordinary desktops with their window buttons', () => {
    expect(usesTilingWindowManager({})).toBe(false);
    expect(usesTilingWindowManager({ XDG_CURRENT_DESKTOP: 'GNOME' })).toBe(false);
    expect(usesTilingWindowManager({ XDG_CURRENT_DESKTOP: 'ubuntu:GNOME' })).toBe(false);
    expect(usesTilingWindowManager({ XDG_CURRENT_DESKTOP: 'KDE' })).toBe(false);
  });

  it('lets EMJOSH_WINDOW_CONTROLS decide either way', () => {
    expect(usesTilingWindowManager({ SWAYSOCK: '/x', EMJOSH_WINDOW_CONTROLS: 'always' })).toBe(
      false
    );
    expect(
      usesTilingWindowManager({ XDG_CURRENT_DESKTOP: 'GNOME', EMJOSH_WINDOW_CONTROLS: 'never' })
    ).toBe(true);
  });
});
