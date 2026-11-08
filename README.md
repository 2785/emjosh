# Emjosh

**Emjosh is a shamelessly forked copy of [Emdash](https://github.com/generalaction/emdash).**

It's my personal build of Emdash with the features I want and the rough edges I care about
filed down. For the time being I'm not planning to contribute any of it back upstream; that
may change once I'm happy with it. It is intended for friends and family, not general
distribution.

The motivation: Meta acquired and shut down [Conductor](https://conductor.build), and I'd
rather not depend on a tool I don't control again. Emdash is open source (Apache-2.0), so
I have a copy I can keep running and shape however I like.

Emjosh is not affiliated with or endorsed by the Emdash team. Please don't report Emjosh
problems to them.

## What's different from Emdash

### Agents managing workspaces

- **Workspace tools for agents.** Every chat agent (and Claude in a terminal) gets an
  `emjosh` MCP server: list projects and workspaces (branch, agent status, PR state),
  describe and rename its own workspace, create workspaces (a new branch and worktree whose
  first prompt starts right away), and archive others. Agents are told to name their workspace
  as soon as they know what it's for, and to start workspaces in an initiative for changes that
  span repositories. Ask things like "archive the workspaces whose PRs
  merged" or "make workspaces in these four repos for the same change".
- **Initiatives.** Optional groups of workspaces across repositories working towards one goal.
  Group the sidebar by initiative, add tasks from their context menu (*Initiative…*), or let
  agents create and fill them.
- **Workspaces talking to each other.** Each initiative has a message feed: agents post to
  everyone or one workspace and read or wait for replies; Emjosh adds events (a workspace
  finished, needs approval, failed). Messages can be delivered straight into each workspace's
  chat, labelled as coming from a peer: on for initiatives agents create, and a toggle in the
  initiative's menu.
- **External agents.** Settings → General → *Connect an external agent* copies a
  `claude mcp add` command so a `claude` outside Emjosh can use the same tools while Emjosh
  is open.

### Chat

- **Steer the agent mid-turn.** Settings → General → *Messages sent while agent is working*:
  *Steer* (the default) hands your message (merged with anything queued) to the running agent
  right away, so it adjusts course without stopping; *Queue* (Emdash's behavior) waits for the
  turn to end. Agents that can't take messages mid-turn stop and run it next.
- **Inline attachment references.** Pasted or dropped images get an `[Image 1]` pill where
  your cursor is, and the agent sees which image is which; long pasted text collapses into a
  `[Snippet 1]` pill that still sends the full text in place.

### Sidebar and workspaces

- **Group by project, initiative, or nothing.** The sort menu's *Group by* lists every task in
  one cross-repo list (labelled with its project), optionally split by initiative. Without
  project rows, the sidebar header's **+** opens a searchable project picker for a new task.
- **"Last used" means real activity.** Tasks move up when a prompt is sent or a turn finishes
  or needs you, not when you click into them.
- **Workspaces name themselves.** Agents name their workspace once, as soon as they know what
  it's for, and keep that name through follow-ups (renaming only if you ask or the work turns
  into something unrelated). A workspace still on its placeholder name takes its first
  conversation's title; names you chose are never touched. Names are plain text ("Synctera
  tenant 1_1 AR/AP"), not branch-style slugs: the branch is fixed when a workspace is created.
- **More reliable agent status.** Fewer conversations stuck spinning or wrongly flagged as
  waiting for you (after reopening a chat, a restart, or an interrupted turn).

### App

- **Window frame color.** Settings → Interface → *Window frame color* tints the title bar and
  sidebar (darker in dark mode, brighter in light mode) so the window is easy to spot.
- **Remembered link choice.** "Open link?" can remember in-app vs. default browser
  (Settings → Interface → *Open links in*).
- **Its own app, on macOS, Linux, and Windows.** It installs next to Emdash, with its own data
  (`~/Library/Application Support/emjosh` on macOS), keychain entry, and icon. On macOS and
  Linux it updates from [Emjosh releases](https://github.com/2785/emjosh/releases), never from
  Emdash's.
- **Reload button.** When a new release has been downloaded, or you've built one yourself,
  the sidebar shows *Reload · new build* (also Emjosh → Reload Emjosh); click it to restart on
  it.
- **No Emdash branding or services.** Emjosh never contacts Emdash's servers: no Emdash
  account (sessions copied from Emdash aren't sent anywhere), telemetry, feedback, updates, or
  docs. GitHub connects through the `gh` CLI's login and GitLab through an access token, not
  Emdash's OAuth apps. Remote (SSH) hosts need a workspace-server download location, which
  Emdash hosts and Emjosh doesn't yet, so they are off unless you set
  `EMDASH_WORKSPACE_SERVER_ARTIFACTS_URL`.

## Install

### macOS

Download `Emjosh-mac-arm64.zip` (Apple Silicon) or `Emjosh-mac-x64.zip` (Intel) from the
[latest release](https://github.com/2785/emjosh/releases/latest), unzip it, and move
`Emjosh.app` to Applications.

Releases are signed but not notarized by Apple, so the first launch is blocked with "Apple could
not verify…". Right-click `Emjosh.app` → *Open* → *Open* once (or allow it under System Settings →
Privacy & Security). After that it opens normally.

### Linux (x64)

Download `Emjosh-linux-x64.AppImage` from the
[latest release](https://github.com/2785/emjosh/releases/latest), make it executable, and run
it:

```bash
chmod +x Emjosh-linux-x64.AppImage
./Emjosh-linux-x64.AppImage
```

Keep it somewhere you can write to (for example `~/Applications`): updates replace that file.
Some distributions need `libfuse2` to run AppImages. On Ubuntu 24.04 and later, AppArmor
blocks the Chromium sandbox that Electron apps use; if Emjosh exits with a sandbox error,
start it with `--no-sandbox`.

### Windows (x64)

Download `Emjosh-win-x64.zip` from the
[latest release](https://github.com/2785/emjosh/releases/latest), unzip it somewhere permanent
(for example `%LOCALAPPDATA%\Programs\Emjosh`), and run `Emjosh.exe`. The build isn't signed, so
SmartScreen warns on first launch: *More info* → *Run anyway*. Windows copies don't update
themselves yet; download each new release.

### Coming from Emdash (macOS)

Copy your projects, tasks, and conversations over once, with Emjosh closed (needs a clone of
this repository and `pnpm`):

```bash
pnpm --dir apps/emdash-desktop run seed:emjosh
```

Saved sign-ins come along too: on first launch Emjosh asks once to read Emdash's keychain
key and re-encrypts them under its own.

## Updating

Emjosh checks for new releases every hour and downloads them in the background; the sidebar
button then reads *Reload · new build*. Click it to restart on the new version.

Only the repository owner can publish releases, and every download must match the checksum
in the release's manifest. On macOS, updates must also be signed with the same certificate as
the running app. Linux has no equivalent of app signing, so there the trust rests on the
GitHub account.

## Building it yourself

You need `pnpm` (any version; the repo pins its own pnpm and Node) and the Xcode command line
tools (`xcode-select --install`).

```bash
git clone https://github.com/2785/emjosh.git
cd emjosh
pnpm install
pnpm --dir apps/emdash-desktop run install:personal
```

That builds `/Applications/Emjosh.app` and opens it, or, if Emjosh is running, stages the build
for its Reload button.

Signing: if your keychain has an **Apple Development** certificate (free with any Apple ID:
Xcode → Settings → Accounts → Manage Certificates → + → Apple Development), builds are signed
with it and macOS keeps your keychain approvals across rebuilds. Otherwise the first build
creates a self-signed "Emjosh Local Signing" certificate, and macOS asks for keychain access
once after each rebuild. Self-built copies still receive release updates only if they're signed
with the release certificate.

## Releasing

From a clean checkout of merged `main`, signed in to `gh` as the repository owner:

```bash
pnpm --dir apps/emdash-desktop run release          # next patch version
pnpm --dir apps/emdash-desktop run release minor    # or major, or an explicit X.Y.Z
```

It builds and signs the macOS app, builds the Linux x64 AppImage in a Docker container, then
publishes both and an update manifest as a GitHub release. Release tags can't be moved or
deleted.

The Linux build needs Docker; on Apple Silicon, create a Colima profile once
(`colima start -p emjosh-linux --vm-type vz`) and start it before releasing.
`EMJOSH_SKIP_LINUX=1` releases macOS only. To build just the AppImage:
`pnpm --dir apps/emdash-desktop run package:personal:linux`.

## Development

The codebase is Emdash's: an Electron + React app in a pnpm/Nx monorepo. The Electron app
lives in `apps/emdash-desktop/`, shared packages in `packages/`. Start with
[AGENTS.md](AGENTS.md) for architecture and conventions; the full gate is `pnpm run check`.

## Credit and license

All the hard work is Emdash's, by [General Action](https://github.com/generalaction) and its
contributors. Go use [Emdash](https://emdash.sh) if you want the real, supported thing.

Emjosh is distributed under the same [Apache-2.0 license](LICENSE.md). Files have been modified
from the Emdash originals; see this repository's commit history for the changes.
