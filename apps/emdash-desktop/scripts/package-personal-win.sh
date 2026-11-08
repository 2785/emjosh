#!/usr/bin/env bash
# Builds Emjosh for 64-bit Windows into release/win-x64/Emjosh-win-x64.zip, on a Mac. Works in a
# scratch copy so this checkout's node_modules keep the host's native modules. JavaScript builds
# natively; the Windows native modules come prebuilt: node-pty ships them, better-sqlite3
# publishes Electron builds, and @parcel/watcher has a per-platform package.
#
# Builds the checked-out commit plus uncommitted changes to tracked files (not untracked ones).
set -euo pipefail
cd "$(dirname "$0")/.."

OUT="$PWD/release/win-x64"
WORK="${TMPDIR:-/tmp}/emjosh-win-x64"

# Same version rules as scripts/package-personal.sh; the scratch copy has no git metadata.
EMJOSH_VERSION="${EMJOSH_VERSION:-$(bash scripts/emjosh-version.sh)}"
export EMJOSH_VERSION="${EMJOSH_VERSION:-0.0.1}"

rm -rf "$WORK" "$OUT"
mkdir -p "$WORK" "$OUT"
root="$(git rev-parse --show-toplevel)"
# `git stash create` snapshots tracked changes as a commit without touching the stash list.
tree="$(git -C "$root" stash create)"
git -C "$root" archive --format=tar "${tree:-HEAD}" | tar -xf - -C "$WORK"

cd "$WORK"
# Also install the Windows x64 variants of platform-specific packages (@parcel/watcher's binary).
cat >>pnpm-workspace.yaml <<'YAML'
supportedArchitectures:
  os: [current, win32]
  cpu: [current, x64]
YAML
# Install scripts would build the native modules for this Mac.
pnpm install --frozen-lockfile --ignore-scripts

cd apps/emdash-desktop
module_dir() { node -p "require('path').dirname(require.resolve('$1/package.json'))"; }
electron_version="$(node -p "require('electron/package.json').version")"
(cd "$(module_dir better-sqlite3)" &&
  npx --yes prebuild-install --runtime electron --target "$electron_version" --arch x64 --platform win32)

EMJOSH_TARGET=win bash scripts/package-personal.sh

# Every native module the app loads on Windows must be a 64-bit Windows binary.
unpacked='release/win-unpacked/resources/app.asar.unpacked/node_modules'
for addon in better-sqlite3/build/Release/better_sqlite3.node \
  node-pty/prebuilds/win32-x64/pty.node \
  node-pty/prebuilds/win32-x64/conpty.node \
  @parcel/watcher-win32-x64/watcher.node; do
  file -b "$unpacked/$addon" | grep -q 'PE32+.*x86-64' || {
    echo "Not a Windows x64 binary: $addon ($(file -b "$unpacked/$addon" 2>&1))" >&2
    exit 1
  }
done
file -b release/win-unpacked/Emjosh.exe | grep -q 'PE32+.*x86-64'

cp release/Emjosh-win-x64.zip "$OUT/"
cd /
rm -rf "$WORK"
echo "Built $OUT/Emjosh-win-x64.zip"
