# Changelog

Changes Emjosh makes on top of [Emdash](https://github.com/generalaction/emdash), by release.
Upstream Emdash changes are not listed.

## 0.1.16 — 2026-11-10

- Much faster typing, scrolling and switching with many workspaces: the main process no
  longer re-checks every workspace on each change, PR badges and the composer re-render far
  less, and syntax highlighting can no longer stall the window.
- Chats show their saved history instantly while the agent session starts.
- The sidebar shows each project's 15 most recent workspaces, with *Show more*; active ones
  always stay listed. Initiatives list all their members.
- Faster launch: smaller renderer bundle, automations start after the window.
- *Record UI Performance Profile* (command palette) writes a report of what is slow.

## 0.1.15 — 2026-11-10

- Fixed workspaces stuck as running after Claude worked on its own (e.g. after a background
  task), and messages delivered then never being answered.

## 0.1.14 — 2026-11-10

- Messages queued during a turn go to the agent together, as one message.

## 0.1.13 — 2026-11-10

- Initiatives get a dedicated lead workspace that only orchestrates; it hears everything,
  and everyone hears its broadcasts. The lead heads its initiative in the sidebar.
- Workspaces agents create start with the creating chat's permission mode.

## 0.1.12 — 2026-11-10

- Fixed workspaces stuck as running when a background agent finished mid-turn.

## 0.1.11 — 2026-11-09

- Initiative messaging is opt-in: workspaces subscribe to the broadcasts and status events
  they need.

## 0.1.10 — 2026-11-09

- Agents can add, clone, rename and remove projects.

## 0.1.9 — 2026-11-09

- Paste screenshots into the New Task dialog; Enter creates the task (configurable).
- Agents name workspaces in plain words.

## 0.1.8 — 2026-11-07

- Windows x64 installer.
- Notifications only while Emjosh is in the background (default).

## 0.1.7 — 2026-11-05

- Sidebar, activity badge, composer and initiative polish; LoC counts off and Steer on by
  default.

## 0.1.6 — 2026-11-05

- Intel Mac builds and updates.

## 0.1.5 — 2026-11-05

- Workspace names are plain text, not branch slugs.

## 0.1.4 — 2026-11-05

- Workspaces keep their name through follow-ups.

## 0.1.3 — 2026-11-05

- Window controls on Linux views without a title bar.

## 0.1.2 — 2026-11-05

- *Check for Updates* and the version in the sidebar.

## 0.1.1 — 2026-11-05

- The mid-turn follow-up mode is called Steer.
- Agents are told to name workspaces early, split cross-repo work into initiatives, and wait
  in the background.

## 0.1.0 — 2026-11-05

First release.

- Agents manage workspaces through an `emjosh` MCP server: list, create, rename, archive.
- Initiatives: groups of workspaces across repositories with a shared message feed.
- Steer a running agent; inline `[Image]` and `[Snippet]` references in the composer.
- Group the sidebar by project, initiative or nothing; New Task project picker.
- Its own app, data and updates on macOS (Apple silicon) and Linux; no Emdash services.
