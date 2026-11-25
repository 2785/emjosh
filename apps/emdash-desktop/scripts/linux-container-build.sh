#!/usr/bin/env bash
# Runs inside the arm64 Linux container started by scripts/package-personal-linux.sh, with the
# source tree in /src and the output directory at /out. Builds an x64 AppImage without running
# x64 code (emulated Go tools such as esbuild crash): JavaScript is built natively, and the
# x64 native modules are downloaded prebuilt or cross-compiled.
set -euo pipefail

apt-get update -qq
apt-get install -y -qq g++-x86-64-linux-gnu binutils-x86-64-linux-gnu >/dev/null

cd /src
npm install -g pnpm@10.28.2 >/dev/null
pnpm config set store-dir /pnpm-store
# Also install the x64 Linux variants of platform-specific packages (@parcel/watcher's binary).
cat >>pnpm-workspace.yaml <<'YAML'
supportedArchitectures:
  os: [current]
  cpu: [current, x64]
  libc: [glibc]
YAML
# pnpm's linking sometimes fails here with ENOENT renaming a temporary directory (seen with
# esbuild-register's nested esbuild); a second run finishes the install.
pnpm install --frozen-lockfile --ignore-scripts || pnpm install --frozen-lockfile --ignore-scripts

cd apps/emdash-desktop
node ../../tooling/scripts/ensure-packages-built.mjs
# The renderer bundle needs more heap than Node's default in a container.
NODE_OPTIONS=--max-old-space-size=6144 VITE_BUILD=personal pnpm exec electron-vite build
missing=$(grep -rL --include='*.js' '"VITE_BUILD": "personal"' out/main/index.js out/main/chunks out/renderer/assets |
  xargs grep -l '__vite_import_meta_env__ = {' 2>/dev/null || true)
if [ -n "$missing" ]; then
  echo "Built without VITE_BUILD=personal: $missing" >&2
  exit 1
fi

electron_version="$(node -p "require('electron/package.json').version")"
module_dir() { node -p "require('path').dirname(require.resolve('$1/package.json'))"; }

# better-sqlite3: upstream's prebuilt binary for Electron on Linux x64.
(cd "$(module_dir better-sqlite3)" &&
  npx --yes prebuild-install --runtime electron --target "$electron_version" --arch x64 --platform linux)

# node-pty: an N-API addon with no Linux prebuilds, so cross-compile it.
(cd "$(module_dir node-pty)" &&
  CC=x86_64-linux-gnu-gcc CXX=x86_64-linux-gnu-g++ LINK=x86_64-linux-gnu-g++ \
    npx --yes node-gyp rebuild --arch=x64)

for addon in "$(module_dir better-sqlite3)/build/Release/better_sqlite3.node" \
  "$(module_dir node-pty)/build/Release/pty.node"; do
  file "$addon" | grep -q 'x86-64' || {
    echo "Not an x64 binary: $(file "$addon")" >&2
    exit 1
  }
done

pnpm exec electron-builder --linux --x64 --publish never --config electron-builder.personal.config.ts

appimage='release/Emjosh-linux-x64.AppImage'
# What upstream's release verification checks, on the unpacked app the AppImage was made from
# (running the x64 AppImage would need emulation): the x64 native modules are there, built
# against glibc no newer than 2.35.
for name in better_sqlite3.node pty.node watcher.node; do
  found="$(find release/linux-unpacked -name "$name" | head -1)"
  [ -n "$found" ] || {
    echo "The AppImage is missing $name" >&2
    exit 1
  }
  file "$found" | grep -q 'x86-64' || {
    echo "$name is not x64: $(file "$found")" >&2
    exit 1
  }
  newest="$(x86_64-linux-gnu-objdump -T "$found" | grep -o 'GLIBC_[0-9.]*' | sort -Vu | tail -1)"
  echo "$name: x86-64, needs ${newest:-no versioned glibc}"
  [ "$(printf '%s\n' "${newest#GLIBC_}" 2.35 | sort -V | tail -1)" = 2.35 ] || {
    echo "$name needs $newest, newer than 2.35" >&2
    exit 1
  }
done

cp "$appimage" /out/
