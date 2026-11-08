#!/usr/bin/env bash
# Builds Emjosh (macOS arm64 and Intel, Linux x64 in a container, Windows x64) from merged main
# and publishes it as a GitHub release of 2785/emjosh, where installed macOS and Linux copies pick
# it up (src/main/host/updates/personal-update.ts). Windows copies don't update themselves yet.
#
#   pnpm run release            # next patch version (the first release is 0.1.0)
#   pnpm run release minor      # or: major, or an explicit version such as 1.0.0
#   EMJOSH_SKIP_LINUX=1 pnpm run release   # macOS only
set -euo pipefail
cd "$(dirname "$0")/.."

REPO='2785/emjosh'
APP='release/mac-arm64/Emjosh.app'
OUT='release/publish'
ZIP_NAME='Emjosh-mac-arm64.zip'
INTEL_APP='release/mac-x64/Emjosh.app'
INTEL_ZIP_NAME='Emjosh-mac-x64.zip'
WINDOWS_INSTALLER='release/win-x64/Emjosh-win-x64-setup.exe'
APPIMAGE='release/linux-x64/Emjosh-linux-x64.AppImage'
LINUX_CONTEXT="${EMJOSH_LINUX_DOCKER_CONTEXT:-colima-emjosh-linux}"
# Keep in sync with PERSONAL_MANIFEST_ASSET in src/main/host/updates/personal-update.ts.
MANIFEST_NAME='emjosh-update.json'

# A GITHUB_TOKEN in the environment would take precedence over the keyring login.
gh_() { env -u GITHUB_TOKEN gh "$@"; }
die() {
  echo "$*" >&2
  exit 1
}

bump="${1:-patch}"

[ -z "$(git status --porcelain)" ] || die 'The working tree has changes; release from a clean checkout.'
git fetch -q origin main
commit="$(git rev-parse HEAD)"
[ "$commit" = "$(git rev-parse origin/main)" ] || die 'HEAD is not origin/main; release from merged main.'

# Release tags are emjosh-vX.Y.Z: upstream Emdash's vX.Y.Z tags may be in this checkout too.
latest="$(bash scripts/emjosh-version.sh)"
case "$bump" in
  [0-9]*.[0-9]*.[0-9]*) version="$bump" ;;
  patch | minor | major)
    if [ -z "$latest" ]; then
      version='0.1.0'
    else
      IFS=. read -r major minor patch <<<"$latest"
      case "$bump" in
        patch) version="$major.$minor.$((patch + 1))" ;;
        minor) version="$major.$((minor + 1)).0" ;;
        major) version="$((major + 1)).0.0" ;;
      esac
    fi
    ;;
  *) die "Unknown version bump '$bump': use patch, minor, major, or X.Y.Z." ;;
esac
tag="emjosh-v$version"
[ -z "$(git ls-remote --tags origin "refs/tags/$tag")" ] || die "$tag already exists."
if [ -z "${EMJOSH_SKIP_LINUX:-}" ]; then
  docker --context "$LINUX_CONTEXT" info >/dev/null 2>&1 ||
    die "Docker context '$LINUX_CONTEXT' is not running (colima start -p emjosh-linux), or set EMJOSH_SKIP_LINUX=1."
fi
echo "Releasing Emjosh $version (${latest:+after $latest, }commit ${commit:0:9})"

EMJOSH_VERSION="$version" pnpm run package:personal
EMJOSH_VERSION="$version" pnpm run package:personal:mac-x64
EMJOSH_VERSION="$version" pnpm run package:personal:win
[ -n "${EMJOSH_SKIP_LINUX:-}" ] || EMJOSH_VERSION="$version" pnpm run package:personal:linux

# Installed copies only accept updates signed by the identity they were signed with, so every
# release must use the same stable one.
# Captured first: `grep -q` stops reading early, and under pipefail codesign's SIGPIPE would
# fail the check.
for app in "$APP" "$INTEL_APP"; do
  signature="$(codesign -dvv "$app" 2>&1)"
  grep -q '^Authority=Apple Development: ' <<<"$signature" ||
    die "Releases must be signed with an Apple Development identity (see the README): $app"
  [ "$(plutil -extract CFBundleShortVersionString raw "$app/Contents/Info.plist")" = "$version" ] ||
    die "$app does not report version $version."
done

rm -rf "$OUT"
mkdir -p "$OUT"
ditto -c -k --sequesterRsrc --keepParent "$APP" "$OUT/$ZIP_NAME"
ditto -c -k --sequesterRsrc --keepParent "$INTEL_APP" "$OUT/$INTEL_ZIP_NAME"
cp "$WINDOWS_INSTALLER" "$OUT/"
assets=("$OUT/$ZIP_NAME" "$OUT/$INTEL_ZIP_NAME" "$OUT/$(basename "$WINDOWS_INSTALLER")")
if [ -z "${EMJOSH_SKIP_LINUX:-}" ]; then
  cp "$APPIMAGE" "$OUT/"
  assets+=("$OUT/$(basename "$APPIMAGE")")
fi

asset_json() {
  printf '{ "file": "%s", "sha512": "%s", "size": %s }' "$(basename "$1")" \
    "$(openssl dgst -sha512 -binary "$1" | base64)" "$(stat -f %z "$1")"
}
{
  printf '{\n  "version": "%s",\n  "commit": "%s",\n  "releasedAt": "%s",\n  "assets": {\n' \
    "$version" "$commit" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf '    "mac-arm64": %s' "$(asset_json "$OUT/$ZIP_NAME")"
  printf ',\n    "mac-x64": %s' "$(asset_json "$OUT/$INTEL_ZIP_NAME")"
  if [ -z "${EMJOSH_SKIP_LINUX:-}" ]; then
    printf ',\n    "linux-x64": %s' "$(asset_json "$OUT/$(basename "$APPIMAGE")")"
  fi
  printf '\n  }\n}\n'
} >"$OUT/$MANIFEST_NAME"

gh_ release create "$tag" "${assets[@]}" "$OUT/$MANIFEST_NAME" \
  --repo "$REPO" --target "$commit" --title "Emjosh $version" --generate-notes
echo "Published https://github.com/$REPO/releases/tag/$tag"
