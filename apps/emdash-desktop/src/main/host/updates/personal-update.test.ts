import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isNewerVersion,
  parseReleaseManifest,
  PersonalUpdateService,
  releaseAssetUrl,
  releasePlatform,
  stageRelease,
  type PersonalUpdateDeps,
} from './personal-update';

vi.mock('@main/lib/logger', () => ({
  log: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@main/core/app/utils', () => ({ resolveAppVersion: vi.fn() }));

const macAsset = { file: 'Emjosh-mac-arm64.zip', sha512: 'abc==', size: 123 };
const linuxAsset = { file: 'Emjosh-linux-x64.AppImage', sha512: 'def==', size: 456 };
const intelAsset = { file: 'Emjosh-mac-x64.zip', sha512: 'ghi==', size: 789 };
const windowsAsset = { file: 'Emjosh-win-x64-setup.exe', sha512: 'jkl==', size: 1011 };
const manifest = {
  version: '0.2.0',
  commit: '0123456789abcdef',
  releasedAt: '2026-11-05T00:00:00Z',
  assets: {
    'mac-arm64': macAsset,
    'mac-x64': intelAsset,
    'linux-x64': linuxAsset,
    'win-x64': windowsAsset,
  },
};

function makeService(overrides: Partial<PersonalUpdateDeps> = {}) {
  const deps: PersonalUpdateDeps = {
    enabled: true,
    platform: 'mac-arm64',
    currentVersion: async () => '0.1.0',
    fetchManifest: async () => manifest,
    stagedVersion: async () => null,
    stage: vi.fn(async () => {}),
    ...overrides,
  };
  return { service: new PersonalUpdateService(deps), deps };
}

describe('isNewerVersion', () => {
  it('compares x.y.z numerically', () => {
    expect(isNewerVersion('0.10.0', '0.9.9')).toBe(true);
    expect(isNewerVersion('1.0.0', '0.99.99')).toBe(true);
    expect(isNewerVersion('0.1.0', '0.1.0')).toBe(false);
    expect(isNewerVersion('0.1.0', '0.2.0')).toBe(false);
  });

  it('never treats unparseable versions as newer', () => {
    expect(isNewerVersion('0.2.0-beta', '0.1.0')).toBe(false);
    expect(isNewerVersion('0.2.0', 'unknown')).toBe(false);
  });
});

describe('parseReleaseManifest', () => {
  it('accepts a complete manifest', () => {
    expect(parseReleaseManifest(manifest)).toEqual(manifest);
  });

  it('accepts a release for only some platforms', () => {
    const macOnly = { ...manifest, assets: { 'mac-arm64': macAsset } };
    expect(parseReleaseManifest(macOnly)).toEqual(macOnly);
  });

  it('rejects asset names that could leave the release or have the wrong kind', () => {
    for (const assets of [
      { 'mac-arm64': { ...macAsset, file: '../evil.zip' } },
      { 'mac-arm64': { ...macAsset, file: 'Emjosh.dmg' } },
      { 'linux-x64': { ...linuxAsset, file: 'Emjosh.zip' } },
      { 'win-x64': { ...windowsAsset, file: 'Emjosh.msi' } },
    ]) {
      expect(parseReleaseManifest({ ...manifest, assets })).toBeNull();
    }
  });

  it('rejects missing fields and odd versions', () => {
    expect(
      parseReleaseManifest({ ...manifest, assets: { 'mac-arm64': { ...macAsset, sha512: 1 } } })
    ).toBeNull();
    expect(parseReleaseManifest({ ...manifest, assets: undefined })).toBeNull();
    expect(parseReleaseManifest({ ...manifest, version: 'v0.2.0' })).toBeNull();
    expect(parseReleaseManifest(null)).toBeNull();
  });
});

describe('releaseAssetUrl', () => {
  it("points at the asset of the release's emjosh-v tag", () => {
    expect(releaseAssetUrl('0.2.0', macAsset)).toBe(
      'https://github.com/2785/emjosh/releases/download/emjosh-v0.2.0/Emjosh-mac-arm64.zip'
    );
  });
});

describe('releasePlatform', () => {
  it('maps the platforms Emjosh is released for', () => {
    expect(releasePlatform('darwin', 'arm64')).toBe('mac-arm64');
    expect(releasePlatform('linux', 'x64')).toBe('linux-x64');
    expect(releasePlatform('darwin', 'x64')).toBe('mac-x64');
    expect(releasePlatform('linux', 'arm64')).toBeNull();
    expect(releasePlatform('win32', 'x64')).toBe('win-x64');
    expect(releasePlatform('win32', 'arm64')).toBeNull();
  });
});

describe('PersonalUpdateService', () => {
  it("stages a newer release's build for this platform", async () => {
    const { service, deps } = makeService();
    await expect(service.check()).resolves.toEqual({ status: 'staged', version: '0.2.0' });
    expect(deps.stage).toHaveBeenCalledWith(manifest, macAsset);

    const linux = makeService({ platform: 'linux-x64' });
    await linux.service.check();
    expect(linux.deps.stage).toHaveBeenCalledWith(manifest, linuxAsset);

    const intel = makeService({ platform: 'mac-x64' });
    await intel.service.check();
    expect(intel.deps.stage).toHaveBeenCalledWith(manifest, intelAsset);
  });

  it('skips releases without a build for this platform', async () => {
    const { service, deps } = makeService({
      platform: 'linux-x64',
      fetchManifest: async () => ({ ...manifest, assets: { 'mac-arm64': macAsset } }),
    });
    await expect(service.check()).resolves.toMatchObject({ status: 'up-to-date' });
    expect(deps.stage).not.toHaveBeenCalled();
  });

  it('leaves the app alone when the release is not newer', async () => {
    const { service, deps } = makeService({ currentVersion: async () => '0.2.0' });
    await expect(service.check()).resolves.toMatchObject({ status: 'up-to-date' });
    expect(deps.stage).not.toHaveBeenCalled();
  });

  it('does not download a release that is already waiting for Reload', async () => {
    const { service, deps } = makeService({ stagedVersion: async () => '0.2.0' });
    await expect(service.check()).resolves.toEqual({
      status: 'already-staged',
      version: '0.2.0',
    });
    expect(deps.stage).not.toHaveBeenCalled();
  });

  it('treats no release or an invalid manifest as up to date', async () => {
    for (const fetched of [null, { version: '9.9.9' }]) {
      const { service, deps } = makeService({ fetchManifest: async () => fetched });
      await expect(service.check()).resolves.toMatchObject({ status: 'up-to-date' });
      expect(deps.stage).not.toHaveBeenCalled();
    }
  });

  it('does nothing when disabled or on platforms without releases', async () => {
    for (const overrides of [{ enabled: false }, { platform: null }]) {
      const { service, deps } = makeService(overrides);
      await expect(service.check()).resolves.toEqual({ status: 'disabled' });
      expect(deps.stage).not.toHaveBeenCalled();
    }
  });

  it('reports the running version when up to date', async () => {
    const { service } = makeService({ currentVersion: async () => '0.2.0' });
    await expect(service.check()).resolves.toEqual({ status: 'up-to-date', current: '0.2.0' });
  });

  it('tells the caller before downloading, and only then', async () => {
    const onDownloading = vi.fn();
    const { service } = makeService();
    await service.check({ onDownloading });
    expect(onDownloading).toHaveBeenCalledWith('0.2.0');

    const staged = makeService({ stagedVersion: async () => '0.2.0' });
    const notCalled = vi.fn();
    await staged.service.check({ onDownloading: notCalled });
    expect(notCalled).not.toHaveBeenCalled();
  });

  it('shares one check between concurrent callers', async () => {
    const { service, deps } = makeService();
    await Promise.all([service.check(), service.check()]);
    expect(deps.stage).toHaveBeenCalledTimes(1);
  });
});

const releaseInfo = {
  version: '0.2.0',
  commit: '0123456789abcdef',
  releasedAt: '2026-11-05T00:00:00Z',
};

describe('stageRelease on Linux', () => {
  const roots: string[] = [];
  afterEach(() => {
    vi.unstubAllGlobals();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function setup(bytes: Buffer) {
    const root = mkdtempSync(join(tmpdir(), 'emjosh-update-linux-'));
    roots.push(root);
    const asset = {
      file: 'Emjosh-linux-x64.AppImage',
      sha512: createHash('sha512').update(bytes).digest('base64'),
      size: bytes.length,
    };
    const fetched: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      fetched.push(url);
      return new Response(new Uint8Array(bytes));
    });
    const stageDir = join(root, 'cache', 'staged');
    const options = {
      platform: 'linux-x64' as const,
      bundlePath: join(root, 'Emjosh.AppImage'),
      stageDir,
      productName: 'Emjosh',
    };
    return { asset, options, stageDir, fetched };
  }

  it('stages the AppImage, executable, from its tagged asset', async () => {
    const bytes = Buffer.from('#!/bin/sh\necho new\n');
    const { asset, options, stageDir, fetched } = setup(bytes);
    await stageRelease({ ...releaseInfo, assets: { 'linux-x64': asset } }, asset, options);

    expect(fetched).toEqual([releaseAssetUrl('0.2.0', asset)]);
    const staged = join(stageDir, 'Emjosh.AppImage');
    expect(readFileSync(staged)).toEqual(bytes);
    expect(statSync(staged).mode & 0o111).not.toBe(0);
    expect(JSON.parse(readFileSync(join(stageDir, 'build.json'), 'utf8'))).toMatchObject({
      version: '0.2.0',
    });
  });

  it('rejects a download that does not match the manifest', async () => {
    const { asset, options, stageDir } = setup(Buffer.from('tampered'));
    await expect(
      stageRelease(releaseInfo as never, { ...asset, size: 1 }, options)
    ).rejects.toThrow('does not match its manifest');
    expect(existsSync(stageDir)).toBe(false);
  });
});

describe.runIf(process.platform === 'darwin')('stageRelease', () => {
  const roots: string[] = [];
  afterEach(() => {
    vi.unstubAllGlobals();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  /** An ad-hoc signed `Emjosh.app`; `marker` makes each one a different signed program. */
  function makeApp(dir: string, marker: string): string {
    const app = join(dir, 'Emjosh.app');
    mkdirSync(join(app, 'Contents', 'MacOS'), { recursive: true });
    cpSync('/usr/bin/true', join(app, 'Contents', 'MacOS', 'Emjosh'));
    execFileSync('plutil', ['-create', 'xml1', join(app, 'Contents', 'Info.plist')]);
    for (const [key, value] of [
      ['CFBundleIdentifier', `com.emjosh.test.${marker}`],
      ['CFBundleExecutable', 'Emjosh'],
    ]) {
      execFileSync('plutil', [
        '-insert',
        key!,
        '-string',
        value!,
        join(app, 'Contents', 'Info.plist'),
      ]);
    }
    execFileSync('codesign', ['--force', '--sign', '-', app]);
    return app;
  }

  function setup(releaseMarker: string) {
    const root = mkdtempSync(join(tmpdir(), 'emjosh-update-'));
    roots.push(root);
    const running = makeApp(join(root, 'running'), 'same');
    const release = join(root, 'release');
    mkdirSync(release);
    if (releaseMarker === 'same') cpSync(running, join(release, 'Emjosh.app'), { recursive: true });
    else makeApp(release, releaseMarker);
    const zip = join(root, 'Emjosh-mac-arm64.zip');
    execFileSync('ditto', ['-c', '-k', '--keepParent', join(release, 'Emjosh.app'), zip]);
    const bytes = readFileSync(zip);
    const asset = {
      file: 'Emjosh-mac-arm64.zip',
      sha512: createHash('sha512').update(bytes).digest('base64'),
      size: bytes.length,
    };
    const manifest = { ...releaseInfo, assets: { 'mac-arm64': asset } };
    const fetched: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      fetched.push(url);
      return new Response(bytes);
    });
    const stageDir = join(root, 'cache', 'staged');
    const options = {
      platform: 'mac-arm64' as const,
      bundlePath: running,
      stageDir,
      productName: 'Emjosh',
    };
    return { manifest, asset, options, stageDir, fetched };
  }

  it('stages a release signed like the running app, from its tagged asset', async () => {
    const { manifest, asset, options, stageDir, fetched } = setup('same');
    await stageRelease(manifest, asset, options);
    expect(fetched).toEqual([releaseAssetUrl('0.2.0', asset)]);
    expect(existsSync(join(stageDir, 'Emjosh.app', 'Contents', 'MacOS', 'Emjosh'))).toBe(true);
    expect(JSON.parse(readFileSync(join(stageDir, 'build.json'), 'utf8'))).toEqual({
      builtAt: '2026-11-05T00:00:00Z',
      commit: '012345678',
      version: '0.2.0',
    });
  });

  it('rejects a release signed by anyone else', async () => {
    const { manifest, asset, options, stageDir } = setup('other');
    await expect(stageRelease(manifest, asset, options)).rejects.toThrow();
    expect(existsSync(stageDir)).toBe(false);
  });

  it('rejects a download that does not match the manifest', async () => {
    const { manifest, asset, options, stageDir } = setup('same');
    await expect(stageRelease(manifest, { ...asset, sha512: 'bogus' }, options)).rejects.toThrow(
      'does not match its manifest'
    );
    expect(existsSync(stageDir)).toBe(false);
  });
});
