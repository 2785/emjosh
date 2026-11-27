# Changelog

Changes Emjosh makes on top of [Emdash](https://github.com/generalaction/emdash), by release.
Upstream Emdash changes are not listed.

## 0.1.29 — 2026-11-27

- The "Waiting on a command" notice appears only once a command has run for 10 seconds (it was
  meant to be 20, and a clock bug made it show straight away for any command in a chat that had
  been open a while), so short commands no longer flash it.

## 0.1.28 — 2026-11-27

Fixes taken from upstream Emdash since we forked (the rest of upstream, such as the 2.0 waitlist
card and the dependency bumps, is deliberately not taken):

- Worktree changes rescan only the changed worktree instead of all of them, which matters with
  many worktrees.
- SSH connections turn off Nagle's algorithm, which cuts latency on interactive sessions.
- The packaged app resolves `ssh2` through its real entry, a fix for packaged (notably Windows)
  builds.
- The legacy v0 import runs in one synchronous transaction.

## 0.1.27 — 2026-11-26

- When an agent's turn is waiting on a shell command that has run for 20 seconds or more, the chat
  box shows the command and how long it has run, with a Stop button. (Antigravity keeps a turn
  open while its command runs, so a command stuck on a prompt looked like an agent still working.)
- Initiative messages no longer wait for a busy agent's turn to end (or sit in a ten-minute hold).
  After the short batching delay they go into the running turn when the agent supports steering
  (Claude, Codex and Antigravity do); if not, they queue and run together when the turn ends.
  Nothing is cancelled.
- Linux: the projects and settings views no longer show two title bars (a plain one was stacked on
  top of their own).
- Linux under a tiling window manager (sway, i3, Hyprland, niri and similar; detected from the
  session) the app no longer draws its own minimize/maximize/close buttons. Set
  `EMJOSH_WINDOW_CONTROLS=always` or `never` to override.

## 0.1.26 — 2026-11-26

- Antigravity: a message sent while it is working now steers the running turn instead of
  cancelling it.
- The live "Thinking" preview grows to fit the text (up to about 240 px) instead of showing three
  lines.
- Phone: workspace times show how long ago the work really happened (database times were read in
  the wrong time zone, so rows said "now" for hours) and sort correctly; the chat box keeps its
  attach, usage and send buttons on screen on a narrow screen, with the model and mode selectors
  wrapping.
- `create_workspace` checks the initiative and label before starting anything, so a stale id no
  longer leaves a running workspace behind an error (which made agents retry into duplicates). If
  joining the initiative fails afterwards, the error says the workspace exists.
- `create_workspace` works in a repository without a git remote (it no longer tries to publish the
  branch) and passes on the real reason when provisioning fails.

## 0.1.25 — 2026-11-26

- The app database can no longer be wiped by the import step. The import refuses to clear a
  database that already has projects or tasks, an empty `emdash.db` placeholder no longer counts as
  something to import, a database that already has data is marked as not needing the import, and
  the personal build never offers it.
- The app database is copied to a `backups` folder beside it before startup migrations (at most
  every six hours, keeping the last 14), and before any import that is allowed to replace data.
- Starting a Claude terminal chat with a prompt that begins with `@name` (or contains text that
  looks like a flag value) no longer fails with "name too long"; the prompt now goes after `--`.

## 0.1.24 — 2026-11-25

- Find a workspace from free text: Cmd+Shift+K or "Find Workspace" opens a search that matches
  names, branches, PR/MR URLs and numbers, ids, ticket ids, projects and initiatives instantly,
  archived workspaces included (unarchiving asks first). When that isn't enough, "Ask an agent"
  runs a quick read-only search through workspaces, initiative feeds and chats, and lists several
  ranked matches with a reason each, favouring active and recent workspaces. It shows its steps and
  elapsed time and can be cancelled.
- Cmd+K offers "Ask an agent to find …" for URLs, PR numbers, tickets and longer descriptions, and
  shows instant workspace matches (PR, branch, id, ticket, archived) inline.
- Agents name workspaces as links (`emjosh://workspace/<id>`). Chats show them as chips with a
  tooltip (name, project, status) that open the workspace, asking before unarchiving. Links to
  unknown workspaces show as plain text. Links that aren't web or workspace links no longer open a
  blank window.
- Initiative workspaces get short labels, shown in the sidebar and the initiative feed; labels in
  feed messages open the workspace.
- A new Agent CLIs settings page shows the installed version of each agent CLI and updates them.
- Packaging fails when the packaged app lacks the native SQLite module, instead of producing an
  app that can't start.

## 0.1.23 — 2026-11-25

- A Claude chat whose turn has ended while background shell commands or background agents it
  started are still running shows a new "Waiting on background work" status (a slowly turning
  dashed ring) instead of done. It turns into done when the work finishes. Work with no reported
  end clears after an hour. These chats don't get an automatic "keep going" after a restart.
- The initiative lead is no longer asked to fold workspaces whose branch is already merged into
  its base.

## 0.1.22 — 2026-11-25

- A message to the initiative lead sent without a kind now wakes the lead, so agents whose
  sessions started before kinds existed still get their reports through. Only messages marked fyi
  stay quiet.
- The initiative feed labels the app's own events "Emjosh" instead of "You".

## 0.1.21 — 2026-11-25

Antigravity and Codex:
- Antigravity chats now run as structured chats with the emjosh tools. Their model, thinking level
  and mode lists come from the Antigravity CLI.
- Antigravity follows Emjosh's workspace instructions (renaming the workspace, initiative messages).
- Antigravity shows working and done correctly, including when it wakes itself up for background
  work.
- Antigravity has a "Bypass permissions" mode with no approval prompts. In Auto mode, emjosh tools no
  longer ask.
- Antigravity works with Google sign-in, gcloud credentials (`AGY_ADC_AUTH=true`) or a Gemini API key.
- Codex: the chat stays "working" through /goal and other work Codex starts on its own, and says done
  once at the end.
- Codex: new chats follow Emjosh's workspace instructions.
- Codex: full access now applies to work Codex starts on its own, so emjosh tools and goal steps no
  longer ask for approval.
- Codex: the model list matches the installed Codex CLI.
- The sidebar shows a small agent logo next to workspaces that run an agent other than your default
  (e.g. Codex or Antigravity). Workspaces on the default agent stay unmarked; changing the default
  agent in Settings changes which workspaces show one.

Restarts and environment:
- Chat agents that were working when Emjosh quit, reloaded or crashed now get an automatic "keep
  going" message when the app comes back, so they pick up where they left off. Turn it off with
  "Keep agents going after a restart" under Settings > General > Preferences.
- Editors and tools opened from Emjosh (e.g. Open in Zed) get your shell environment, so
  NODE_ENV=production no longer leaks into their terminals and breaks hot reload.
- Agents no longer see ELECTRON_RUN_AS_NODE=1 in their shells.

Initiatives:
- Initiative workspaces can depend on each other: the lead records the order with
  set_workspace_dependencies, and the sidebar numbers the workspaces involved and shows what each is
  waiting on.
- Dependencies clear themselves when the workspace they point at is archived or already part of the
  dependent's branch. When one only looks done (PR merged, branch merged, marked done), the lead is
  asked.
- Workspaces can be marked done from the sidebar menu or with mark_workspace_done.
- When one workspace's branch is contained in another's, the lead is told and can fold them with
  merge_workspaces: the folded workspace hands over a summary of its context and is archived.
- Workspaces in the middle of a rebase or merge are left alone until their branch is checked out
  again.
- Initiative leads are only woken for what needs them: members' done, blocked and decision messages,
  the user's posts, and members waiting for approval or stopped with an error. Status events and fyi
  messages are kept for read_messages and list_workspaces.
- Messages that do wake an agent arrive bundled into one prompt instead of one turn each, and wait
  while the agent is mid-turn.
- In the chat, turns that only handle initiative activity collapse into an expandable "Initiative
  activity (N)" row; the agent's reply to the user stays visible.

Also:
- Windows copies now update themselves: Emjosh downloads new releases and installs them when you
  click Reload. Install this release by hand once.
- App API: reading live app state (such as a conversation's session state and pending approvals)
  works.

## 0.1.20 — 2026-11-23

- Fixed the gap before inline code, links and mentions in chat (and lines wrapping early).

## 0.1.19 — 2026-11-19

- Agents can unarchive workspaces.
- Agents can do anything the app's UI can through Emjosh's MCP tools: settings, automations,
  MCP servers, skills, the prompt library, project settings, conversations, terminals and more
  (`app_api_list`, `app_api_describe`, `app_api_call`, `app_api_read`).

## 0.1.18 — 2026-11-18

- Fixed workspaces left spinning after their background agents had finished.

## 0.1.17 — 2026-11-17

- Remote control: use Emjosh from your phone or another computer over Tailscale, with push
  notifications when workspaces finish or need you, and a dedicated phone layout.
- Copying from chat keeps formatting (lists, code, emphasis) when pasted into Slack or docs,
  and code keeps its line breaks; dragging past the text no longer jumps the selection.
- Tables get copy and wrap buttons; diagrams get a copy button.
- Settings for chat width and wrapping code blocks.
- Deleting an image's pill from a message removes the image.
- New Task opens with the cursor in the prompt; the name field is gone (agents name
  workspaces).
- The window reopens where it was left.

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
