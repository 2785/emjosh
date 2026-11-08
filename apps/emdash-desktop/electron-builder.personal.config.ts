import type { Configuration } from 'electron-builder';
import base from './electron-builder.config.ts';
import {
  APP_ID,
  APP_NAME_LOWER,
  LINUX_DESKTOP_ID,
  PRODUCT_NAME,
} from './src/core/primitives/app-identity/api/app-identity.personal.ts';

// The fork (Emjosh), built locally: an unpacked .app signed after packaging
// (scripts/package-personal.sh), and a Linux x64 AppImage built in a container
// (scripts/package-personal-linux.sh).
const config: Configuration = {
  ...base,
  appId: APP_ID,
  productName: PRODUCT_NAME,
  executableName: PRODUCT_NAME,
  extraMetadata: {
    desktopName: `${LINUX_DESKTOP_ID}.desktop`,
    // Emjosh's own release version (scripts/package-personal.sh), not upstream's.
    ...(process.env.EMJOSH_VERSION ? { version: process.env.EMJOSH_VERSION } : {}),
  },
  artifactName: `${APP_NAME_LOWER}-\${arch}.\${ext}`,
  publish: null,
  mac: {
    ...base.mac,
    // Signed afterwards with the local identity (scripts/package-personal.sh).
    identity: null,
    hardenedRuntime: false,
    // Intel builds come from scripts/package-personal-mac-x64.sh.
    target: [{ target: 'dir', arch: [process.env.EMJOSH_MAC_ARCH === 'x64' ? 'x64' : 'arm64'] }],
    icon: 'src/assets/images/emjosh/emjosh.icns',
    extendInfo: {
      ...base.mac?.extendInfo,
      NSMicrophoneUsageDescription: `${PRODUCT_NAME} needs microphone access for voice dictation and voice mode features.`,
      NSLocalNetworkUsageDescription: `${PRODUCT_NAME} needs local network access to connect to SSH hosts on your network.`,
    },
  },
  // An NSIS installer built on a Mac (scripts/package-personal.sh, EMJOSH_TARGET=win). The exe's
  // icon and version info are written by resedit there, since electron-builder's rcedit needs
  // Wine on a Mac. Unsigned: upstream's Azure signing is Emdash's account.
  win: {
    ...base.win,
    icon: 'src/assets/images/emjosh/emjosh.ico',
    target: [{ target: 'nsis', arch: ['x64'] }],
    azureSignOptions: undefined,
    signAndEditExecutable: false,
  },
  // The unified NSIS bundle runs natively on Apple Silicon; the default one's makensis is Intel-only.
  toolsets: { ...base.toolsets, nsis: '1.2.1' },
  nsis: {
    ...base.nsis,
    artifactName: `${PRODUCT_NAME}-win-x64-setup.\${ext}`,
    shortcutName: PRODUCT_NAME,
    uninstallDisplayName: PRODUCT_NAME,
  },
  linux: {
    ...base.linux,
    icon: 'src/assets/images/emjosh/emjosh.png',
    artifactName: `${PRODUCT_NAME}-linux-x64.\${ext}`,
    target: [{ target: 'AppImage', arch: ['x64'] }],
  },
};

export default config;
