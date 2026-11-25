import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { IS_PERSONAL, PRODUCT_NAME } from '@core/primitives/app-identity/api/app-identity';
import { resolveAppVersion } from '@main/core/app/utils';
import { log } from '@main/lib/logger';
import { PERSONAL_STAGE_DIR, runningAppPath, stagedArtifactName } from './personal-reload';

/** Only this repository's releases are installed; only its owner can publish them. */
export const PERSONAL_RELEASES_REPO = '2785/emjosh';
/** Release asset describing the release; keep in sync with scripts/release.sh. */
export const PERSONAL_MANIFEST_ASSET = 'emjosh-update.json';

// Soon after launch, so reopening the app is enough to pick up a new release.
const STARTUP_DELAY_MS = 5_000;
const CHECK_INTERVAL_MS = 60 * 60 * 1000;

/** Platforms Emjosh is released for, as keys of a manifest's `assets`. */
export type ReleasePlatform = 'mac-arm64' | 'mac-x64' | 'linux-x64' | 'win-x64';

const isMac = (platform: ReleasePlatform) => platform.startsWith('mac-');

function nodePlatform(platform: ReleasePlatform): NodeJS.Platform {
  if (isMac(platform)) return 'darwin';
  return platform === 'win-x64' ? 'win32' : 'linux';
}

/** What a release ships for one platform: a zip of the signed `.app`, an AppImage, or the Windows installer. */
export type PersonalReleaseAsset = {
  file: string;
  /** Base64 SHA-512 of the file. */
  sha512: string;
  size: number;
};

export type PersonalReleaseManifest = {
  version: string;
  commit: string;
  releasedAt: string;
  assets: Partial<Record<ReleasePlatform, PersonalReleaseAsset>>;
};

const VERSION = /^(\d+)\.(\d+)\.(\d+)$/;
const ASSET_FILE: Record<ReleasePlatform, RegExp> = {
  'mac-arm64': /^[\w.-]+\.zip$/,
  'mac-x64': /^[\w.-]+\.zip$/,
  'linux-x64': /^[\w.-]+\.AppImage$/,
  'win-x64': /^[\w.-]+\.exe$/,
};

function parseAsset(raw: unknown, platform: ReleasePlatform): PersonalReleaseAsset | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const a = raw as Record<string, unknown>;
  const valid =
    typeof a.file === 'string' &&
    ASSET_FILE[platform].test(a.file) &&
    typeof a.sha512 === 'string' &&
    typeof a.size === 'number';
  return valid
    ? { file: a.file as string, sha512: a.sha512 as string, size: a.size as number }
    : null;
}

export function parseReleaseManifest(raw: unknown): PersonalReleaseManifest | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const m = raw as Record<string, unknown>;
  if (
    typeof m.version !== 'string' ||
    !VERSION.test(m.version) ||
    typeof m.commit !== 'string' ||
    typeof m.releasedAt !== 'string' ||
    typeof m.assets !== 'object' ||
    m.assets === null
  ) {
    return null;
  }
  const assets: PersonalReleaseManifest['assets'] = {};
  for (const platform of Object.keys(ASSET_FILE) as ReleasePlatform[]) {
    const raw = (m.assets as Record<string, unknown>)[platform];
    if (raw === undefined) continue;
    const asset = parseAsset(raw, platform);
    if (!asset) return null;
    assets[platform] = asset;
  }
  return { version: m.version, commit: m.commit, releasedAt: m.releasedAt, assets };
}

/** The release platform of this process, or null when Emjosh isn't released for it. */
export function releasePlatform(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): ReleasePlatform | null {
  if (platform === 'darwin' && arch === 'arm64') return 'mac-arm64';
  if (platform === 'darwin' && arch === 'x64') return 'mac-x64';
  if (platform === 'linux' && arch === 'x64') return 'linux-x64';
  if (platform === 'win32' && arch === 'x64') return 'win-x64';
  return null;
}

/** `candidate > current` for `x.y.z` versions; anything else is never newer. */
export function isNewerVersion(candidate: string, current: string): boolean {
  const a = VERSION.exec(candidate);
  const b = VERSION.exec(current);
  if (!a || !b) return false;
  for (let i = 1; i <= 3; i++) {
    const diff = Number(a[i]) - Number(b[i]);
    if (diff !== 0) return diff > 0;
  }
  return false;
}

export type PersonalUpdateDeps = {
  enabled: boolean;
  platform: ReleasePlatform | null;
  currentVersion(): Promise<string>;
  /** The latest release's manifest, or null when there is none. */
  fetchManifest(): Promise<unknown>;
  /** Version of the build waiting for Reload, if any. */
  stagedVersion(): Promise<string | null>;
  /** Downloads, verifies, and stages this platform's build for the Reload button. */
  stage(manifest: PersonalReleaseManifest, asset: PersonalReleaseAsset): Promise<void>;
};

export type PersonalUpdateResult =
  | { status: 'disabled' }
  /** `current` is this app's version. */
  | { status: 'up-to-date'; current: string }
  /** `version` is the release waiting for Reload. */
  | { status: 'already-staged' | 'staged'; version: string };

/**
 * Checks the fork's GitHub releases and stages newer builds where `install:personal` stages
 * local ones, so the sidebar's Reload button switches to them.
 */
export class PersonalUpdateService {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<PersonalUpdateResult> | null = null;

  constructor(private readonly deps: PersonalUpdateDeps) {}

  start(): void {
    if (!this.deps.enabled || this.timer) return;
    const run = () => {
      this.check().catch((error: unknown) => log.warn('Emjosh update check failed', { error }));
    };
    this.timer = setTimeout(() => {
      run();
      this.timer = setInterval(run, CHECK_INTERVAL_MS);
      this.timer.unref?.();
    }, STARTUP_DELAY_MS);
    this.timer.unref?.();
  }

  /**
   * Checks now, downloading and staging a newer release. `onDownloading` runs before a download
   * starts; a check already in progress is joined instead, without calling it.
   */
  check(options: { onDownloading?(version: string): void } = {}): Promise<PersonalUpdateResult> {
    this.running ??= this.performCheck(options.onDownloading).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  dispose(): void {
    clearTimeout(this.timer);
    clearInterval(this.timer);
    this.timer = undefined;
  }

  private async performCheck(
    onDownloading?: (version: string) => void
  ): Promise<PersonalUpdateResult> {
    if (!this.deps.enabled || !this.deps.platform) return { status: 'disabled' };
    const manifest = parseReleaseManifest(await this.deps.fetchManifest());
    const asset = manifest?.assets[this.deps.platform];
    const current = await this.deps.currentVersion();
    if (!manifest || !asset || !isNewerVersion(manifest.version, current)) {
      return { status: 'up-to-date', current };
    }
    const { version } = manifest;
    if ((await this.deps.stagedVersion()) === version) return { status: 'already-staged', version };
    onDownloading?.(version);
    await this.deps.stage(manifest, asset);
    log.info('Staged Emjosh release', { version });
    return { status: 'staged', version };
  }
}

const execFileAsync = promisify(execFile);

/** The running bundle's designated requirement, which every update must also satisfy. */
async function designatedRequirement(bundlePath: string): Promise<string> {
  const { stdout } = await execFileAsync('codesign', ['-d', '-r-', bundlePath]);
  // Ad-hoc signatures list their implicit requirement as a `# designated => …` comment.
  const match = /^(?:# )?designated => (.+)$/m.exec(stdout);
  if (!match) throw new Error('The running app has no designated requirement');
  return match[1]!;
}

async function download(url: string, path: string): Promise<{ sha512: string; size: number }> {
  const response = await fetch(url);
  if (!response.ok || !response.body) throw new Error(`Download failed: ${response.status}`);
  const hash = createHash('sha512');
  let size = 0;
  const tap = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      size += chunk.length;
      callback(null, chunk);
    },
  });
  await pipeline(
    Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
    tap,
    createWriteStream(path)
  );
  return { sha512: hash.digest('base64'), size };
}

export function releaseAssetUrl(version: string, asset: PersonalReleaseAsset): string {
  return `https://github.com/${PERSONAL_RELEASES_REPO}/releases/download/emjosh-v${version}/${asset.file}`;
}

/** Unpacks the downloaded zip and checks the app is signed like the running one. */
async function prepareMacApp(zip: string, work: string, bundlePath: string, productName: string) {
  const extracted = join(work, 'app');
  await execFileAsync('ditto', ['-x', '-k', zip, extracted]);
  const app = join(extracted, `${productName}.app`);
  await stat(app);
  // Only builds signed by the same identity as the running app are accepted.
  const requirement = await designatedRequirement(bundlePath);
  await execFileAsync('codesign', ['--verify', '--deep', '--strict', `-R=${requirement}`, app]);
  return app;
}

/**
 * Downloads this platform's build, checks it against the manifest (and on macOS against the
 * running app's signing identity; Linux and Windows have no equivalent), and moves it to `stageDir` with a
 * `build.json` for the Reload button.
 */
export async function stageRelease(
  manifest: PersonalReleaseManifest,
  asset: PersonalReleaseAsset,
  options: {
    platform: ReleasePlatform;
    bundlePath: string;
    stageDir: string;
    productName: string;
  }
): Promise<void> {
  const { platform, bundlePath, stageDir, productName } = options;
  const workRoot = join(dirname(stageDir), 'downloads');
  await mkdir(workRoot, { recursive: true });
  const work = await mkdtemp(join(workRoot, `v${manifest.version}-`));
  try {
    const file = join(work, asset.file);
    const downloaded = await download(releaseAssetUrl(manifest.version, asset), file);
    if (downloaded.sha512 !== asset.sha512 || downloaded.size !== asset.size) {
      throw new Error('Downloaded release does not match its manifest');
    }
    const prepared = isMac(platform)
      ? await prepareMacApp(file, work, bundlePath, productName)
      : file;
    if (platform === 'linux-x64') await chmod(prepared, 0o755);

    // build.json goes last: the Reload button treats its presence as a complete stage.
    await rm(stageDir, { recursive: true, force: true });
    await mkdir(stageDir, { recursive: true });
    await rename(prepared, join(stageDir, stagedArtifactName(nodePlatform(platform), productName)));
    await writeFile(
      join(stageDir, 'build.json'),
      JSON.stringify({
        builtAt: manifest.releasedAt,
        commit: manifest.commit.slice(0, 9),
        version: manifest.version,
      })
    );
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

export function createPersonalUpdateService(electron: {
  isPackaged: boolean;
}): PersonalUpdateService {
  const appPath = runningAppPath();
  const platform = releasePlatform();
  return new PersonalUpdateService({
    enabled: IS_PERSONAL && electron.isPackaged && appPath !== null,
    platform,
    currentVersion: resolveAppVersion,
    fetchManifest: async () => {
      const response = await fetch(
        `https://github.com/${PERSONAL_RELEASES_REPO}/releases/latest/download/${PERSONAL_MANIFEST_ASSET}`,
        { headers: { 'Cache-Control': 'no-cache' } }
      );
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`Release manifest request failed: ${response.status}`);
      return response.json();
    },
    stagedVersion: async () => {
      try {
        const raw = JSON.parse(await readFile(join(PERSONAL_STAGE_DIR, 'build.json'), 'utf8'));
        return typeof raw?.version === 'string' ? raw.version : null;
      } catch {
        return null;
      }
    },
    stage: (manifest, asset) =>
      stageRelease(manifest, asset, {
        platform: platform!,
        bundlePath: appPath!,
        stageDir: PERSONAL_STAGE_DIR,
        productName: PRODUCT_NAME,
      }),
  });
}
