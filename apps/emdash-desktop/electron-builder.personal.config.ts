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
  // A zip of the unpacked app, built on a Mac (scripts/package-personal-win.sh). No installer and no
  // exe resource edits (both need Wine there), and no signing: upstream's Azure signing is
  // Emdash's account.
  win: {
    ...base.win,
    icon: 'src/assets/images/emjosh/emjosh.png',
    artifactName: `${PRODUCT_NAME}-win-x64.\${ext}`,
    target: [{ target: 'zip', arch: ['x64'] }],
    azureSignOptions: undefined,
    signAndEditExecutable: false,
  },
  linux: {
    ...base.linux,
    icon: 'src/assets/images/emjosh/emjosh.png',
    artifactName: `${PRODUCT_NAME}-linux-x64.\${ext}`,
    target: [{ target: 'AppImage', arch: ['x64'] }],
  },
};

export default config;
